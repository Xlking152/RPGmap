// Keep this helper self-contained: the browser audit executes its exact source.
// Server revisions and the host's render revisions are separate counters.
export async function captureHostedCommittedVisionRevision(api, label, operation) {
  const identity = () => {
    const world = api.world.get(), scene = world.scenes.find(item => item.id === world.activeSceneId);
    return JSON.stringify([world.id, scene?.id, scene?.mapPackage?.id, scene?.mapPackage?.version,
      scene?.mapPackage?.fingerprint, world.ruleset?.id, world.ruleset?.version,
      api.mapPackage.id, api.mapPackage.version, api.mapPackage.fingerprint,
      api.ruleset.id, api.ruleset.version, api.vision.getSource()]);
  };
  const expectedIdentity = identity(), pending = new Set(), completed = new Map(), documents = new Map(), patches = [];
  const off = [];
  const retain = (name, listener) => off.push(api.on(name, event => listener(event.detail)));
  retain('world:operation-pending', detail => pending.add(String(detail.operationId || '')));
  retain('world:operation-result', detail => completed.set(String(detail.operationId || ''), detail));
  for (const kind of ['create', 'update', 'delete']) retain(`document:${kind}`, detail => {
    if (!detail.operationId || !Number.isSafeInteger(detail.revision)) return;
    const id = String(detail.operationId), records = documents.get(id) || [];
    records.push({ serverRevision: detail.revision, revision: api.getStateRevision(), identity: identity() });
    documents.set(id, records);
  });
  retain('state:patch', detail => {
    if (Number.isSafeInteger(detail.revision)) patches.push({ serverRevision: detail.revision,
      revision: api.getStateRevision(), source: detail.source });
  });
  try {
    const value = await operation();
    const id = String(value?.operationId || (pending.size === 1 ? [...pending][0] : ''));
    const completion = completed.get(id), records = documents.get(id) || [], commit = records[0];
    const valid = value?.ok !== false && pending.size === 1 && pending.has(id) && completion?.ok === true
      && commit && Number.isSafeInteger(commit.revision)
      && records.every(record => record.revision === commit.revision && record.serverRevision === commit.serverRevision
        && record.identity === expectedIdentity)
      && patches.some(patch => patch.serverRevision === commit.serverRevision && patch.revision === commit.revision
        && patch.source === 'document.batch')
      && (!value?.operationId || Number(value.revision) === commit.serverRevision)
      && identity() === expectedIdentity;
    if (!valid) throw Object.assign(new Error(`No acknowledged authoritative Document commit observed for ${label}`),
      { code: 'audit_commit_unproven' });
    return { value, operationId: id, serverRevision: commit.serverRevision, revision: commit.revision };
  } catch (error) {
    error.auditCommit = { label, pendingOperationIds: [...pending],
      completions: [...completed.values()].map(detail => ({ operationId: detail.operationId,
        ok: detail.ok, revision: detail.revision, error: detail.error })),
      documents: [...documents].map(([operationId, records]) => ({ operationId,
        records: records.map(record => ({ serverRevision: record.serverRevision, revision: record.revision })) })),
      patches };
    throw error;
  } finally { for (const dispose of off) if (typeof dispose === 'function') dispose(); }
}

export async function preserveAuditFailureDuringCleanup(operation, cleanup) {
  let primaryError = null;
  try { return await operation(); }
  catch (error) { primaryError = error; throw error; }
  finally {
    try { await cleanup(); }
    catch (cleanupError) {
      if (primaryError) throw new AggregateError([primaryError, cleanupError],
        `Environment audit failed: ${primaryError.message}; cleanup also failed: ${cleanupError.message}`);
      throw cleanupError;
    }
  }
}

export function serializeAuditError(error, depth = 0) {
  return { message: error?.message || String(error), code: error?.code || null, stack: error?.stack || null,
    ...Object.fromEntries(['auditStage', 'auditLabel', 'auditRound', 'auditCommit', 'readiness', 'partialAudit']
      .filter(key => error?.[key] !== undefined).map(key => [key, error[key]])),
    ...(Array.isArray(error?.errors) && depth < 4
      ? { errors: error.errors.map(child => serializeAuditError(child, depth + 1)) } : {}) };
}

export function restoreAuditError(detail) {
  const error = Array.isArray(detail.errors)
    ? new AggregateError(detail.errors.map(restoreAuditError), detail.message) : new Error(detail.message);
  if (detail.code) error.code = detail.code;
  if (detail.stack) error.stack = detail.stack;
  for (const key of ['auditStage', 'auditLabel', 'auditRound', 'auditCommit', 'readiness', 'partialAudit']) {
    if (detail[key] !== undefined) error[key] = detail[key];
  }
  return error;
}
