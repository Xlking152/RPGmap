import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { describeExplorationSource } from '../vision/exploration-operations.js';
import { sceneVisionContext, sceneExplorationContext } from '../vision/context.js';
import { deriveSceneState } from '../engine/state.js';
import { normalizeOcclusionShapes } from '../vision/occlusion-model.js';
import { assertOcclusionReferences } from '../world/occlusion-config.js';
import { assertFeatureVision } from '../world/feature-states.js';
import {
  deriveVisionOccluders,
  deriveSceneLightSources,
  isPathPreciselyVisible,
  visionIgnoresOcclusion,
} from '../spatial/kernel.js';

export { canUserControlToken, projectStateForAudience, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, targetedProjectionCollectionChanges, projectionCollectionChanges } from '../vision/audience.js';
export { sphereGroundRadiusMeters } from '../spatial/kernel.js';
export { sceneVisionContext, sceneExplorationContext };
export { mergeExploration } from '../vision/fog.js';
export { computeExplorationChunk, mergeExplorationChunkFog } from './exploration-compute.js';
export { createExplorationOperationCapture } from '../vision/exploration-operations.js';
export { createServerMovementAdjudicationActorResolver } from './movement-adjudication.js';

export const serverRuleset = infiniteHorrorRuleset;
const canonicalVisionDescriptions = new WeakMap();

// The bundled ruleset's normal-light detection derives only from Actor data
// and Actor effects. Permission decisions and Token status precision are still
// evaluated independently for each audience. Mutable/reduced Actors are never
// memoized, and independent Actor deltas keep their existing fresh resolution.
export function describeServerVision(actor, context = {}) {
  if (!actor || !Object.isFrozen(actor) || context.effects !== undefined || context.lighting !== 'normal') {
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
