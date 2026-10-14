import { createDocumentChanges, documentChangeSet } from '../documents/changes.js';

function identity(state) {
  const world = state?.preferences?.worldV2;
  if (!world || !Array.isArray(world.scenes) || typeof world.id !== 'string' || !world.id
    || typeof world.activeSceneId !== 'string' || !world.activeSceneId) return null;
  const scene = world.scenes.find(item => item?.id === world.activeSceneId);
  const values = [world.id, world.activeSceneId, world.ruleset?.id, world.ruleset?.version,
    scene?.mapPackage?.id, scene?.mapPackage?.version];
  if (!values.every(value => typeof value === 'string' && value.length > 0)
    || !Number.isSafeInteger(world.schemaVersion)) return null;
  return { values, schema: world.schemaVersion };
}

// Changing a vision source changes the recipient's projection, not its Scene.
// Derive real Document changes so filtered entities, private fields and Fog are
// still updated without treating the snapshot as a new game/map import.
export function sourceAudienceSnapshotChanges(beforeState, afterState, {
  reason, loadedMap, loadedRuleset, currentRevision, nextRevision, sceneTransitionPending = false,
} = {}) {
  if (reason !== 'vision.source.set' || sceneTransitionPending
    || !Number.isSafeInteger(currentRevision) || !Number.isSafeInteger(nextRevision)
    || nextRevision < currentRevision) return null;
  const before = identity(beforeState), after = identity(afterState);
  if (!before || !after || before.schema !== after.schema
    || before.values.some((value, index) => value !== after.values[index])
    || after.values[2] !== String(loadedRuleset?.id || '')
    || after.values[3] !== String(loadedRuleset?.version || '')
    || after.values[4] !== String(loadedMap?.id || loadedMap?.mapId || '')
    || after.values[5] !== String(loadedMap?.version || loadedMap?.mapVersion || '')) return null;
  try {
    const changes = createDocumentChanges(beforeState, afterState);
    return { changes, changeSet: documentChangeSet(changes) };
  } catch {
    // An uncertain shape retains the validated, full import path.
    return null;
  }
}
