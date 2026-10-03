import { prepareFogOperation } from '../world/operations.js';
import { mergeActorDelta } from '../token/actor.js';
import { sceneVisionContext } from './context.js';
import { sphereGroundRadiusMeters } from '../spatial/kernel.js';

const worldOf = state => state?.preferences?.worldV2;
const sceneOf = (state, sceneId) => worldOf(state)?.scenes?.find(scene => String(scene.id) === String(sceneId));
const movementTypes = new Set(['token.move', 'token.movePath', 'token.reposition']);
const invalidatingTypes = new Set(['scene.fog.reset', 'scene.fog.hide', 'scene.reset', 'scene.delete', 'scene.upsert']);
const pointOf = token => ({ x: Number(token.x), y: Number(token.y), elevationMeters: Number(token.elevationMeters) || 0 });
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.elevationMeters === b.elevationMeters;

export function describeExplorationSource(state, tokenId, { sceneId = worldOf(state)?.activeSceneId, ruleset, describeVision } = {}) {
  const scene = sceneOf(state, sceneId), world = worldOf(state);
  const token = scene?.tokens?.find(item => String(item.id) === String(tokenId));
  const actor = token && world?.actors?.find(item => String(item.id) === String(token.actorId));
  if (!token || !actor || token.placement !== 'map' || token.vision?.enabled === false) return null;
  const resolved = token.actorLink === false ? mergeActorDelta(actor, token.actorDelta) : actor;
  const described = (describeVision || ruleset?.vision?.describe)?.(resolved, { token, scene, lighting: 'normal' }) || {};
  const legacy = token.vision?.rangeOverrideMeters;
  const precise = token.vision?.preciseRangeOverrideMeters ?? legacy;
  const vague = token.vision?.vagueRangeOverrideMeters ?? legacy;
  const rangeMeters = precise == null ? Number(described.preciseRangeMeters ?? described.rangeMeters) || 0 : Number(precise) || 0;
  const vagueRangeMeters = vague == null ? Math.max(rangeMeters, Number(described.vagueRangeMeters ?? rangeMeters) || 0)
    : Math.max(rangeMeters, Number(vague) || 0);
  if (vagueRangeMeters <= 0) return null;
  return { sceneId: String(scene.id), tokenId: String(token.id), actorId: String(actor.id),
    partyId: actor.partyId == null ? null : String(actor.partyId), ...pointOf(token),
    rangeMeters, preciseRangeMeters: rangeMeters, vagueRangeMeters,
    preciseGroundRangeMeters: sphereGroundRadiusMeters(rangeMeters, token.elevationMeters) ?? 0,
    vagueGroundRangeMeters: sphereGroundRadiusMeters(vagueRangeMeters, token.elevationMeters) ?? 0,
    senses: structuredClone(described.senses || {}), lighting: scene.settings?.lighting || 'normal', lineOfSightEnabled: true };
}

function perceptionKey(vision) {
  return JSON.stringify(vision && [vision.partyId, vision.rangeMeters, vision.vagueRangeMeters,
    vision.elevationMeters, vision.senses]);
}

function statusHasPerceptionEffect(operation, state, previous, source) {
  if (!source || !operation.type.startsWith('status.')) return false;
  const definitions = new Map([...(previous || []), ...(worldOf(state)?.statusDefinitions || [])]
    .map(definition => [String(definition.id), definition]));
  const payloads = operation.type === 'status.batch' ? operation.payload.operations || [] : [operation.payload];
  if (operation.type.includes('.definition.')) {
    return [...definitions.values()].some(definition => Object.keys(definition.capabilities || {})
      .some(key => /vision|sight|sense|detection|perception/i.test(key)));
  }
  return payloads.some(payload => {
    const target = payload.target || payload;
    if (String(target.targetId || target.id || '') !== String(target.scope === 'actor' ? source.actorId : source.tokenId)) return false;
    const definition = definitions.get(String(payload.statusId || payload.definitionId || ''));
    return Object.keys(definition?.capabilities || {}).some(key => /vision|sight|sense|detection|perception/i.test(key));
  });
}

// Reducer callbacks synchronously capture derived inputs at each successful
// operation. No World snapshot is retained, and no queue is changed until the
// caller validates the entire transaction and applies these ordered events.
export function createExplorationOperationCapture({ sourceIds = [], ruleset, mapForScene, describeVision } = {}) {
  const watched = new Set([...sourceIds].map(String)), events = [];
  const describe = (state, tokenId, sceneId) => describeExplorationSource(state, tokenId, { ruleset, sceneId, describeVision });
  const append = (state, source, path) => {
    if (!source?.partyId || !path.length) return;
    const scene = sceneOf(state, source.sceneId), map = mapForScene?.(scene);
    if (!scene || !map) return;
    const points = path.map(pointOf);
    const inputs = [];
    for (let index = points.length === 1 ? 0 : 1; index < points.length; index++) {
      const payload = { sceneId: source.sceneId, partyId: source.partyId, visionSourceTokenId: source.tokenId,
        radiusMeters: source.vagueRangeMeters, ...(index ? { from: points[index - 1], to: points[index] } : points[index]) };
      inputs.push({ ...prepareFogOperation(state, { type: 'scene.fog.explore', payload }, { ruleset, mapPackage: map,
        // A supplied trusted describer has already resolved this exact source
        // against the operation's state. Fog preparation needs its senses,
        // while radii come from the explicit accepted payload. Reuse that
        // result rather than normalizing/deriving the same Actor again.
        ...(describeVision ? { describeVision: () => source } : {}) }).input,
        sourceRangeMeters: source.vagueRangeMeters });
    }
    if (!inputs.length) return;
    const spatial = sceneVisionContext(map, scene);
    events.push({ type: 'explore', sceneId: source.sceneId, partyId: source.partyId, tokenId: source.tokenId,
      vision: source, path: points, inputs,
      context: { map: { id: map.id, version: map.version, width: map.width, height: map.height, metersPerUnit: map.metersPerUnit || 1 },
        occluders: spatial.occluders.map(occluder => ({ ...occluder,
          blockingHeightMeters: Number.isFinite(occluder.blockingHeightMeters) ? occluder.blockingHeightMeters : null })),
        lights: spatial.lights, ambient: scene.settings?.lighting || 'normal' } });
  };
  return {
    events,
    prepareOperation({ state, operation }) {
      const sceneId = String(operation.payload?.sceneId || operation.payload?.scene?.id || worldOf(state)?.activeSceneId || '');
      const scene = sceneOf(state, sceneId);
      const positions = movementTypes.has(operation.type) || operation.type === 'token.upsert'
        ? new Map((scene?.tokens || []).filter(token => watched.has(String(token.id))).map(token => [String(token.id), token])) : null;
      const status = operation.type.startsWith('status.');
      return { sceneId, positions, definitions: status ? worldOf(state)?.statusDefinitions : null,
        perceptions: status ? new Map([...watched].map(tokenId => [tokenId, describe(state, tokenId, worldOf(state)?.activeSceneId)])) : null };
    },
    onOperationApplied({ state, operation, results, prepared }) {
      const sceneId = prepared.sceneId;
      if (invalidatingTypes.has(operation.type)) events.push({ type: 'cancel', sceneId,
        partyId: operation.type.startsWith('scene.fog.') ? String(operation.payload.partyId) : null });
      if (movementTypes.has(operation.type) || operation.type === 'token.upsert') {
        const result = results.find(item => movementTypes.has(item.action)) || {};
        const motions = result.motion || [{ tokenId: result.tokenId || operation.payload?.token?.id }];
        for (const motion of motions) {
          const tokenId = String(motion.tokenId || '');
          if (!watched.has(tokenId)) continue;
          const source = describe(state, tokenId, sceneId), old = prepared.positions?.get(tokenId);
          if (!source) continue;
          const continuous = movementTypes.has(operation.type) && operation.type !== 'token.reposition'
            && old?.placement === 'map';
          const path = continuous ? [motion.from || old, ...(motion.waypoints || [motion.to || source])] : [source];
          if (continuous && motion.to && !samePoint(pointOf(path.at(-1)), pointOf(motion.to))) path.push(motion.to);
          if (operation.type === 'token.upsert' && old?.placement === 'map'
            && samePoint(pointOf(old), pointOf(source))) continue;
          append(state, source, path);
        }
      }
      const status = operation.type.startsWith('status.');
      const refresh = !movementTypes.has(operation.type) && (/^scene\.(?:door|occlusion|featureState|content|settings)/.test(operation.type)
        || /^token\.(?:access|actorDelta|light)/.test(operation.type) || /^actor\./.test(operation.type));
      if (refresh || status) for (const tokenId of watched) {
        const source = describe(state, tokenId, worldOf(state)?.activeSceneId);
        if (refresh || perceptionKey(prepared.perceptions?.get(tokenId)) !== perceptionKey(source)
          || statusHasPerceptionEffect(operation, state, prepared.definitions, source)) append(state, source, [source]);
      }
    },
  };
}
