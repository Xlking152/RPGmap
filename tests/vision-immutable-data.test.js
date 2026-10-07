import test from 'node:test';
import assert from 'node:assert/strict';
import { isImmutableVisionData, hasImmutableVisionData, recordImmutableVisionData } from '../src/vision/immutable-data.js';

test('shared immutable structure proof never evaluates accessors and rejects evolving children or cycles', () => {
  const mutable = { x: 1 }, shallow = Object.freeze({ mutable });
  assert.equal(isImmutableVisionData(shallow), false);
  mutable.x = 2;
  assert.equal(hasImmutableVisionData(shallow), false);
  let reads = 0;
  const accessor = Object.freeze({ get x() { reads++; return reads; } });
  assert.equal(isImmutableVisionData(accessor), false);
  assert.equal(recordImmutableVisionData(accessor, { x: { value: 1 } }), false);
  assert.equal(reads, 0);
  const cyclic = {}; cyclic.self = cyclic; Object.freeze(cyclic);
  assert.equal(isImmutableVisionData(cyclic), false);
  assert.equal(hasImmutableVisionData(cyclic), false);
  const coercion = Object.freeze({ [Symbol.toPrimitive]: () => reads++ });
  assert.equal(isImmutableVisionData(coercion), false, 'hidden function hooks cannot establish pure data');
  assert.equal(reads, 0);
});

test('pre-read frozen container descriptors cannot fabricate or partially seed a structure proof', () => {
  const child = Object.freeze({ x: 1 }), container = Object.freeze({ child, name: 'scene' });
  const descriptors = Object.getOwnPropertyDescriptors(container);
  assert.equal(recordImmutableVisionData(container, { ...descriptors,
    child: { ...descriptors.child, value: Object.freeze({ x: 2 }) } }), false);
  assert.equal(hasImmutableVisionData(container), false);
  assert.equal(recordImmutableVisionData(container, { child: descriptors.child }), false);
  assert.equal(hasImmutableVisionData(container), false);
  assert.equal(recordImmutableVisionData(container, descriptors), true);
  assert.equal(isImmutableVisionData(container), true);
  assert.equal(hasImmutableVisionData(child), true);
});

test('inherited serialization hooks invalidate existing structural reuse without executing them', () => {
  const value = Object.freeze({ x: 1 });
  assert.equal(isImmutableVisionData(value), true);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  let reads = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', { configurable: true,
      get() { reads++; return () => ({ x: reads }); } });
    assert.equal(isImmutableVisionData(value), false);
    assert.equal(hasImmutableVisionData(value), false);
    assert.equal(recordImmutableVisionData(value, Object.getOwnPropertyDescriptors(value)), false);
    assert.equal(reads, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'toJSON', previous);
    else delete Object.prototype.toJSON;
  }
  assert.equal(hasImmutableVisionData(value), true, 'unchanged frozen data remains safe after the hook is removed');
});
