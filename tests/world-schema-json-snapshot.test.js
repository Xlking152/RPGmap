import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanonicalWorldValidator, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';
import { createCanonicalWorldValidator as previousValidator } from './fixtures/world-schema-before-json-snapshot.mjs';

function outcome(validate, value, measureBytes = true) {
  try {
    validate(value);
    return { accepted: true, ...(measureBytes ? { bytes: validate.serializedBytes(value), json: JSON.stringify(value) } : {}) };
  } catch (error) {
    return { accepted: false, name: error.name, message: error.message, code: error.code };
  }
}

function compare(build, measureBytes = true) {
  const currentTrace = [], previousTrace = [];
  const current = build(currentTrace), previous = build(previousTrace);
  const actual = outcome(createCanonicalWorldValidator(), current, measureBytes);
  const expected = outcome(previousValidator(), previous, measureBytes);
  assert.deepEqual(actual, expected);
  assert.deepEqual(currentTrace, previousTrace);
  return { actual, current, previous, trace: currentTrace };
}

test('dense snapshots preserve complete acceptance, serialized bytes and frozen output for ordinary data', () => {
  for (const values of [[], [null, false, true, 0, -0, 1.25, 1e20, '地图😀\ud800\n"\\'],
    [[1, 2], { nested: [3, { text: 'sample' }] }], Array.from({ length: 500 }, (_, index) => ({
      id: `token-${index}`, x: index, y: index + 0.25, effects: [],
    }))]) {
    const result = compare(() => ({ preferences: {}, payload: structuredClone(values) }));
    assert.equal(result.actual.accepted, true);
    assert.equal(result.actual.bytes, Buffer.byteLength(result.actual.json));
    assert.equal(Object.isFrozen(result.current.payload), true);
    for (const child of result.current.payload) if (child && typeof child === 'object') assert.equal(Object.isFrozen(child), true);
  }
});

test('ordinary dense Arrays use preparation and visitor type decisions instead of repeated per-child checks', () => {
  const count = factory => {
    const value = { payload: Array.from({ length: 500 }, (_, index) => index) };
    const original = Array.isArray;
    let checks = 0;
    try {
      Array.isArray = candidate => { if (candidate === value.payload) checks++; return original(candidate); };
      assert.equal(outcome(factory(), value, false).accepted, true);
    } finally { Array.isArray = original; }
    return checks;
  };
  assert.equal(count(createCanonicalWorldValidator), 2);
  assert.equal(count(previousValidator), 1_502);
});

test('all values are snapshotted before child accessors mutate a later dense Array slot', () => {
  const result = compare(trace => {
    const later = { value: 'original' }, child = {};
    const payload = [child, later];
    let changed = false;
    Object.defineProperty(child, 'change', { enumerable: true, get() {
      trace.push('child getter');
      if (!changed) { changed = true; payload[1] = { replaced: 'after snapshot' }; }
      return 'ok';
    } });
    return { preferences: {}, payload };
  });
  assert.equal(result.actual.accepted, true);
  assert.equal(result.current.payload[1].replaced, 'after snapshot');
  assert.equal(Object.isFrozen(result.current.payload[1]), false, 'the replacement was not in the old snapshot');
});

test('Array accessors and Proxies preserve the complete original read and trap order', () => {
  for (const kind of ['array-accessor', 'child-proxy', 'array-proxy', 'revoked-during-map']) {
    compare(trace => {
      const child = {};
      Object.defineProperty(child, 'nested', { enumerable: true, get() { trace.push('child getter'); return 1; } });
      let payload = [child, 2, 3];
      if (kind === 'array-accessor') Object.defineProperty(payload, 1, { enumerable: true, configurable: true,
        get() { trace.push('array getter'); return 2; } });
      if (kind === 'child-proxy') payload[0] = new Proxy({ nested: 1 }, {
        get(target, key, receiver) { trace.push(`child get:${String(key)}`); return Reflect.get(target, key, receiver); },
        ownKeys(target) { trace.push('child ownKeys'); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { trace.push(`child descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
        getPrototypeOf(target) { trace.push('child prototype'); return Reflect.getPrototypeOf(target); },
      });
      if (kind === 'array-proxy') payload = new Proxy(payload, {
        get(target, key, receiver) { trace.push(`array get:${String(key)}`); return Reflect.get(target, key, receiver); },
        has(target, key) { trace.push(`array has:${String(key)}`); return Reflect.has(target, key); },
        ownKeys(target) { trace.push('array ownKeys'); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { trace.push(`array descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
        getPrototypeOf(target) { trace.push('array prototype'); return Reflect.getPrototypeOf(target); },
      });
      if (kind === 'revoked-during-map') {
        const revocable = Proxy.revocable([1], { get(target, key, receiver) {
          trace.push(`revocable get:${String(key)}`);
          if (key === '0') { revocable.revoke(); return 1; }
          return Reflect.get(target, key, receiver);
        } });
        payload = revocable.proxy;
      }
      return { preferences: {}, payload };
    });
  }
});

test('holes, hidden indexes, extra keys, Symbols and subclasses keep the old map branch', () => {
  for (const kind of ['hole', 'undefined', 'extra', 'hidden-extra', 'symbol', 'hidden-index', 'subclass']) {
    compare(trace => {
      let payload = [1, 2];
      if (kind === 'hole') delete payload[1];
      if (kind === 'undefined') payload[1] = undefined;
      if (kind === 'extra') payload.extra = 'ignored by Array JSON';
      if (kind === 'hidden-extra') Object.defineProperty(payload, 'extra', { value: 3 });
      if (kind === 'symbol') Object.defineProperty(payload, Symbol('hidden'), { value: 'private', enumerable: false });
      if (kind === 'hidden-index') Object.defineProperty(payload, 1, { value: 2, enumerable: false });
      if (kind === 'subclass') {
        class CustomArray extends Array {
          get map() { trace.push('subclass map getter'); return Array.prototype.map; }
        }
        payload = new CustomArray(1, 2);
      }
      return { preferences: {}, payload };
    });
  }
});

test('own map getter is read once and throwing/custom mapped iterators keep exception closing', () => {
  for (const kind of ['getter', 'throw', 'iterator-error', 'bad-entry']) {
    const result = compare(trace => {
      const payload = [1, 2];
      Object.defineProperty(payload, 'map', { configurable: true, get() {
        trace.push('map getter');
        return function (callback) {
          trace.push('map call');
          if (kind === 'throw') throw new Error('custom map failure');
          if (kind === 'getter') return Array.prototype.map.call(this, callback);
          return { length: 2, *[Symbol.iterator]() {
            try { yield kind === 'bad-entry' ? undefined : [0, Infinity]; }
            finally { trace.push('iterator closed'); }
          } };
        };
      } });
      return { preferences: {}, payload };
    });
    assert.equal(result.trace.filter(value => value === 'map getter').length, 1);
    if (kind === 'iterator-error' || kind === 'bad-entry') assert.ok(result.trace.includes('iterator closed'));
  }
});

test('prototype map/iterator and species hooks keep their original access and exception behavior', () => {
  const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const speciesDescriptor = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  for (const kind of ['map-getter', 'iterator-getter', 'species-getter', 'species-throw']) {
    const exercise = validator => {
      const trace = [], value = { preferences: {}, payload: [1, 2] };
      try {
        if (kind === 'map-getter') Object.defineProperty(Array.prototype, 'map', { configurable: true,
          get() { trace.push('prototype map'); return mapDescriptor.value; } });
        if (kind === 'iterator-getter') Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true,
          get() { trace.push('prototype iterator'); return iteratorDescriptor.value; } });
        if (kind.startsWith('species')) Object.defineProperty(Array, Symbol.species, { configurable: true,
          get() { trace.push('species'); if (kind === 'species-throw') throw new Error('species failure'); return Array; } });
        return { result: outcome(validator(), value), trace };
      } finally {
        Object.defineProperty(Array.prototype, 'map', mapDescriptor);
        Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
        Object.defineProperty(Array, Symbol.species, speciesDescriptor);
      }
    };
    assert.deepEqual(exercise(createCanonicalWorldValidator), exercise(previousValidator));
  }
});

test('child getters changing iteration hooks during a dense Array visit keep the old rejection and close behavior', () => {
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const iteratorPrototype = Object.getPrototypeOf(Reflect.apply(iteratorDescriptor.value, [], []));
  const nextDescriptor = Object.getOwnPropertyDescriptor(iteratorPrototype, 'next');
  const returnDescriptor = Object.getOwnPropertyDescriptor(iteratorPrototype, 'return');
  for (const kind of ['iterator', 'next', 'return']) {
    const exercise = factory => {
      const trace = [], child = {};
      const value = { payload: [child, kind === 'return' ? Infinity : 2] };
      Object.defineProperty(child, 'trigger', { enumerable: true, get() {
        trace.push('child getter');
        if (kind === 'iterator') Object.defineProperty(Array.prototype, Symbol.iterator, { ...iteratorDescriptor,
          value: function () {
            const source = Reflect.apply(iteratorDescriptor.value, this, []);
            return { next() {
              const step = Reflect.apply(nextDescriptor.value, source, []);
              return !step.done && step.value === 2 ? { value: Infinity, done: false } : step;
            }, return() { trace.push('iterator closed'); return { done: true }; } };
          } });
        if (kind === 'next') Object.defineProperty(iteratorPrototype, 'next', { ...nextDescriptor,
          value: function () {
            const step = Reflect.apply(nextDescriptor.value, this, []);
            return !step.done && step.value === 2 ? { value: Infinity, done: false } : step;
          } });
        if (kind === 'return') Object.defineProperty(iteratorPrototype, 'return', { configurable: true,
          get() { trace.push('return getter'); return function () { trace.push('return call'); return { done: true }; }; } });
        return 'triggered';
      } });
      try { return { result: outcome(factory(), value, false), trace }; }
      finally {
        Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
        Object.defineProperty(iteratorPrototype, 'next', nextDescriptor);
        if (returnDescriptor) Object.defineProperty(iteratorPrototype, 'return', returnDescriptor);
        else delete iteratorPrototype.return;
      }
    };
    const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
    assert.deepEqual(actual, expected, kind);
    assert.equal(actual.result.accepted, false);
    assert.equal(actual.result.code, 'invalid_world');
    if (kind === 'return') assert.ok(actual.trace.includes('return call'));
  }
});

test('static ArrayIterator next, inherited return and changed prototype chains use the full old iterator path', () => {
  const iterator = [][Symbol.iterator]();
  const prototype = Object.getPrototypeOf(iterator), parent = Object.getPrototypeOf(prototype);
  const nextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'next');
  const returnDescriptor = Object.getOwnPropertyDescriptor(prototype, 'return');
  const parentReturn = Object.getOwnPropertyDescriptor(parent, 'return');
  for (const kind of ['next-function', 'next-getter', 'return-function', 'return-getter', 'inherited-return', 'changed-chain']) {
    const exercise = factory => {
      const trace = [], value = { payload: [1, kind.includes('return') || kind === 'changed-chain' ? Infinity : 2] };
      try {
        if (kind === 'next-function') Object.defineProperty(prototype, 'next', { ...nextDescriptor,
          value: function () { trace.push('next call'); return Reflect.apply(nextDescriptor.value, this, []); } });
        if (kind === 'next-getter') Object.defineProperty(prototype, 'next', { configurable: true,
          get() { trace.push('next getter'); return nextDescriptor.value; } });
        if (kind === 'return-function') Object.defineProperty(prototype, 'return', { configurable: true,
          value() { trace.push('return call'); return { done: true }; } });
        if (kind === 'return-getter' || kind === 'inherited-return') Object.defineProperty(
          kind === 'inherited-return' ? parent : prototype, 'return', { configurable: true,
            get() { trace.push('return getter'); return function () { trace.push('return call'); return { done: true }; }; } });
        if (kind === 'changed-chain') Object.setPrototypeOf(prototype, Object.create(parent, { return: {
          configurable: true, value() { trace.push('changed chain return'); return { done: true }; },
        } }));
        return { result: outcome(factory(), value, false), trace };
      } finally {
        Object.setPrototypeOf(prototype, parent);
        Object.defineProperty(prototype, 'next', nextDescriptor);
        if (returnDescriptor) Object.defineProperty(prototype, 'return', returnDescriptor);
        else delete prototype.return;
        if (parentReturn) Object.defineProperty(parent, 'return', parentReturn);
        else delete parent.return;
      }
    };
    assert.deepEqual(exercise(createCanonicalWorldValidator), exercise(previousValidator), kind);
  }
});

test('descriptor qualification never reads inherited value, get or set getters', () => {
  const prototype = Object.getPrototypeOf([][Symbol.iterator]());
  const nextDescriptor = Object.getOwnPropertyDescriptor(prototype, 'next');
  const speciesDescriptor = Object.getOwnPropertyDescriptor(Array, Symbol.species);
  const mapDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'map');
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const ownDescriptor = fields => Object.assign(Object.create(null), fields);
  for (const field of ['value', 'get', 'set']) for (const throwing of [false, true]) {
    for (const kind of field === 'value' ? ['next', 'map', 'iterator'] : ['species']) {
      const exercise = factory => {
        const inherited = Object.getOwnPropertyDescriptor(Object.prototype, field);
        const trace = [], value = { payload: [1, 2] };
        try {
          Object.defineProperty(Object.prototype, field, ownDescriptor({ configurable: true, get() {
            trace.push(`inherited ${field}`);
            if (throwing) throw new Error(`inherited ${field} must not be read`);
            return undefined;
          } }));
          if (kind === 'next') Object.defineProperty(prototype, 'next', ownDescriptor({ configurable: true,
            get() { trace.push('next getter'); return nextDescriptor.value; } }));
          if (kind === 'map') Object.defineProperty(Array.prototype, 'map', ownDescriptor({ configurable: true,
            get() { trace.push('map getter'); return mapDescriptor.value; } }));
          if (kind === 'iterator') Object.defineProperty(Array.prototype, Symbol.iterator, ownDescriptor({ configurable: true,
            get() { trace.push('iterator getter'); return iteratorDescriptor.value; } }));
          if (kind === 'species') Object.defineProperty(Array, Symbol.species, ownDescriptor({ configurable: true,
            ...(field === 'get' ? { value: Array } : { get: speciesDescriptor.get }) }));
          return { result: outcome(factory(), value, false), trace };
        } finally {
          if (inherited) Object.defineProperty(Object.prototype, field, ownDescriptor(inherited));
          else delete Object.prototype[field];
          Object.defineProperty(prototype, 'next', nextDescriptor);
          Object.defineProperty(Array, Symbol.species, speciesDescriptor);
          Object.defineProperty(Array.prototype, 'map', mapDescriptor);
          Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor);
        }
      };
      const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
      assert.deepEqual(actual, expected, `${field}/${kind}/${throwing}`);
      assert.equal(actual.result.accepted, true);
      assert.ok(!actual.trace.some(entry => entry === `inherited ${field}`));
    }
  }
});

test('immutable data proof accepts only fully accepted frozen ordinary data graphs', () => {
  const validate = createCanonicalWorldValidator();
  const pureChild = { nested: [1, { value: 'ordinary' }] };
  const world = { payload: [pureChild, null, true] };
  for (const value of [undefined, null, false, 0, 'text', {}, world, pureChild]) {
    assert.equal(validate.isImmutableData(value), false);
  }
  validate(world);
  for (const value of [world, world.payload, pureChild, pureChild.nested, pureChild.nested[1]]) {
    assert.equal(validate.isImmutableData(value), true);
    assert.equal(Object.isFrozen(value), true);
  }
  assert.throws(() => { validate.isImmutableData = () => true; }, TypeError);
  const failedChild = { value: 1 }, failedWorld = { payload: [failedChild, Infinity] };
  assert.throws(() => validate(failedWorld), /finite numbers/);
  for (const value of [failedChild, failedWorld.payload, failedWorld]) assert.equal(validate.isImmutableData(value), false);
  assert.equal(Object.isFrozen(failedChild), false);

  let getterReads = 0, proxyTraps = 0;
  const accessor = { get value() { getterReads++; return 1; } };
  const proxy = new Proxy({ value: 2 }, { get(target, key, receiver) {
    proxyTraps++; return Reflect.get(target, key, receiver);
  } });
  const unusual = { payload: [accessor, proxy] };
  validate(unusual);
  const readsBeforeProof = getterReads, trapsBeforeProof = proxyTraps;
  for (const value of [unusual, unusual.payload, accessor, proxy]) assert.equal(validate.isImmutableData(value), false);
  assert.equal(getterReads, readsBeforeProof);
  assert.equal(proxyTraps, trapsBeforeProof);
});

test('later getters cannot turn a stale visitor summary into an immutable data proof', () => {
  const validate = createCanonicalWorldValidator();
  const child = { value: 1 };
  let replacementReads = 0;
  const later = { get mutate() {
    Object.defineProperty(child, 'value', { enumerable: true, configurable: true,
      get() { replacementReads++; return 2; } });
    return 'done';
  } };
  const world = { payload: [child, later] };
  validate(world);
  assert.equal(Object.isFrozen(child), true);
  assert.equal(typeof Object.getOwnPropertyDescriptor(child, 'value').get, 'function');
  assert.equal(validate.isImmutableData(child), false);
  assert.equal(validate.isImmutableData(world.payload), false);
  assert.equal(validate.isImmutableData(world), false);
  assert.equal(replacementReads, 0, 'descriptor-only proof must not read the replaced getter');
});

test('stale accepted summaries cannot skip dynamic iterator fallback after relocation', () => {
  const iteratorDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  const exercise = factory => {
    const trace = [], validate = factory(), child = { value: 1 };
    const later = { get mutate() {
      Object.defineProperty(child, 'value', { enumerable: true, configurable: true, get() {
        trace.push('relocated getter');
        Object.defineProperty(Array.prototype, Symbol.iterator, { ...iteratorDescriptor, value: function () {
          const source = Reflect.apply(iteratorDescriptor.value, this, []);
          return { next() {
            const step = source.next();
            return !step.done && step.value === 2 ? { value: Infinity, done: false } : step;
          }, return() { trace.push('iterator closed'); return { done: true }; } };
        } });
        return 1;
      } });
      return 'done';
    } };
    try {
      validate({ payload: [child, later] });
      return { result: outcome(validate, { relocated: [child, 2] }, false), trace };
    } finally { Object.defineProperty(Array.prototype, Symbol.iterator, iteratorDescriptor); }
  };
  const actual = exercise(createCanonicalWorldValidator), expected = exercise(previousValidator);
  assert.deepEqual(actual, expected);
  assert.equal(actual.result.accepted, false);
  assert.equal(actual.result.code, 'invalid_world');
  assert.ok(actual.trace.includes('relocated getter'));
});

test('a failed freeze cannot seed the complete-acceptance proof', () => {
  const validate = createCanonicalWorldValidator();
  const child = { value: 1 };
  const proxy = new Proxy({ value: 2 }, { preventExtensions() { throw new Error('freeze failed'); } });
  const world = { payload: [child, proxy] };
  assert.throws(() => validate(world), /freeze failed/);
  assert.equal(Object.isFrozen(child), true, 'the old visitor may already have frozen an earlier child');
  for (const value of [child, proxy, world.payload, world]) assert.equal(validate.isImmutableData(value), false);
});

test('array cache remains path-specific and rejected candidates do not freeze or seed snapshots', () => {
  for (const factory of [createCanonicalWorldValidator, previousValidator]) {
    const validate = factory();
    const rows = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [index, [[0, 0]]]));
    const first = { scene: { fog: { exploredByParty: { party: { rows } } } }, payload: [[{ value: 1 }]] };
    validate(first);
    assert.throws(() => validate({ ...first, ordinary: { rows } }), { code: 'world_limit' });
    assert.equal(validate.serializedBytes(first), Buffer.byteLength(JSON.stringify(first)));
    const rejected = { payload: [[{ value: 1 }], [Infinity]] };
    assert.throws(() => validate(rejected), /finite numbers/);
    assert.equal(Object.isFrozen(rejected.payload), false);
    assert.equal(Object.isFrozen(rejected.payload[0][0]), false);
    rejected.payload[0][0].value = NaN;
    rejected.payload[1][0] = 2;
    assert.throws(() => validate(rejected), /finite numbers/);
    const changed = { ...first, payload: [[{ value: 2 }]] };
    validate(changed);
    assert.equal(validate.serializedBytes(changed), Buffer.byteLength(JSON.stringify(changed)));
  }
});

test('dense snapshots preserve exact limit errors including array, string, key and depth budgets', () => {
  for (const build of [() => Array(WORLD_LIMITS.maxArrayLength + 1).fill(0),
    () => ['x'.repeat(WORLD_LIMITS.maxStringLength + 1)], () => [{ ['k'.repeat(161)]: 1 }],
    () => { let nested = [0]; for (let i = 0; i < WORLD_LIMITS.maxDepth; i++) nested = [nested]; return nested; }]) {
    const result = compare(() => ({ payload: build() }), false);
    assert.equal(result.actual.accepted, false);
    assert.equal(result.actual.code, 'world_limit');
  }
});
