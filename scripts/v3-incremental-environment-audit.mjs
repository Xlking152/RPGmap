import { matchesCommittedRuinsFeedback } from './ruins-browser-smoke.mjs';
import { captureHostedCommittedVisionRevision, preserveAuditFailureDuringCleanup,
  serializeAuditError, restoreAuditError } from './hosted-vision-commit.mjs';

/** Supplementary real UI measurements; ordinary browser gates remain unchanged. */
export async function runIncrementalEnvironmentAudit(evaluate) {
  const result = await evaluate(`(async () => {
    try { return { ok: true, value: await (${environmentAudit.toString()})((${captureHostedCommittedVisionRevision.toString()}),(${matchesCommittedRuinsFeedback.toString()}),(${incrementalEnvironmentRestoreOperations.toString()}),(${preserveAuditFailureDuringCleanup.toString()})) }; }
    catch (error) { return { ok: false, error: (${serializeAuditError.toString()})(error) }; }
  })()`, 180_000);
  if (result?.ok !== true) throw restoreAuditError(result?.error || { message: 'Environment audit returned no result' });
  return result.value;
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

async function environmentAudit(captureRevision, matchesFeedback, restoreOperations, withCleanup) {
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
  const samples = [], timing = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] };
  };
  return withCleanup(async () => {
    const started = performance.now();
    const setup = await captureRevision(api, 'v3-audit:setup', () => api.world.performOperations([
      { type: 'token.upsert', payload: { sceneId, token: { ...original.token, ...observation,
        elevationMeters: 0, placement: 'map', featureId: null,
        vision: { ...original.token.vision, enabled: true, preciseRangeOverrideMeters: 1000, vagueRangeOverrideMeters: 1000 } } } },
      { type: 'scene.settings.patch', payload: { sceneId, patch: { lineOfSightEnabled: true } } },
    ], { source: 'v3-audit:setup' }));
    await api.vision.setSource(sourceId); api.map.setView([api.mapPackage.height - observation.y, observation.x], 0, { animate: false });
    await feedback(setup.revision, started);
    api.diagnostics.setEnabled(true); api.diagnostics.reset();
    const measure = async (kind, source, operation) => {
      const before = { renderer: api.getSceneRenderDiagnostics(), geometry: api.getOcclusionGeometryCacheDiagnostics(), pipeline: api.diagnostics.snapshot() };
      const start = performance.now(), committed = await captureRevision(api, source, operation), commitMs = performance.now() - start;
      check(committed.value?.ok !== false, `${kind} operation was rejected`);
      const frame = await feedback(committed.revision, start), feedbackMs = performance.now() - start;
      const placement = api.inspectTokenPlacement(sourceId, observation);
      samples.push({ kind, commitMs, feedbackMs, operationId: committed.operationId,
        serverRevision: committed.serverRevision, revision: committed.revision, renderedRevision: frame.stateRevision,
        requestedAt: frame.requestedAt, observationCollisionValid: placement.valid, before,
        after: { renderer: api.getSceneRenderDiagnostics(), geometry: api.getOcclusionGeometryCacheDiagnostics(), pipeline: api.diagnostics.snapshot() } });
    };
    for (let round = 0; round < 12; round++) {
      for (const action of ['open', 'close']) await measure(action, `v3-audit:${action}`, () => api.world.performOperations([
        { type: 'scene.door.use', payload: { sceneId, featureId: door.id, tokenId: null, action } },
      ], { source: `v3-audit:${action}` }));
      await measure('damage', 'feature:damage', () => api.interaction.damage(house.id));
      await measure('restore', 'feature:restore', () => api.interaction.restore(house.id));
      await measure('undo-restore', 'v3-audit:undo', () => {
        const scene = api.world.getActiveScene();
        return api.world.performOperations([{ type: 'scene.content.replace', payload: { sceneId,
          expectedActiveSceneId: sceneId, expectedSceneEvents: scene.sceneEvents, sceneEvents: scene.sceneEvents.slice(0, -1) } }], { source: 'v3-audit:undo' });
      });
      check(api.interaction.stateForFeature(house.id).destroyed, 'Undo must restore the acknowledged destruction');
      await measure('restore-after-undo', 'feature:restore', () => api.interaction.restore(house.id));
    }
    const report = { passed: true, map: { id: api.mapPackage.id, version: api.mapPackage.version, fingerprint: api.mapPackage.fingerprint },
      sceneId, doorId: door.id, buildingId: house.id, observation, rounds: 12, samples,
      summary: Object.fromEntries([...new Set(samples.map(sample => sample.kind))].map(kind => {
        const records = samples.filter(sample => sample.kind === kind);
        return [kind, { commit: timing(records.map(record => record.commitMs)), feedback: timing(records.map(record => record.feedbackMs)),
          featureVisits: records.map(record => record.after.renderer.lastDamagedFeatureVisits),
          pipeline: records.at(-1).after.pipeline.metrics }];
      })), scope: 'Real Document commits and matching 1000 m displayed masks. Renderer/geometry snapshots and opt-in navigation/Vision calculation counters are cumulative; before/after are provided for exact deltas. No new performance threshold replaces existing browser gates.' };
    return report;
  }, async () => {
    await api.world.performOperations(restoreOperations(original, api.world.getActiveScene()),
      { source: 'v3-audit:cleanup' });
    await api.vision.setSource(original.sourceId); api.map.setView(original.center, original.zoom, { animate: false });
    api.diagnostics.setEnabled(original.diagnosticsEnabled);
  });
}
