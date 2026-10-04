import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalWorldValidator, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';
import { createCanonicalWorldValidator as previousValidator } from './fixtures/world-schema-before-json-snapshot.mjs';

function result(validate, value, bytes = false) {
  try {
    validate(value);
    return { accepted: true, ...(bytes ? { bytes: validate.serializedBytes(value), json: JSON.stringify(value) } : {}) };
  } catch (error) { return { accepted: false, name: error.name, message: error.message, code: error.code }; }
}

test('one-call whole-data eligibility preserves nested/shared snapshots and complete old output', () => {
  const build = () => {
    const shared = { coordinates: [0, -0, 1.25], detail: { name: '地图😀' } };
    const tokens = Array.from({ length: 500 }, (_, index) => ({ id: `token-${index}`, x: index, effects: [], shared }));
    return { preferences: {}, scenes: [{ tokens }], legacy: { tokens: [...tokens] } };
  };
  const current = build(), previous = build(), validate = createCanonicalWorldValidator();
  assert.deepEqual(result(validate, current, true), result(previousValidator(), previous, true));
  for (const value of [current, current.scenes, current.scenes[0], current.scenes[0].tokens, current.legacy.tokens]) {
    assert.equal(Object.isFrozen(value), true);
    assert.equal(validate.isImmutableData(value), true);
  }
});

test('static traversal hooks cannot establish a whole proof before changing later data and restoring native hooks', () => {
  const originalMap = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
  const originalNext = Object.getOwnPropertyDescriptor(iteratorPrototype, 'next');
  const originalSpecies = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  const originalEntries = Object.entries, originalStringify = JSON.stringify, originalByteLength = Buffer.byteLength;
  for (const kind of ['map', 'iterator', 'next', 'species', 'entries', 'stringify', 'byteLength']) {
    const exercise = factory => {
      const trace = [], child = { value: 1 }, value = { first: [0], later: [child, 2] };
      let changed = false;
      const mutate = () => {
        if (changed) return;
        changed = true;
        trace.push(`${kind} hook`);
        Object.defineProperty(Array.prototype, 'map', originalMap);
        Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
        Object.defineProperty(iteratorPrototype, 'next', originalNext);
        Object.defineProperty(Array, Symbol.species, originalSpecies);
        Object.entries = originalEntries; JSON.stringify = originalStringify; Buffer.byteLength = originalByteLength;
        Object.defineProperty(child, 'value', { enumerable: true, configurable: true, get() {
          trace.push('later child getter');
          Object.defineProperty(Array.prototype, Symbol.iterator, { ...originalIterator, value: function () {
            const iterator = Reflect.apply(originalIterator.value, this, []);
            return { next() {
              const step = Reflect.apply(originalNext.value, iterator, []);
              return !step.done && step.value === 2 ? { value: Infinity, done: false } : step;
            }, return() { trace.push('iterator closed'); return { done: true }; } };
          } });
          return 1;
        } });
      };
      try {
        if (kind === 'map') Object.defineProperty(Array.prototype, 'map', { ...originalMap,
          value: function (callback) { mutate(); return Reflect.apply(originalMap.value, this, [callback]); } });
        if (kind === 'iterator') Object.defineProperty(Array.prototype, Symbol.iterator, { ...originalIterator,
          value: function () { mutate(); return Reflect.apply(originalIterator.value, this, []); } });
        if (kind === 'next') Object.defineProperty(iteratorPrototype, 'next', { ...originalNext,
          value: function () { mutate(); return Reflect.apply(originalNext.value, this, []); } });
        if (kind === 'species') Object.defineProperty(Array, Symbol.species, { ...originalSpecies,
          get() { mutate(); return Array; } });
        if (kind === 'entries') Object.entries = current => { mutate(); return originalEntries(current); };
        if (kind === 'stringify') JSON.stringify = current => { mutate(); return originalStringify(current); };
        if (kind === 'byteLength') Buffer.byteLength = (...args) => { mutate(); return originalByteLength(...args); };
        return { outcome: result(factory(), value), trace };
      } finally {
        Object.defineProperty(Array.prototype, 'map', originalMap);
        Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
        Object.defineProperty(iteratorPrototype, 'next', originalNext);
        Object.defineProperty(Array, Symbol.species, originalSpecies);
        Object.entries = originalEntries; JSON.stringify = originalStringify; Buffer.byteLength = originalByteLength;
      }
    };
    const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
    assert.deepEqual(actual, expected, kind);
    assert.equal(actual.outcome.accepted, false);
    assert.equal(actual.outcome.code, 'invalid_world');
    assert.ok(actual.trace.includes('later child getter'));
  }
});

test('a rejected pure root cannot seed a later call or immutable graph proof', () => {
  for (const factory of [createCanonicalWorldValidator, previousValidator]) {
    const validate = factory(), child = { value: 1 };
    const state = { payload: [child, 2], markers: [{ id: 'same' }, { id: 'same' }] };
    assert.throws(() => validate(state), { code: 'duplicate_id' });
    assert.equal(Object.isFrozen(child), false);
    if (validate.isImmutableData) assert.equal(validate.isImmutableData(child), false);
    Object.defineProperty(child, 'value', { enumerable: true, configurable: true, get: () => Infinity });
    state.markers = [];
    assert.throws(() => validate(state), /finite numbers/);
    assert.equal(Object.isFrozen(child), false);
  }
});

test('whole eligibility remains local to JSON traversal and does not trust mutation during freezing', () => {
  const originalFreeze = Object.freeze;
  const exercise = factory => {
    const child = { value: 1 }, value = { payload: [child] }, validate = factory();
    let getterReads = 0;
    try {
      Object.freeze = current => {
        if (current === child) {
          Object.freeze = originalFreeze;
          Object.defineProperty(child, 'value', { enumerable: true, configurable: true,
            get() { getterReads++; return 2; } });
        }
        return originalFreeze(current);
      };
      const outcome = result(validate, value);
      assert.equal(getterReads, 0);
      if (validate.isImmutableData) {
        assert.equal(validate.isImmutableData(child), false);
        assert.equal(validate.isImmutableData(value), false);
        assert.equal(getterReads, 0);
      }
      return outcome;
    } finally { Object.freeze = originalFreeze; }
  };
  assert.deepEqual(exercise(createCanonicalWorldValidator), exercise(previousValidator));
});

test('oversized Arrays keep the original early rejection and sibling error order', () => {
  for (const length of [WORLD_LIMITS.maxArrayLength + 1, 100_000_000]) {
    for (const first of ['array', 'number']) {
      const build = () => first === 'array'
        ? { oversized: new Array(length), invalid: Infinity }
        : { invalid: Infinity, oversized: new Array(length) };
      const actual = result(createCanonicalWorldValidator(), build());
      assert.deepEqual(actual, result(previousValidator(), build()));
      assert.equal(actual.code, first === 'array' ? 'world_limit' : 'invalid_world');
    }
  }
});

test('inherited numeric setters keep the original pending-write timing, acceptance and freezing', () => {
  for (const prototype of [Array.prototype, Object.prototype]) {
    const original = Object.getOwnPropertyDescriptor(prototype, '0');
    const exercise = factory => {
      const child = { value: 1 }, value = { payload: child }, validate = factory();
      let trace = '', outcome;
      try {
        Object.defineProperty(prototype, '0', { configurable: true, set(entry) {
          trace += `write:${entry.path};`;
          Object.defineProperty(this, '0', { value: entry, configurable: true, writable: true, enumerable: true });
          delete prototype['0'];
          child.value = Infinity;
        } });
        outcome = result(validate, value);
      } finally {
        if (original) Object.defineProperty(prototype, '0', original); else delete prototype['0'];
      }
      return { outcome, trace, frozen: Object.isFrozen(child), finalValue: String(child.value) };
    };
    const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
    assert.deepEqual(actual, expected);
    assert.equal(actual.outcome.accepted, true);
    assert.equal(actual.frozen, true);
    assert.equal(actual.trace, 'write:state.payload;');
    assert.equal(actual.finalValue, 'Infinity');
  }
});

test('numeric pending setters cannot leave a stale whole proof after installing a later child getter', () => {
  for (const prototype of [Array.prototype, Object.prototype]) {
    const original = Object.getOwnPropertyDescriptor(prototype, '0');
    const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
    const exercise = factory => {
      const child = { value: 1 }, value = { first: {}, later: [child, 2] }, validate = factory();
      let trace = '', outcome;
      try {
        Object.defineProperty(prototype, '0', { configurable: true, set(entry) {
          Object.defineProperty(this, '0', { value: entry, configurable: true, writable: true, enumerable: true });
          trace += `write:${entry.path};`;
          if (entry.path !== 'state.first') return;
          Object.defineProperty(child, 'value', { enumerable: true, configurable: true, get() {
            trace += 'child getter;';
            Object.defineProperty(Array.prototype, Symbol.iterator, { ...originalIterator, value: function () {
              const iterator = Reflect.apply(originalIterator.value, this, []);
              return { next() {
                const step = iterator.next();
                return !step.done && step.value === 2 ? { value: Infinity, done: false } : step;
              }, return() { trace += 'iterator closed;'; return { done: true }; } };
            } });
            return 1;
          } });
        } });
        outcome = result(validate, value);
      } finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
        if (original) Object.defineProperty(prototype, '0', original); else delete prototype['0'];
      }
      return { outcome, trace, frozen: Object.isFrozen(child) };
    };
    const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
    assert.deepEqual(actual, expected);
    assert.equal(actual.outcome.accepted, false);
    assert.equal(actual.outcome.code, 'invalid_world');
    assert.match(actual.outcome.message, /state\.later\[1\] must contain finite numbers/);
    assert.equal(actual.frozen, false);
    assert.ok(actual.trace.includes('child getter;'));
    assert.ok(actual.trace.includes('iterator closed;'));
  }
});

test('patched proof-only traversal methods do not run while qualifying an ordinary root', () => {
  for (const [owner, key] of [[Object, 'getOwnPropertyNames'], [WeakSet.prototype, 'delete']]) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const exercise = factory => {
      const value = { payload: { value: 1 } }, validate = factory();
      let calls = 0, outcome;
      try {
        Object.defineProperty(owner, key, { ...descriptor, value: function (...args) {
          calls++;
          return Reflect.apply(descriptor.value, this, args);
        } });
        outcome = result(validate, value);
      } finally { Object.defineProperty(owner, key, descriptor); }
      return { outcome, calls, frozen: Object.isFrozen(value.payload) };
    };
    const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
    assert.deepEqual(actual, expected, key);
    assert.equal(actual.calls, 0);
    assert.equal(actual.outcome.accepted, true);
    assert.equal(actual.frozen, true);
  }
});
