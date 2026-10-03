import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationOperationCapture } from '../src/vision/exploration-operations.js';
import { applyWorldOperations, prepareFogOperation } from '../src/world/operations.js';
import { computeFogExploration } from '../src/vision/fog.js';

const map = { id: 'capture-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const ruleset = { vision: { describe: actor => ({ rangeMeters: 120, vagueRangeMeters: 120,
  senses: actor.effects.some(effect => effect.definitionId === 'xray') ? { xrayVision: true } : {} }) } };
function fixture() {
  const actor = { id: 'actor', name: 'Scout', type: 'pc', partyId: 'party', effects: [] };
  const token = { id: 'source', actorId: actor.id, actorLink: true, placement: 'map', x: 50, y: 50,
    elevationMeters: 0, vision: { enabled: true }, effects: [] };
  const scene = { id: 'scene', mapPackage: { id: map.id, version: map.version }, tokens: [token],
    settings: { lighting: 'normal' }, sceneEvents: [], featureStates: {},
    occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[100, 0], [110, 0], [110, 300], [100, 300]] },
      { id: 'door', kind: 'door', hostShapeId: 'wall', points: [[99, 40], [111, 40], [111, 60], [99, 60]] }] };
  return { preferences: { worldV2: { schemaVersion: 4, activeSceneId: scene.id, actors: [actor], scenes: [scene], statusDefinitions: [
    { id: 'xray', capabilities: { xrayVision: true } }, { id: 'injured', capabilities: {} } ] } } };
}
const capture = () => createExplorationOperationCapture({ sourceIds: ['source'], ruleset, mapForScene: () => map });
function step(events, state, operation, mutate, results = []) {
  const prepared = events.prepareOperation({ state, operation });
  mutate?.(state);
  events.onOperationApplied({ state, operation, prepared, results });
}

test('mixed movement and door changes capture geometry at each accepted operation', () => {
  const state = fixture(), events = capture(), scene = state.preferences.worldV2.scenes[0];
  step(events, state, { type: 'scene.door.use', payload: { sceneId: 'scene', featureId: 'door' } },
    () => { scene.featureStates.door = { open: true }; });
  step(events, state, { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } },
    () => { scene.tokens = [{ ...scene.tokens[0], x: 80 }]; }, [{ action: 'token.move', tokenId: 'source' }]);
  const move = events.events.find(event => event.path?.length === 2);
  assert.deepEqual(move.path.map(point => point.x), [50, 80]);
  step(events, state, { type: 'scene.door.use', payload: { sceneId: 'scene', featureId: 'door' } },
    () => { scene.featureStates.door = { open: false }; });
  const closed = events.events.at(-1);
  assert.notDeepEqual(move.context.occluders, closed.context.occluders);
  assert.deepEqual(move.inputs[0].payload.from, { x: 50, y: 50, elevationMeters: 0 });
  assert.equal(move.context.occluders[0].polygons[0].length > 0, true);
});

test('perception status changes explore their current circle without invalidating earlier paths', () => {
  const state = fixture(), events = capture();
  step(events, state, { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } },
    () => { state.preferences.worldV2.scenes[0].tokens = [{ ...state.preferences.worldV2.scenes[0].tokens[0], x: 80 }]; },
    [{ action: 'token.move', tokenId: 'source' }]);
  step(events, state, { type: 'status.apply', payload: { scope: 'actor', targetId: 'actor', statusId: 'xray' } },
    () => { state.preferences.worldV2.actors = [{ ...state.preferences.worldV2.actors[0], effects: [{ definitionId: 'xray' }] }]; });
  assert.equal(events.events.length, 2);
  assert.equal(events.events[0].inputs[0].lineOfSightEnabled, true);
  assert.equal(events.events[1].inputs[0].lineOfSightEnabled, false);
  step(events, state, { type: 'status.apply', payload: { scope: 'actor', targetId: 'actor', statusId: 'injured' } },
    () => { state.preferences.worldV2.actors = [{ ...state.preferences.worldV2.actors[0], effects: [
      ...state.preferences.worldV2.actors[0].effects, { definitionId: 'injured' }] }]; });
  assert.equal(events.events.length, 2);
});

test('reset events preserve order and endpoint-only moves do not fabricate a route', () => {
  const state = fixture(), events = capture(), scene = state.preferences.worldV2.scenes[0];
  step(events, state, { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } },
    () => { scene.tokens = [{ ...scene.tokens[0], x: 80 }]; }, [{ action: 'token.move', tokenId: 'source' }]);
  step(events, state, { type: 'scene.fog.reset', payload: { sceneId: 'scene', partyId: 'party' } });
  step(events, state, { type: 'token.reposition', payload: { sceneId: 'scene', tokenId: 'source', x: 200, y: 50 } },
    () => { scene.tokens = [{ ...scene.tokens[0], x: 200 }]; }, [{ action: 'token.reposition', tokenId: 'source' }]);
  assert.deepEqual(events.events.map(event => event.type), ['explore', 'cancel', 'explore']);
  assert.equal(events.events.at(-1).path.length, 1);
  assert.equal(events.events.at(-1).inputs[0].payload.x, 200);
});

test('captured climb and descent use each sample height to bound ground exploration', () => {
  const state = fixture(), scene = state.preferences.worldV2.scenes[0];
  scene.occlusionShapes = [];
  scene.tokens = [{ ...scene.tokens[0], x: 10, y: 10, elevationMeters: 0 }];
  const shortRuleset = { vision: { describe: () => ({ rangeMeters: 20, vagueRangeMeters: 20, senses: {} }) } };
  const events = createExplorationOperationCapture({ sourceIds: ['source'], ruleset: shortRuleset,
    mapForScene: () => map });
  const operation = { type: 'token.movePath', payload: { sceneId: 'scene', tokenIds: ['source'] } };
  const prepared = events.prepareOperation({ state, operation });
  scene.tokens = [{ ...scene.tokens[0], x: 70 }];
  const from = { x: 10, y: 10, elevationMeters: 0 };
  const apex = { x: 40, y: 10, elevationMeters: 18 };
  const to = { x: 70, y: 10, elevationMeters: 0 };
  events.onOperationApplied({ state, operation, prepared, results: [{ action: 'token.movePath', motion: [
    { tokenId: 'source', from, to, waypoints: [apex, to] },
  ] }] });
  const inputs = events.events[0].inputs;
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(input => input.sourceRangeMeters === 20));
  let fog = {};
  for (const input of inputs) fog = computeFogExploration(input, fog);
  const explored = (row, column) => (fog.exploredByParty.party.rows[String(row)] || [])
    .some(([start, end]) => start <= column && end >= column);
  assert.equal(explored(3, 8), true, 'nearby cells remain explored along the climb');
  assert.equal(explored(5, 8), false, 'the climb does not explore a cell beyond its ground radius');
  let legacy = {};
  for (const input of inputs) legacy = computeFogExploration({ ...input, sourceRangeMeters: undefined }, legacy);
  assert.equal((legacy.exploredByParty.party.rows['5'] || [])
    .some(([start, end]) => start <= 8 && end >= 8), true, 'the former fixed 20m radius over-explored this cell');
});

test('the shared reducer captures successful operation contexts and failed batches have no queue side effects', () => {
  const state = fixture(), events = capture();
  const result = applyWorldOperations(state, [
    { type: 'scene.featureState.patch', payload: { sceneId: 'scene', featureId: 'door', patch: { open: true } } },
    { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } },
    { type: 'scene.featureState.patch', payload: { sceneId: 'scene', featureId: 'door', patch: { open: false } } },
  ], { ruleset, mapPackage: map, ...events });
  assert.equal(result.state.preferences.worldV2.scenes[0].featureStates.door.open, false);
  const movement = events.events.find(event => event.path?.length === 2);
  assert.notDeepEqual(movement.context.occluders, events.events.at(-1).context.occluders);
  assert.deepEqual(state.preferences.worldV2.scenes[0].featureStates, {}, 'prepare callbacks mutated the original World');
  const rejected = capture();
  assert.throws(() => applyWorldOperations(state, [
    { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } },
    { type: 'token.move', payload: { sceneId: 'scene', tokenId: 'missing', x: 100, y: 50 } },
  ], { ruleset, mapPackage: map, ...rejected }), { code: 'token_not_found' });
  assert.equal(state.preferences.worldV2.scenes[0].tokens[0].x, 50);
  // The caller discards these transient inputs on failure; no queue was ever
  // modified by either callback while the transaction was being reduced.
  assert.equal(rejected.events.length, 1);
});

test('trusted source preparation reuses its descriptor while the default ruleset path remains unchanged', () => {
  const state = fixture();
  let descriptions = 0;
  const trackedRuleset = { vision: { describe: (actor, context) => { descriptions++;
    assert.equal(context.token.id, 'source');
    return ruleset.vision.describe(actor); } } };
  const captured = createExplorationOperationCapture({ sourceIds: ['source'], ruleset: trackedRuleset,
    mapForScene: () => map, describeVision: trackedRuleset.vision.describe });
  applyWorldOperations(state, [{ type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 80, y: 50 } }],
    { ruleset: trackedRuleset, mapPackage: map, ...captured });
  assert.equal(descriptions, 1);
  assert.equal(captured.events[0].inputs[0].lineOfSightEnabled, true);
  const payload = captured.events[0].inputs[0].payload;
  prepareFogOperation(state, { type: 'scene.fog.explore', payload }, { ruleset: trackedRuleset, mapPackage: map });
  assert.equal(descriptions, 2, 'default Fog preparation must still consult its actual ruleset');
  const changed = structuredClone(state);
  changed.preferences.worldV2.actors[0].effects = [{ definitionId: 'xray' }];
  const xray = createExplorationOperationCapture({ sourceIds: ['source'], ruleset: trackedRuleset,
    mapForScene: () => map, describeVision: trackedRuleset.vision.describe });
  applyWorldOperations(changed, [{ type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 90, y: 50 } }],
    { ruleset: trackedRuleset, mapPackage: map, ...xray });
  assert.equal(descriptions, 3);
  assert.equal(xray.events[0].inputs[0].lineOfSightEnabled, false);
  assert.equal(captured.events[0].inputs[0].lineOfSightEnabled, true, 'later status changes altered an earlier accepted descriptor');
  const synthetic = fixture();
  synthetic.preferences.worldV2.scenes[0].tokens[0] = { ...synthetic.preferences.worldV2.scenes[0].tokens[0],
    actorLink: false, actorDelta: { effects: [{ definitionId: 'xray' }] } };
  const independent = createExplorationOperationCapture({ sourceIds: ['source'], ruleset: trackedRuleset,
    mapForScene: () => map, describeVision: trackedRuleset.vision.describe });
  applyWorldOperations(synthetic, [{ type: 'token.move', payload: { sceneId: 'scene', tokenId: 'source', x: 90, y: 50 } }],
    { ruleset: trackedRuleset, mapPackage: map, ...independent });
  assert.equal(descriptions, 4);
  assert.equal(independent.events[0].inputs[0].lineOfSightEnabled, false);
  assert.deepEqual(synthetic.preferences.worldV2.actors[0].effects, [], 'synthetic senses mutated the base Actor');
});
