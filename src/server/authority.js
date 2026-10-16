import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { describeExplorationSource } from '../vision/exploration-operations.js';
import { sceneVisionContext, sceneExplorationContext } from '../vision/context.js';
import { deriveSceneState } from '../engine/state.js';
import { normalizeOcclusionShapes } from '../vision/occlusion-model.js';
import { assertOcclusionReferences } from '../world/occlusion-config.js';
import { assertFeatureVision } from '../world/feature-states.js';
import { isImmutableVisionData } from '../vision/immutable-data.js';
import {
  deriveVisionOccluders,
  deriveSceneLightSources,
  isPathPreciselyVisible,
  visionIgnoresOcclusion,
} from '../spatial/kernel.js';

export { canUserControlToken, projectStateForAudience, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, targetedProjectionCollectionChanges, projectionCollectionChanges, canonicalMovementCollectionChanges } from '../vision/audience.js';
export { sphereGroundRadiusMeters } from '../spatial/kernel.js';
export { sceneVisionContext, sceneExplorationContext };
export { mergeExploration } from '../vision/fog.js';
export { computeExplorationChunk, mergeExplorationChunkFog, createCanonicalExplorationFogMerger } from './exploration-compute.js';
export { createExplorationOperationCapture } from '../vision/exploration-operations.js';
export { createServerMovementAdjudicationActorResolver } from './movement-adjudication.js';

export let serverRuleset = infiniteHorrorRuleset;
let canonicalVisionDescriptions = new WeakMap();
let actorOnlyServerVision = hasBundledActorVision(serverRuleset);

export function configureServerRuleset(ruleset) {
  if (!ruleset?.id || !ruleset?.version || !ruleset?.vision?.describe) throw new TypeError('Invalid server Ruleset');
  serverRuleset = ruleset;
  actorOnlyServerVision = hasBundledActorVision(ruleset);
  canonicalVisionDescriptions = new WeakMap();
}

function hasBundledActorVision(ruleset) {
  const field = (value, key) => value && Object.isFrozen(value)
    ? Object.getOwnPropertyDescriptor(value, key)?.value : null;
  return field(ruleset, 'id') === infiniteHorrorRuleset.id
    && field(ruleset, 'version') === infiniteHorrorRuleset.version
    && field(field(ruleset, 'vision'), 'describe') === infiniteHorrorRuleset.vision.describe;
}

// Only the fixed bundled hook derives normal-light detection solely from Actor
// data and Actor effects. Other rules receive their complete original context
// on every call. Re-preparing the built-in package preserves its hook identity;
// the Actor's whole data graph must also be immutable before memoizing it.
export function describeServerVision(actor, context = {}) {
  if (!actorOnlyServerVision || !actor || context.effects !== undefined
    || context.lighting !== 'normal' || !isImmutableVisionData(actor)) {
    return serverRuleset.vision.describe(actor, context);
  }
  let description = canonicalVisionDescriptions.get(actor);
  if (!description) {
    description = serverRuleset.vision.describe(actor, { lighting: 'normal' });
    canonicalVisionDescriptions.set(actor, description);
  }
  return description;
}

export function validateSceneOcclusion(scene, map = {}) {
  const shapes = normalizeOcclusionShapes(scene.occlusionShapes, { map });
  assertOcclusionReferences(shapes, map, scene);
  const known = new Set([...(map.features || []).map(feature => String(feature.id)),
    ...(map.occlusionShapes || []).map(shape => String(shape.featureId || shape.id)),
    ...shapes.map(shape => String(shape.featureId || shape.id))]);
  for (const [featureId, record] of Object.entries(scene.featureStates || {})) {
    if (!record?.vision) continue;
    assertFeatureVision(record.vision);
    if (Array.isArray(map.features) && !known.has(featureId)) throw Object.assign(new Error('Vision override references a missing Feature'), { code: 'invalid_reference' });
  }
  return scene;
}

export function motionPathPreciselyVisible({ motion, vision, mapPackage, scene } = {}) {
  if (String(motion?.tokenId || '') === String(vision?.tokenId || '')) {
    return Number(vision?.preciseRangeMeters ?? vision?.rangeMeters) > 0;
  }
  const points = [motion?.from, ...(motion?.waypoints || []), motion?.to].filter(Boolean);
  const lineOfSightEnabled = vision?.lineOfSightEnabled !== false && !visionIgnoresOcclusion(vision);
  const spatial = mapPackage ? sceneVisionContext(mapPackage, scene) : null;
  // Shared geometry still clips light when the observer has X-ray vision.
  const occluders = spatial?.occluders || deriveVisionOccluders(mapPackage, scene, deriveSceneState(scene?.sceneEvents || []));
  return isPathPreciselyVisible(points, vision, {
    metersPerUnit: mapPackage?.metersPerUnit || 1,
    lineOfSightEnabled,
    occluders,
    lights: spatial?.lights || deriveSceneLightSources(mapPackage, scene),
    ambient: scene?.settings?.lighting || 'normal',
  });
}

export function describeVisionForToken(state, tokenId) {
  return describeExplorationSource(state, tokenId, { ruleset: serverRuleset, describeVision: describeServerVision });
}
