import { normalizeOcclusionShape } from '../vision/occlusion-model.js';
import { exportOcclusionConfiguration, normalizeOcclusionConfiguration } from '../world/occlusion-config.js';

const clone = structuredClone;

export function createOcclusionDraft(map, scene) {
  let baseline = exportOcclusionConfiguration(map, scene);
  let snapshots = [clone(baseline)], cursor = 0;
  const selectedFeatures = new Set();
  const current = () => snapshots[cursor];
  const change = mutate => {
    const next = clone(current());
    mutate(next);
    const valid = normalizeOcclusionConfiguration(next, map, scene);
    if (JSON.stringify(valid) === JSON.stringify(current())) return false;
    snapshots = snapshots.slice(0, cursor + 1);
    snapshots.push(valid);
    if (snapshots.length > 80) snapshots.shift();
    cursor = snapshots.length - 1;
    return true;
  };
  return {
    sceneId: String(scene.id),
    get configuration() { return clone(current()); },
    get dirty() { return JSON.stringify(baseline) !== JSON.stringify(current()); },
    get canUndo() { return cursor > 0; },
    get canRedo() { return cursor + 1 < snapshots.length; },
    get selectedFeatureIds() { return [...selectedFeatures]; },
    selectFeature(id, additive = false) {
      if (!additive) selectedFeatures.clear();
      if (additive && selectedFeatures.has(String(id))) selectedFeatures.delete(String(id));
      else selectedFeatures.add(String(id));
    },
    selectFeatures(ids) { selectedFeatures.clear(); for (const id of ids) selectedFeatures.add(String(id)); },
    setFeatureVision(ids, { occluder = 'inherit', blockingHeightMeters = 'inherit' } = {}) {
      return change(config => {
        for (const id of ids) {
          const vision = { ...(config.featureVision[String(id)] || {}) };
          if (occluder === 'inherit') delete vision.occluder;
          else if (occluder !== 'preserve') vision.occluder = occluder === true;
          if (blockingHeightMeters === 'inherit') delete vision.blockingHeightMeters;
          else if (blockingHeightMeters !== 'preserve') vision.blockingHeightMeters = blockingHeightMeters;
          if (Object.keys(vision).length) config.featureVision[String(id)] = vision;
          else delete config.featureVision[String(id)];
        }
      });
    },
    upsertShape(raw) {
      const shape = normalizeOcclusionShape(raw);
      return change(config => {
        const index = config.occlusionShapes.findIndex(item => item.id === shape.id);
        if (index < 0) config.occlusionShapes.push(shape);
        else config.occlusionShapes[index] = shape;
      });
    },
    deleteShape(shapeId) {
      return change(config => {
        const defaults = new Map((map.occlusionShapes || []).map(shape => [String(shape.id), shape]));
        const all = new Map([...defaults, ...config.occlusionShapes.map(shape => [shape.id, shape])]);
        const removed = new Set([String(shapeId)]);
        for (const shape of all.values()) if (shape.hostShapeId === shapeId) removed.add(shape.id);
        config.occlusionShapes = config.occlusionShapes.filter(shape => !removed.has(shape.id));
        for (const id of removed) {
          if (defaults.has(id)) config.occlusionShapes.push({ ...defaults.get(id), enabled: false });
          const shape = all.get(id);
          if (shape && !shape.featureId && !defaults.has(id)) delete config.featureVision[id];
        }
      });
    },
    importConfiguration(raw) {
      const config = normalizeOcclusionConfiguration(raw, map, scene);
      return change(next => Object.assign(next, config));
    },
    resetDefaults() { return change(config => { config.occlusionShapes = clone(map.occlusionShapes || []); config.featureVision = {}; }); },
    undo() { if (cursor > 0) { cursor--; return true; } return false; },
    redo() { if (cursor + 1 < snapshots.length) { cursor++; return true; } return false; },
    commitOperations() {
      return [{ type: 'scene.occlusion.configure', payload: { sceneId: String(scene.id),
        configuration: clone(current()), expectedConfiguration: clone(baseline) } }];
    },
    markCommitted(committedScene) { baseline = exportOcclusionConfiguration(map, committedScene); },
    previewScene(authoritativeScene) {
      const config = current();
      const records = clone(authoritativeScene.featureStates || {});
      for (const record of Object.values(records)) delete record.vision;
      for (const [id, vision] of Object.entries(config.featureVision)) records[id] = { ...records[id], vision: clone(vision) };
      return { ...authoritativeScene, occlusionShapes: clone(config.occlusionShapes), featureStates: records };
    },
  };
}
