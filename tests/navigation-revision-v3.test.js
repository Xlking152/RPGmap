import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationGrid, NAVIGATION_CELL_FLAGS } from '../src/engine/navigation.js';

const map = { width: 100, height: 100, metersPerUnit: 1, liquidBodies: [], features: [{ id: 'door',
  geometry: { type: 'polygon', points: [[40, 40], [60, 40], [60, 60], [40, 60]] },
  capabilities: { navigation: { blocks: true, passableWhenOpen: true } } }] };
const frozen = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; };
const field = (states, scene = {}) => createNavigationGrid(map, scene, null, { appState: { preferences: { featureStates: states } }, moverContext: {} });
const blocked = grid => Boolean(grid.cellFlags({ x: 50, y: 50 }) & NAVIGATION_CELL_FLAGS.blocked);

test('mutable nested door state and shallow-frozen roots serialize afresh, preserving collision changes', () => {
  for (const shallowFreeze of [false, true]) {
    const door = { open: false }, states = { door };
    if (shallowFreeze) Object.freeze(states);
    const navigation = field(states);
    assert.equal(blocked(navigation), true);
    door.open = true; assert.equal(blocked(navigation), false);
    door.open = false; assert.equal(blocked(navigation), true);
  }
});

test('fully frozen plain branches serialize once for repeated navigation probes', () => {
  const original = JSON.stringify, states = frozen({ door: { open: false } }), scene = frozen({ destroyedObjectIds: [], clipHits: [] });
  const counts = { states: 0, scene: 0 };
  JSON.stringify = value => { if (value === states) counts.states++; if (value === scene) counts.scene++; return original(value); };
  try {
    const navigation = field(states, scene);
    for (let index = 0; index < 50; index++) {
      assert.equal(blocked(navigation), true);
      navigation.queryCellFlags()({ x: 51, y: 51 });
      navigation.queryOccupation(1)({ x: 51, y: 51 });
      void navigation.loadedChunkCount;
    }
    assert.deepEqual(counts, { states: 1, scene: 1 });
  } finally { JSON.stringify = original; }
});

test('frozen accessors and custom serializers remain live instead of receiving an identity-only cache', () => {
  let open = false;
  const states = Object.freeze({ get door() { return { open }; } });
  const navigation = field(states);
  assert.equal(blocked(navigation), true);
  open = true; assert.equal(blocked(navigation), false);
  let serializerCalls = 0;
  const custom = Object.freeze({ toJSON() { serializerCalls++; return { revision: serializerCalls }; } });
  const customField = field(custom);
  const initialCalls = serializerCalls;
  customField.cellFlags({ x: 5, y: 5 }); customField.cellFlags({ x: 6, y: 6 });
  assert.ok(serializerCalls > initialCalls);
});

test('invalid JSON branches retain JSON.stringify errors rather than getting silently cached', () => {
  const cyclic = {}; cyclic.self = cyclic; Object.freeze(cyclic);
  assert.throws(() => field(cyclic), /circular/i);
  assert.throws(() => field(Object.freeze({ value: 1n })), /BigInt/i);
});
