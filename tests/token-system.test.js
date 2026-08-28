import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { createTokenRuntimeSystem } from '../src/token/system.js';
import { WORLD_STATE_KEY, activeWorldScene } from '../src/world/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图' };

function actor() {
  return {
    id: 'actor-1', name: '角色', currentFormId: 'form-1',
    forms: [{ id: 'form-1', tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }],
    runtime: {}, effects: [],
  };
}

function state() {
  return {
    saveVersion: 2, mapId: 'test-map', mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      gridVisible: true,
      entitySystem: { schemaVersion: 3, statusDefinitions: [], actors: [actor()], tokens: [] },
    },
  };
}

function apiFixture() {
  let current = state();
  const events = [];
  const api = {
    mapPackage,
    ruleset: infiniteHorrorRuleset,
    getState() { return structuredClone(current); },
    commitState(next, options = {}) { current = structuredClone(next); events.push(['commit', options.source, options.reason]); return true; },
    importState(next, ...args) { current = structuredClone(next); events.push(['import', ...args]); return true; },
    emit(type, detail) { events.push([type, detail]); },
  };
  createWorldSystem().register(api);
  createTokenRuntimeSystem().register(api);
  return { api, events, current: () => structuredClone(current) };
}

function assertNoCharacterProjection(current) {
  assert.equal(Object.hasOwn(current, 'characters'), false);
}

test('TokenSystem creates only a canonical Scene Token', async () => {
  const fixture = apiFixture();
  const token = await fixture.api.tokens.create({ actorId: 'actor-1', id: 'token-instance-1', x: 12.5, y: 13.5 });
  assert.equal(token.id, 'token-instance-1');
  assert.equal(token.actorId, 'actor-1');
  const current = fixture.current();
  const world = current.preferences[WORLD_STATE_KEY];
  assert.equal(activeWorldScene(world).tokens[0].x, 12.5);
  assertNoCharacterProjection(current);
  assert.equal(current.preferences.entitySystem.tokens[0].id, 'token-instance-1');
  assert.equal(current.preferences.entitySystem.tokens[0].characterId, undefined);
});

test('TokenSystem supports multiple Token instances for the same Actor without Character documents', async () => {
  const fixture = apiFixture();
  await fixture.api.tokens.create({ actorId: 'actor-1', id: 'token-one', x: 1, y: 1 });
  await fixture.api.tokens.create({ actorId: 'actor-1', id: 'token-two', x: 2, y: 2 });
  assert.deepEqual(fixture.api.tokens.list().map(token => token.id), ['token-one', 'token-two']);
  assert.deepEqual(fixture.api.tokens.list().map(token => token.actorId), ['actor-1', 'actor-1']);
  assertNoCharacterProjection(fixture.current());
});

test('TokenSystem move and feature placement update canonical World placement', async () => {
  const fixture = apiFixture();
  await fixture.api.tokens.create({ actorId: 'actor-1', id: 'token-one', x: 1, y: 1 });
  await fixture.api.tokens.move('token-one', { x: 20.5, y: 21.5 });
  let canonical = fixture.api.tokens.get('token-one');
  assert.deepEqual({ placement: canonical.placement, x: canonical.x, y: canonical.y }, { placement: 'map', x: 20.5, y: 21.5 });

  await fixture.api.tokens.placeInFeature('token-one', 'building-a');
  canonical = fixture.api.tokens.get('token-one');
  assert.equal(canonical.placement, 'feature');
  assert.equal(canonical.featureId, 'building-a');
  assert.equal(canonical.x, null);
  assert.equal(canonical.y, null);
  assertNoCharacterProjection(fixture.current());
});

test('TokenSystem preserves actorLink/actorDelta and deletes canonical state only', async () => {
  const fixture = apiFixture();
  await fixture.api.tokens.create({ actorId: 'actor-1', id: 'npc-one', actorLink: false, actorDelta: { runtime: { resources: { hp: { current: 5 } } } } });
  await fixture.api.tokens.update('npc-one', { hidden: true, elevationFt: 15 });
  const token = fixture.api.tokens.get('npc-one');
  assert.equal(token.actorLink, false);
  assert.equal(token.actorDelta.system.runtime.resources.hp.current, 5);
  assert.equal(Object.hasOwn(token.actorDelta, 'runtime'), false);
  assert.equal(token.hidden, true);
  assert.equal(token.elevationFt, 15);

  await fixture.api.tokens.remove('npc-one');
  assert.equal(fixture.api.tokens.get('npc-one'), null);
  assertNoCharacterProjection(fixture.current());
  assert.equal(fixture.current().preferences.entitySystem.tokens.length, 0);
});

test('WorldSystem import wrapper preserves extra import arguments', () => {
  const fixture = apiFixture();
  fixture.api.importState(fixture.api.getState(), false, 'remote-snapshot');
  const importEvent = fixture.events.find(event => event[0] === 'import');
  assert.deepEqual(importEvent, ['import', false, 'remote-snapshot']);
});
