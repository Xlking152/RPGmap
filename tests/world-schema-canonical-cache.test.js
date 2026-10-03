import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorldState, createCanonicalWorldValidator, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';

test('canonical validation freezes accepted branches and revalidates changed branches', () => {
  const validate = createCanonicalWorldValidator();
  const first = { preferences: {}, payload: { nested: ['valid', 1] } };
  validate(first);
  assert.equal(Object.isFrozen(first.payload.nested), true);
  assert.throws(() => { first.payload.nested.push(2); }, TypeError);
  const next = { ...first, preferences: { ...first.preferences }, movement: { x: 2, y: 3 } };
  assert.equal(validate(next), next);
  assert.throws(() => validate({ ...next, movement: { x: Infinity, y: 3 } }), /finite numbers/);
  assert.throws(() => validate({ ...next, movement: { x: 'x'.repeat(WORLD_LIMITS.maxStringLength + 1) } }), { code: 'world_limit' });
});

test('cached canonical branches still count each occurrence toward node and depth limits', () => {
  const validate = createCanonicalWorldValidator();
  const shared = Array(1000).fill(0);
  const first = { a: Array(100).fill(shared) };
  validate(first);
  // Half the graph retains identical paths and references. The new half must
  // still contribute the full cost, including every repeated shared branch.
  assert.throws(() => validate({ ...first, b: Array(100).fill(shared) }), { code: 'world_limit' });
  let nested = { leaf: 1 };
  for (let index = 0; index < 22; index += 1) nested = { child: nested };
  const atLimit = { payload: nested };
  validate(atLimit);
  assert.throws(() => validate({ payload: { child: nested } }), { code: 'world_limit' });
});

test('untrusted mutable inputs never inherit canonical reference validation', () => {
  const mutable = { preferences: {}, payload: { value: 1 } };
  assertWorldState(mutable);
  assert.equal(Object.isFrozen(mutable.payload), false);
  mutable.payload.value = Infinity;
  assert.throws(() => assertWorldState(mutable), /finite numbers/);
  const validate = createCanonicalWorldValidator();
  const rejected = { payload: { good: [1, 2], bad: Infinity } };
  assert.throws(() => validate(rejected), /finite numbers/);
  assert.equal(Object.isFrozen(rejected.payload.good), false);
  rejected.payload.good[0] = NaN;
  rejected.payload.bad = 1;
  assert.throws(() => validate(rejected), /finite numbers/);
});

test('Fog dictionary exemptions remain path-specific for cached branches', () => {
  const validate = createCanonicalWorldValidator();
  const rows = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [index, [[0, 0]]]));
  // A minimal legacy state can carry an opaque Fog-like field, allowing us to
  // isolate generic JSON limits from the independent World V2 Fog validator.
  const first = { scene: { fog: { exploredByParty: { party: { rows } } } } };
  validate(first);
  assert.throws(() => validate({ ...first, ordinary: { rows } }), { code: 'world_limit' });
});
