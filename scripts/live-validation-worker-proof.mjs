const validationAsset = /\/assets\/world-validation-worker-[^/]+\.js$/;

/** Flat CDP sessions route on the envelope, never inside command params. */
export function cdpCommandEnvelope(id, method, params, sessionId) {
  return { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
}

async function workerLocation(send, target) {
  if (typeof target.targetId !== 'string' || !target.targetId) throw new Error('Live Worker target is missing its ID');
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached?.sessionId;
  let readError;
  try {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error(`Worker ${target.targetId} did not return a CDP session`);
    const evaluated = await send('Runtime.evaluate', { expression: 'self.location.href', returnByValue: true }, 5000, sessionId);
    if (evaluated?.exceptionDetails) throw new Error(`Worker ${target.targetId} location evaluation failed: `
      + (evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || 'Runtime exception'));
    if (evaluated?.result?.type !== 'string' || typeof evaluated.result.value !== 'string' || !evaluated.result.value) {
      throw new Error(`Worker ${target.targetId} did not return its actual location`);
    }
    return evaluated.result.value;
  } catch (error) {
    readError = error;
    throw error;
  } finally {
    try {
      await send('Target.detachFromTarget', typeof sessionId === 'string' && sessionId
        ? { sessionId } : { targetId: target.targetId });
    } catch (error) {
      if (readError) throw new AggregateError([readError, error], `${readError.message}; Worker detach failed: ${error.message}`);
      throw error;
    }
  }
}

/** Enumerate live targets after measurement; resource loading is not liveness evidence. */
export async function proveLiveValidationWorker(send) {
  let proofError;
  let targetInfos;
  let currentTarget;
  const failureWithTargets = error => {
    const message = `${error.message}; liveWorkerProofContext=${JSON.stringify({
      targetInfos: targetInfos ?? null, currentTarget: currentTarget ?? null,
    })}`;
    return error instanceof AggregateError ? new AggregateError(error.errors, message, { cause: error })
      : new Error(message, { cause: error });
  };
  try {
    // Attach existing workers after measurement without pausing or starting their execution.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    ({ targetInfos } = await send('Target.getTargets'));
    if (!Array.isArray(targetInfos)) throw new Error('Chrome did not return its live Worker targets');
    const workers = [];
    let frozenOrInactiveCount = 0;
    for (const target of targetInfos) {
      currentTarget = target;
      if (target.type !== 'worker') continue;
      if (typeof target.attached !== 'boolean') throw new Error(`Worker ${target.targetId} is missing its attachment state`);
      // BFCache documents retain unattached targets; do not wake their frozen workers.
      if (!target.attached) { frozenOrInactiveCount++; continue; }
      if (typeof target.url !== 'string') throw new Error(`Worker ${target.targetId} is missing its target URL`);
      workers.push({ targetId: target.targetId, url: await workerLocation(send, target) });
    }
    currentTarget = null;
    const matching = workers.filter(target => validationAsset.test(target.url));
    if (matching.length !== 1) throw new Error('Packaged full-save validation must retain one live Module Worker: '
      + JSON.stringify(workers));
    return { started: true, liveCount: matching.length, asset: new URL(matching[0].url).pathname,
      scope: 'active-document', runtimeLocationVerified: true, frozenOrInactiveCount };
  } catch (error) {
    proofError = failureWithTargets(error);
    throw proofError;
  } finally {
    try {
      await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    } catch (error) {
      if (proofError) throw new AggregateError([proofError, error], `${proofError.message}; Worker auto-attach cleanup failed: ${error.message}`);
      throw failureWithTargets(error);
    }
  }
}
