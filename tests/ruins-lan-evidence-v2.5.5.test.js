import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { createRuinsLanFixture, assertRuinsSceneEventDelta, sceneEventsHash } from '../scripts/ruins-lan-smoke.mjs';
import { deriveSceneState } from '../src/engine/state.js';

const fixtureMap = () => prepareMapPackage({ id: 'lan-fixture', version: '1', width: 100, height: 100,
  metersPerUnit: 1, svg: '<svg/>', layers: ['buildings'], destructibleCategories: ['building'], features: [
    { id: 'house', category: 'building', mode: 'object', geometry: { type: 'polygon', points: [[20, 20], [60, 20], [60, 60], [20, 60]] } },
    { id: 'other', category: 'wall', geometry: { type: 'polygon', points: [[80, 20], [82, 20], [82, 60], [80, 60]] } },
  ] });

test('LAN ruins fixture is a real partial range hit on only one undamaged building', () => {
  const history = [{ id: 'other-damage', type: 'damage', objectIds: ['other'], clipHits: [] }];
  const fixture = createRuinsLanFixture(fixtureMap(), history);
  assert.equal(fixture.featureId, 'house');
  assert(fixture.partialCoverage > 0 && fixture.partialCoverage < 0.95);
  assert.deepEqual(fixture.partialEvent.objectIds, []);
  assert.deepEqual(fixture.partialEvent.clipHits.map(hit => hit.featureId), ['house']);
  assert.equal(fixture.partialEvent.areaSnapshot.shape, 'circle');
  const effective = deriveSceneState([...history, fixture.partialEvent]);
  assert.deepEqual(effective.destroyedObjectIds, ['other']);
  assert.deepEqual(effective.damagedFeatureIds, ['house', 'other']);
});

test('LAN fixture cannot quietly reuse an already damaged building', () => {
  assert.throws(() => createRuinsLanFixture(fixtureMap(), [
    { id: 'house-damage', type: 'damage', objectIds: ['house'], clipHits: [] },
  ]), /no isolated, undamaged building/);
});

test('LAN SceneEvent proof rejects missing, altered, wrong-scene and private-Token deltas', () => {
  const event = { id: 'whole', type: 'damage', objectIds: ['house'], clipHits: [] };
  const value = { changes: [{ action: 'create', document: { type: 'SceneEvent', id: event.id,
    parent: { type: 'Scene', id: 'scene' } }, changed: structuredClone(event) }] };
  assert.deepEqual(assertRuinsSceneEventDelta(value, 'scene', event), value.changes[0]);
  assert.throws(() => assertRuinsSceneEventDelta({ changes: [] }, 'scene', event), /exactly one/);
  assert.throws(() => assertRuinsSceneEventDelta(value, 'other-scene', event), /exactly one/);
  const altered = structuredClone(value); altered.changes[0].changed.objectIds = ['other'];
  assert.throws(() => assertRuinsSceneEventDelta(altered, 'scene', event), /differs/);
  const leaked = structuredClone(value); leaked.changes.push({ document: { type: 'Token', id: 'smoke-secret-token' } });
  assert.throws(() => assertRuinsSceneEventDelta(leaked, 'scene', event), /GM-only Token/);
});

test('LAN history hashes ignore key order but include each real damage or restore event', () => {
  assert.equal(sceneEventsHash([{ type: 'damage', id: 'one', objectIds: ['house'] }]),
    sceneEventsHash([{ objectIds: ['house'], id: 'one', type: 'damage' }]));
  assert.notEqual(sceneEventsHash([{ id: 'one', type: 'damage', objectIds: ['house'] }]),
    sceneEventsHash([{ id: 'one', type: 'damage', objectIds: ['other'] }]));
});
