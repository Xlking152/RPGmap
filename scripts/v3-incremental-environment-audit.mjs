import { matchesCommittedRuinsFeedback } from './ruins-browser-smoke.mjs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createAuditAuthorityReader, auditReplicaExpression, waitForAuditAuthority } from './audit-authority-readiness.mjs';
import { captureHostedCommittedVisionRevision, preserveAuditFailureDuringCleanup,
  serializeAuditError, restoreAuditError } from './hosted-vision-commit.mjs';

const annotate = (error, stage, label, round) => {
  if (!error.auditStage) {
    Object.assign(error, { auditStage: stage, auditLabel: label, auditRound: round });
    error.message = `[${stage}; ${label}${round === null ? '' : `; round ${round + 1}`}] ${error.message}`;
  }
  return error;
};

/** Supplementary real UI measurements; ordinary browser gates remain unchanged. */
export async function runIncrementalEnvironmentAudit(evaluate, { mapDir, expectedMap = null, progressPath = null,
  readAuthority = createAuditAuthorityReader(mapDir), readinessOptions = {} } = {}) {
  const key = `__rpgmapEnvironmentAudit_${randomUUID().replaceAll('-', '')}`;
  let initialized = false, primaryFailure = null;
  const progress = { passed: false, measurementStatus: 'preparing', completedRounds: 0,
    samples: [], readiness: [], steps: [] };
  const save = () => progressPath ? writeFile(progressPath, `${JSON.stringify(progress, null, 2)}\n`, 'utf8') : undefined;
  const browser = async body => {
    const result = await evaluate(`(async () => {
      try { return { ok: true, value: await (async () => { ${body} })() }; }
      catch (error) { return { ok: false, error: (${serializeAuditError.toString()})(error) }; }
    })()`, 30_000);
    if (result?.ok !== true) throw restoreAuditError(result?.error || { message: 'Environment audit returned no result' });
    return result.value;
  };
  const snapshot = async () => {
    if (initialized) Object.assign(progress, await browser(`return globalThis[${JSON.stringify(key)}].report();`));
    await save();
  };
  const ready = async (label, round = null) => {
    Object.assign(progress, { measurementStatus: 'waiting-authority', activeStep: { stage: 'readiness', label, round } });
    await save();
    try {
      const proof = await waitForAuditAuthority({ ...readinessOptions, readAuthority, expectedMap,
        readReplica: () => browser(`return ${auditReplicaExpression};`) });
      progress.readiness.push({ label, round, ...proof });
      await save();
      return proof;
    } catch (error) { throw annotate(error, 'readiness', label, round); }
  };
  const command = async (method, label, round = null, args = []) => {
    const proof = await ready(label, round);
    Object.assign(progress, { measurementStatus: 'running', activeStep: { stage: method, label, round } });
    await save();
    const started = performance.now();
    try {
      const value = await browser(`const session = globalThis[${JSON.stringify(key)}];
        session.assertReady(${JSON.stringify(proof)}); return session[${JSON.stringify(method)}](...${JSON.stringify(args)});`);
      progress.steps.push({ method, label, round, elapsedMs: performance.now() - started,
        readinessRevision: proof.serverRevision, value });
      await snapshot();
      return value;
    } catch (error) {
      progress.steps.push({ method, label, round, elapsedMs: performance.now() - started,
        readinessRevision: proof.serverRevision, failed: true });
      throw annotate(error, method, label, round);
    }
  };
  try {
    const proof = await ready('v3-audit:initialize');
    try {
      await browser(`const session = (${createEnvironmentAuditSession.toString()})
        ((${captureHostedCommittedVisionRevision.toString()}), (${matchesCommittedRuinsFeedback.toString()}),
        (${incrementalEnvironmentRestoreOperations.toString()}));
        session.assertReady(${JSON.stringify(proof)}); globalThis[${JSON.stringify(key)}] = session; return true;`);
      initialized = true;
    } catch (error) { throw annotate(error, 'initialize', 'v3-audit:initialize', null); }
    await snapshot();
    await preserveAuditFailureDuringCleanup(async () => {
      await command('setup', 'v3-audit:setup');
      await command('source', 'v3-audit:source');
      for (let round = 0; round < 12; round++) {
        for (const kind of ['open', 'close', 'damage', 'restore', 'undo-restore', 'restore-after-undo']) {
          await command('measure', `v3-audit:${kind}`, round, [kind, round]);
        }
        progress.completedRounds = round + 1; await save();
      }
    }, async () => {
      const errors = [];
      for (const [method, label] of [['cleanupState', 'v3-audit:cleanup-state'], ['cleanupView', 'v3-audit:cleanup-view']]) {
        try { await command(method, label); } catch (error) { errors.push(error); }
      }
      if (!errors.length) {
        try { await ready('v3-audit:cleanup-complete'); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Multiple environment audit cleanup steps failed');
    });
    await snapshot();
    Object.assign(progress, { passed: true, measurementStatus: 'passed', activeStep: null });
    await save(); return progress;
  } catch (error) {
    if (initialized) {
      try { await snapshot(); }
      catch (snapshotError) { error = new AggregateError([error, annotate(snapshotError, 'snapshot', 'v3-audit:partial', null)],
        'Environment audit failed and partial browser snapshot could not be read'); }
    }
    Object.assign(progress, { passed: false, measurementStatus: 'failed', failure: serializeAuditError(error) });
    await save();
    error.partialAudit = structuredClone(progress);
    primaryFailure = error;
    throw error;
  } finally {
    if (initialized) {
      try { await evaluate(`delete globalThis[${JSON.stringify(key)}]; true`, 10_000); }
      catch (cleanupError) {
        cleanupError = annotate(cleanupError, 'dispose', 'v3-audit:dispose', null);
        const error = primaryFailure ? new AggregateError([primaryFailure, cleanupError],
          'Environment audit failed and its browser session cleanup also failed') : cleanupError;
        Object.assign(progress, { passed: false, measurementStatus: 'failed', failure: serializeAuditError(error) });
        await save(); error.partialAudit = structuredClone(progress); throw error;
      }
    }
  }
}

export function incrementalEnvironmentRestoreOperations(original, scene) {
  const sceneId = original.scene.id, patches = [];
  for (const featureId of new Set([...Object.keys(scene.featureStates || {}), ...Object.keys(original.scene.featureStates || {})])) {
    patches.push({ type: 'scene.featureState.patch', payload: { sceneId, featureId, patch: original.scene.featureStates?.[featureId] || null } });
  }
  return [
    { type: 'scene.content.replace', payload: { sceneId, sceneEvents: original.scene.sceneEvents,
      settings: original.scene.settings } }, ...patches,
    { type: 'token.upsert', payload: { sceneId, token: original.token } },
  ];
}

function createEnvironmentAuditSession(captureRevision, matchesFeedback, restoreOperations) {
  const api = document.querySelector('#app').rpgMapApp;
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const original = { scene: api.world.getActiveScene(), sourceId: api.vision.getSource(),
    diagnosticsEnabled: api.diagnostics.enabled, center: api.map.getCenter(), zoom: api.map.getZoom() };
  const sourceId = original.sourceId || original.scene.tokens.find(token => token.placement === 'map')?.id;
  original.token = api.tokens.get(sourceId); check(original.token, 'Incremental audit requires an existing Token');
  const sceneId = original.scene.id;
  const contextIdentity = () => {
    const world = api.world.get();
    return JSON.stringify([world.id, world.activeSceneId, api.mapPackage.id, api.mapPackage.version,
      api.mapPackage.fingerprint, api.ruleset.id, api.ruleset.version]);
  };
  const expectedContext = contextIdentity();
  const door = api.mapPackage.features.find(feature => feature.interaction?.openable || feature.capabilities?.openable
    || feature.interaction?.actions?.includes?.('open') || feature.type === 'door' || feature.subtype === 'gate');
  check(door, 'Incremental audit requires a map-declared door');
  const center = feature => ({ x: Number(feature.center?.[0]), y: Number(feature.center?.[1]) });
  const doorCenter = center(door);
  const house = api.mapPackage.features.filter(feature => feature.category === 'building'
    && feature.capabilities?.destructible !== false && feature.id !== door.id
    && !api.interaction.stateForFeature(feature.id).destroyed)
    .sort((left, right) => Math.hypot(center(left).x - doorCenter.x, center(left).y - doorCenter.y)
      - Math.hypot(center(right).x - doorCenter.x, center(right).y - doorCenter.y))[0];
  check(house, 'Incremental audit requires an undamaged building');
  let observation = null;
  for (const distance of [5, 15, 30, 60, 120]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const point = { x: doorCenter.x + dx * distance, y: doorCenter.y + dy * distance };
    if (!observation && api.inspectTokenPlacement(sourceId, point).valid) observation = point;
  }
  check(observation, 'No collision-valid door observation position exists');
  const feedback = async (revision, started) => {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      check(contextIdentity() === expectedContext && api.vision.getSource() === sourceId,
        'Incremental audit World/Scene/map/rules/source context changed');
      const frame = api.vision.getFeedbackState();
      if (matchesFeedback(frame, revision, started, observation) && frame.source?.tokenId === sourceId
        && frame.source?.lineOfSightEnabled === true && frame.source?.preciseRangeMeters === 1000
        && frame.source?.vagueRangeMeters === 1000) return frame;
      await wait(8);
    }
    throw new Error('Incremental environment mask did not follow its authority revision');
  };
  let setupCommit = null, setupStarted = null;
  const samples = [], timing = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
  };
  const measure = async (kind, round) => {
    const source = kind === 'damage' ? 'feature:damage' : kind.startsWith('restore') ? 'feature:restore'
      : kind === 'undo-restore' ? 'v3-audit:undo' : `v3-audit:${kind}`;
    const operation = () => {
      if (['open', 'close'].includes(kind)) return api.world.performOperations([
        { type: 'scene.door.use', payload: { sceneId, featureId: door.id, tokenId: null, action: kind } },
      ], { source });
      if (kind === 'damage') return api.interaction.damage(house.id);
      if (kind.startsWith('restore')) return api.interaction.restore(house.id);
      if (kind === 'undo-restore') {
        const scene = api.world.getActiveScene();
        return api.world.performOperations([{ type: 'scene.content.replace', payload: { sceneId,
          expectedActiveSceneId: sceneId, expectedSceneEvents: scene.sceneEvents, sceneEvents: scene.sceneEvents.slice(0, -1) } }], { source });
      }
      throw new Error(`Unknown audit measurement ${kind}`);
    };
    const before = { renderer: api.getSceneRenderDiagnostics(), geometry: api.getOcclusionGeometryCacheDiagnostics(), pipeline: api.diagnostics.snapshot() };
    const start = performance.now(), committed = await captureRevision(api, source, operation), commitMs = performance.now() - start;
    check(committed.value?.ok !== false, `${kind} operation was rejected`);
    const sample = { kind, round, status: 'awaiting-feedback', commitMs, operationId: committed.operationId,
      serverRevision: committed.serverRevision, revision: committed.revision, before };
    samples.push(sample);
    const frame = await feedback(committed.revision, start);
    if (kind === 'undo-restore') check(api.interaction.stateForFeature(house.id).destroyed,
      'Undo must restore the acknowledged destruction');
    Object.assign(sample, { status: 'complete', feedbackMs: performance.now() - start, renderedRevision: frame.stateRevision,
      requestedAt: frame.requestedAt, observationCollisionValid: api.inspectTokenPlacement(sourceId, observation).valid,
      after: { renderer: api.getSceneRenderDiagnostics(), geometry: api.getOcclusionGeometryCacheDiagnostics(), pipeline: api.diagnostics.snapshot() } });
    return { operationId: sample.operationId, serverRevision: sample.serverRevision, revision: sample.revision };
  };
  return {
    assertReady(proof) {
      const status = api.multiplayer.getStatus();
      check(status.connected === true && status.resuming === false && status.applyingRemote === false
        && status.pendingOperationCount === 0 && status.session?.role === 'gm'
        && status.revision === proof.serverRevision && api.world.get().id === proof.worldId
        && api.world.get().activeSceneId === proof.sceneId && contextIdentity() === expectedContext
        && api.vision.getSource() === proof.sourceId, 'Audit replica changed after its authority readiness proof');
    },
    async setup() {
    const started = performance.now();
    const setup = await captureRevision(api, 'v3-audit:setup', () => api.world.performOperations([
      { type: 'token.upsert', payload: { sceneId, token: { ...original.token, ...observation,
        elevationMeters: 0, placement: 'map', featureId: null,
        vision: { ...original.token.vision, enabled: true, preciseRangeOverrideMeters: 1000, vagueRangeOverrideMeters: 1000 } } } },
      { type: 'scene.settings.patch', payload: { sceneId, patch: { lineOfSightEnabled: true } } },
    ], { source: 'v3-audit:setup' }));
    setupCommit = setup; setupStarted = started;
    return { operationId: setup.operationId, serverRevision: setup.serverRevision, revision: setup.revision };
    },
    async source() {
      await api.vision.setSource(sourceId); api.map.setView([api.mapPackage.height - observation.y, observation.x], 0, { animate: false });
      await feedback(setupCommit.revision, setupStarted);
      api.diagnostics.setEnabled(true); api.diagnostics.reset();
      return { tokenId: sourceId, requestedAt: setupStarted, revision: setupCommit.revision };
    },
    measure,
    report() {
    const complete = samples.filter(sample => sample.status === 'complete');
    return { map: { id: api.mapPackage.id, version: api.mapPackage.version, fingerprint: api.mapPackage.fingerprint },
      sceneId, doorId: door.id, buildingId: house.id, observation, rounds: 12, samples,
      summary: Object.fromEntries([...new Set(samples.map(sample => sample.kind))].map(kind => {
        const records = complete.filter(sample => sample.kind === kind);
        if (!records.length) return [kind, { complete: 0 }];
        return [kind, { commit: timing(records.map(record => record.commitMs)), feedback: timing(records.map(record => record.feedbackMs)),
          featureVisits: records.map(record => record.after.renderer.lastDamagedFeatureVisits),
          pipeline: records.at(-1).after.pipeline.metrics }];
      })), scope: 'Real Document commits and matching 1000 m displayed masks, after separately timed read-only durable job drain and exact GM replica readiness before each write. All 7 browsers and existing vision sources remain connected. Renderer/geometry snapshots and opt-in navigation/Vision calculation counters are cumulative; before/after are provided for exact deltas. No operation retries or new performance threshold replaces existing browser gates.' };
    },
    async cleanupState() {
    await api.world.performOperations(restoreOperations(original, api.world.getActiveScene()),
      { source: 'v3-audit:cleanup' });
    return { restored: true };
    },
    async cleanupView() {
    await api.vision.setSource(original.sourceId); api.map.setView(original.center, original.zoom, { animate: false });
    api.diagnostics.setEnabled(original.diagnosticsEnabled);
    return { restored: true };
    },
  };
}
