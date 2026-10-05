import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sceneVisionContext, sceneExplorationContext, releaseVisionContexts } from '../src/vision/context.js';
import { sceneExplorationContext as serverCircleContext } from '../src/server/authority.js';
import { createExplorationOperationCapture } from '../src/vision/exploration-operations.js';
import { emptyExploration, enqueueExploration, validateExploration, applyExplorationDelta,
  explorationDelta, finishExplorationChunk } from '../deployment/local-server/exploration-queue.mjs';

const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen);
  return Object.freeze(value);
}
function fixture() {
  const map = { id: 'context-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1,
    features: [], lights: [] };
  const scene = frozen({ id: 'scene', sceneEvents: [], featureStates: {}, settings: { lighting: 'normal' },
    occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[40, 0], [45, 0], [45, 150], [40, 150]] }],
    tokens: [{ id: 'source', placement: 'map', x: 10, y: 20, elevationMeters: 0,
      light: { enabled: false } }, { id: 'lamp', placement: 'map', x: 20, y: 20, elevationMeters: 0,
      light: { enabled: true, rangeMeters: 120, intensity: 1, elevationOffsetMeters: 3, occlusion: 'scene' } }] });
  return { map, scene };
}
const input = (id = 'move:0') => ({ id, tokenId: 'source', createdRevision: 1, sceneId: 'scene', partyId: 'party',
  vagueRangeMeters: 120, senses: {}, path: [{ x: 10, y: 20, elevationMeters: 0 }, { x: 20, y: 20, elevationMeters: 0 }] });

test('durable context preserves the previous JSON geometry and reuses non-light movement snapshots', () => {
  const { map, scene } = fixture();
  const spatial = sceneVisionContext(map, scene);
  const reference = { map: { id: map.id, version: map.version, width: map.width, height: map.height,
    metersPerUnit: map.metersPerUnit || 1 }, occluders: spatial.occluders.map(occluder => ({ ...occluder,
      blockingHeightMeters: Number.isFinite(occluder.blockingHeightMeters) ? occluder.blockingHeightMeters : null })),
    lights: spatial.lights, ambient: scene.settings.lighting };
  const first = sceneExplorationContext(map, scene);
  assert.deepEqual(first, reference);
  assert.equal(JSON.stringify(first), JSON.stringify(reference));
  assert.equal(first.occluders[0].blockingHeightMeters, null);
  const moved = frozen({ ...scene, tokens: scene.tokens.map(token => token.id === 'source' ? { ...token, x: 25 } : token) });
  assert.equal(sceneExplorationContext(map, moved), first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.map));
  assert.ok(Object.isFrozen(first.occluders[0]));
  assert.ok(Object.isFrozen(first.occluders[0].polygons[0][0][0]));
  assert.ok(Object.isFrozen(first.lights[0]));

  const queued = enqueueExploration(emptyExploration(), first, input());
  const second = enqueueExploration(queued, structuredClone(first), input('move:1'));
  assert.equal(second.contexts[checksum(first)], first, 'same checksum must preserve the accepted context object');
  assert.deepEqual(explorationDelta(queued, second).contexts, {});
  assert.deepEqual(applyExplorationDelta(queued, explorationDelta(queued, second)), second);
  let drained = second;
  for (const job of Object.values(second.jobs)) drained = finishExplorationChunk(drained, {
    id: job.id, worldEpoch: job.worldEpoch, epoch: job.epoch, fromCursor: 0, cursor: job.totalSamples });
  assert.deepEqual(drained.contexts, {});
});

test('ambient, light movement, geometry and map metrics rebuild bounded durable versions', () => {
  const { map, scene } = fixture();
  const normal = sceneExplorationContext(map, scene);
  const dimScene = frozen({ ...scene, settings: { lighting: 'dim' } });
  const darkScene = frozen({ ...scene, settings: { lighting: 'dark' } });
  const dim = sceneExplorationContext(map, dimScene), dark = sceneExplorationContext(map, darkScene);
  assert.notEqual(dim, normal);
  assert.notEqual(dark, dim);
  assert.notEqual(sceneExplorationContext(map, scene), normal, 'third version evicts the oldest of two snapshots');
  assert.equal(normal.ambient, 'normal');
  assert.equal(dim.ambient, 'dim');

  const movedLamp = frozen({ ...scene, tokens: scene.tokens.map(token => token.id === 'lamp' ? { ...token, x: 80 } : token) });
  const lit = sceneExplorationContext(map, movedLamp);
  assert.equal(lit.lights[0].x, 80);
  assert.equal(normal.lights[0].x, 20, 'accepted snapshots remain intact');
  const disabled = frozen({ ...scene, featureStates: { wall: { vision: { occluder: false } } } });
  assert.equal(sceneExplorationContext(map, disabled).occluders.length, 0);
  map.metersPerUnit = 2;
  assert.equal(sceneExplorationContext(map, scene).map.metersPerUnit, 2);
  assert.equal(normal.map.metersPerUnit, 1);
  const prior = sceneExplorationContext(map, scene);
  releaseVisionContexts(map);
  assert.notEqual(sceneExplorationContext(map, scene), prior);
  const mutable = structuredClone(scene);
  const intact = sceneExplorationContext(map, mutable);
  mutable.featureStates.wall = { vision: { occluder: false } };
  assert.equal(sceneExplorationContext(map, mutable).occluders.length, 0);
  assert.equal(intact.occluders.length, 1, 'mutable geometry must rebuild without altering earlier snapshots');
});

test('movement capture and server source circles share the same derived context', () => {
  const { map, scene: base } = fixture();
  const scene = frozen({ ...base, tokens: base.tokens.map(token => ({ ...token,
    actorId: 'actor', actorLink: true, vision: { enabled: true } })) });
  const state = frozen({ preferences: { worldV2: { schemaVersion: 4, activeSceneId: scene.id,
    actors: [{ id: 'actor', type: 'pc', partyId: 'party', effects: [] }], scenes: [scene], statusDefinitions: [] } } });
  const capture = createExplorationOperationCapture({ sourceIds: ['source'], mapForScene: () => map,
    ruleset: { vision: { describe: () => ({ rangeMeters: 120, vagueRangeMeters: 120, senses: {} }) } } });
  const operation = { type: 'token.move', payload: { sceneId: scene.id, tokenId: 'source', x: 25, y: 20 } };
  const prepared = capture.prepareOperation({ state, operation });
  const moved = frozen({ ...scene, tokens: scene.tokens.map(token => token.id === 'source' ? { ...token, x: 25 } : token) });
  const after = frozen({ preferences: { worldV2: { ...state.preferences.worldV2, scenes: [moved] } } });
  capture.onOperationApplied({ state: after, operation, prepared, results: [{ action: 'token.move', tokenId: 'source' }] });
  assert.equal(capture.events[0].context, serverCircleContext(map, moved));
  assert.equal(capture.events[0].context, sceneExplorationContext(map, scene));
});

test('internal memo never skips global job, path, epoch or external checksum validation', () => {
  const { map, scene } = fixture(), context = sceneExplorationContext(map, scene);
  const queue = enqueueExploration(emptyExploration(), context, input());
  const job = queue.jobs['move:0'];
  for (const patch of [{ totalSamples: job.totalSamples + 1 }, { epoch: 5 }, { worldEpoch: 'old' },
    { cursor: job.totalSamples }, { path: [{ x: Infinity, y: 20, elevationMeters: 0 }] }]) {
    const invalid = { ...queue, jobs: { ...queue.jobs, [job.id]: { ...job, ...patch } } };
    assert.throws(() => enqueueExploration(invalid, context, input('next:0')), { code: 'exploration_queue_invalid' });
  }
  const corruptContext = { ...context, ambient: 'dark' };
  const invalid = { ...queue, contexts: { [job.contextId]: corruptContext } };
  assert.throws(() => validateExploration(invalid), /checksum/);
  assert.throws(() => applyExplorationDelta(queue, { schemaVersion: 1, contexts: { [job.contextId]: corruptContext } }), /checksum/);
});

test('equal immutable contexts recovered from storage retain identity and memoize only internal checksum work', () => {
  const { map, scene } = fixture(), derived = sceneExplorationContext(map, scene);
  const original = enqueueExploration(emptyExploration(), derived, input());
  const recovered = frozen(JSON.parse(JSON.stringify(original)));
  validateExploration(recovered);
  const contextId = original.jobs['move:0'].contextId;
  const incoming = frozen(structuredClone(derived));
  const prototype = Object.getPrototypeOf(createHash('sha256'));
  const update = prototype.update;
  let hashes = 0;
  prototype.update = function (...args) { hashes += 1; return update.apply(this, args); };
  try {
    const next = enqueueExploration(recovered, incoming, input('move:1'));
    assert.equal(next.contexts[contextId], recovered.contexts[contextId]);
    assert.equal(hashes, 1, 'an equal incoming context is hashed once before its first successful admission');
    hashes = 0;
    const after = enqueueExploration(next, incoming, input('move:2'));
    assert.equal(hashes, 0, 'already verified immutable input and accepted context need no internal rehash');
    hashes = 0;
    validateExploration(after);
    assert.equal(hashes, 1, 'external complete validation must recompute every context checksum');
    hashes = 0;
    applyExplorationDelta(after, { schemaVersion: 1 });
    assert.equal(hashes, 1, 'WAL delta validation also recomputes unchanged contexts');
  } finally { prototype.update = update; }
});

test('shallow frozen, getter, toJSON and proxy contexts retain fresh checksum checks', () => {
  const base = { map: { metersPerUnit: 1 }, occluders: [], lights: [] };
  for (const kind of ['shallow', 'getter', 'toJSON', 'proxy']) {
    let extra = 'first';
    let context;
    if (kind === 'shallow') context = Object.freeze({ ...structuredClone(base), nested: { extra } });
    if (kind === 'getter') context = Object.freeze({ ...frozen(structuredClone(base)), get extra() { return extra; } });
    if (kind === 'toJSON') context = Object.freeze({ ...frozen(structuredClone(base)), toJSON() { return { ...base, extra }; } });
    if (kind === 'proxy') context = new Proxy(frozen({ ...structuredClone(base), extra }), {
      get: (target, key) => key === 'toJSON' ? () => ({ ...base, extra }) : Reflect.get(target, key) });
    const queue = enqueueExploration(emptyExploration(), context, input());
    extra = 'second';
    if (kind === 'shallow') context.nested.extra = extra;
    assert.throws(() => enqueueExploration(queue, context, input('next:0')), /checksum/, kind);
    assert.throws(() => validateExploration(queue), /checksum/, kind);
  }
});

test('every internal enqueue still enforces the exact 32 MiB JSON budget including unknown fields and UTF-8', () => {
  const { map, scene } = fixture(), context = sceneExplorationContext(map, scene);
  const queue = enqueueExploration(emptyExploration(), context, input());
  const next = enqueueExploration(queue, context, input('move:1'));
  const prefix = '中文😀\\\"\n';
  const sized = { ...next, unknown: prefix };
  const spare = 32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(sized));
  const boundary = { ...sized, unknown: prefix + 'a'.repeat(spare) };
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 32 * 1024 * 1024);
  assert.equal(validateExploration(boundary), boundary);
  const justUnder = { ...queue, unknown: prefix + 'a'.repeat(spare) };
  assert.equal(Buffer.byteLength(JSON.stringify(enqueueExploration(justUnder, context, input('move:1')))), 32 * 1024 * 1024);
  assert.throws(() => enqueueExploration({ ...justUnder, unknown: justUnder.unknown + 'a' }, context, input('move:1')),
    { code: 'exploration_backlog' });
  assert.throws(() => validateExploration({ ...boundary, unknown: boundary.unknown + 'a' }), { code: 'exploration_backlog' });
});
