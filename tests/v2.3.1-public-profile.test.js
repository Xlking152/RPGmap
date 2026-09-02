import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeActorDocument } from '../src/actor/model.js';
import { normalizeActorPublicProfile } from '../src/actor/public-profile.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { applyWorldOperations } from '../src/world/operations.js';

const publicDefinition = {
  id: 'burning', name: '燃烧', description: 'secret mechanics', icon: 'flame', color: '#cc4400',
  category: 'debuff', scopes: ['actor'], maxStacks: 9, changes: [], capabilities: {}, builtIn: true,
};
const privateDefinition = {
  ...publicDefinition, id: 'secret', name: '秘密状态', icon: 'eye-off', color: '#111111',
};

function actor() {
  return normalizeActorDocument({
    id: 'npc-a', name: '守卫', type: 'npc', system: { secretHp: 99 },
    publicProfile: {
      summary: '城门守卫', appearance: '红色披风', knownFacts: ['来自北门'],
      visibleStatusDefinitionIds: ['burning'],
      extension: { sourceBook: 'local' },
    },
    effects: [{ id: 'base-secret', definitionId: 'secret', enabled: true, stacks: 1 }],
  }, { ruleset: infiniteHorrorRuleset });
}

function token(id, effects) {
  return {
    id, actorId: 'npc-a', actorLink: false,
    actorDelta: { system: { secretHp: id === 'npc-1' ? 7 : 3 }, effects },
    placement: 'map', x: 10, y: 10, featureId: null, texture: { src: null }, color: '#334455',
    diameterMeters: 1, rotation: 0, elevationFt: 0, locked: false, showName: true, effects: [],
    controllerUserIds: [], visibility: { mode: 'users', userIds: ['viewer'] },
    vision: { enabled: false, preciseRangeOverrideMeters: null, vagueRangeOverrideMeters: null, overrideUserIds: [] },
  };
}

function state() {
  const actors = [actor()];
  const tokens = [
    token('npc-1', [
      { id: 'burn-1', definitionId: 'burning', enabled: true, stacks: 2, note: 'secret note' },
      { id: 'secret-1', definitionId: 'secret', enabled: true, stacks: 4 },
    ]),
    token('npc-2', [{ id: 'burn-2', definitionId: 'burning', enabled: false, stacks: 8 }]),
  ];
  return {
    preferences: {
      worldV2: {
        schemaVersion: 3, id: 'world-a', name: 'World', activeSceneId: 'scene-a',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        actors, statusDefinitions: [publicDefinition, privateDefinition],
        scenes: [{
          id: 'scene-a', name: 'Scene', mapPackage: { id: 'minimal-reference', version: '1.0.0' },
          tokens, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
          fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} }, settings: { lighting: 'normal' },
        }],
      },
      entitySystem: { schemaVersion: 4, actors, tokens, statusDefinitions: [publicDefinition, privateDefinition] },
      combatSystem: { schemaVersion: 2, combat: null }, chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

test('public profile normalization is bounded, deterministic, and keeps no implicit private description', () => {
  assert.deepEqual(normalizeActorPublicProfile(), {
    schemaVersion: 1, summary: '', appearance: '', knownFacts: [], visibleStatusDefinitionIds: [],
  });
  const profile = normalizeActorPublicProfile({
    summary: 'x'.repeat(2100), appearance: ' visible ',
    knownFacts: ['one', 'one', '', ...Array.from({ length: 30 }, (_, index) => `fact-${index}`)],
    visibleStatusDefinitionIds: ['burning', 'unknown', 'burning'],
  }, { statusDefinitionIds: ['burning'] });
  assert.equal(profile.summary.length, 2000);
  assert.equal(profile.appearance, 'visible');
  assert.equal(profile.knownFacts.length, 20);
  assert.deepEqual(profile.visibleStatusDefinitionIds, ['burning']);
  assert.deepEqual(normalizeActorPublicProfile({ summary: 'x', extension: { value: 1 } }).extension, { value: 1 });
});

test('actor.publicProfile.update filters unknown statuses and produces an Actor changeSet', () => {
  const result = applyWorldOperations(state(), [{
    type: 'actor.publicProfile.update', payload: {
      actorId: 'npc-a', publicProfile: {
        summary: '公开摘要', appearance: '', knownFacts: [],
        visibleStatusDefinitionIds: ['burning', 'missing'],
      },
    },
  }], { ruleset: infiniteHorrorRuleset, now: '2026-09-02T00:00:00.000Z' });
  assert.deepEqual(result.state.preferences.worldV2.actors[0].publicProfile.visibleStatusDefinitionIds, ['burning']);
  assert.deepEqual(result.state.preferences.worldV2.actors[0].publicProfile.extension, { sourceBook: 'local' });
  assert.deepEqual(result.changeSet.actors.upsertIds, ['npc-a']);
});

test('LIMITED projection exposes only curated profile and per-Token safe status summaries', () => {
  const projected = projectStateForAudience(state(), {
    role: 'player', userId: 'viewer', user: { id: 'viewer', ownership: {} }, mapMetrics: { metersPerUnit: 1 },
  });
  const world = projected.preferences.worldV2;
  const restrictedActor = world.actors.find(item => item.id === 'npc-a');
  const first = world.scenes[0].tokens.find(item => item.id === 'npc-1');
  const second = world.scenes[0].tokens.find(item => item.id === 'npc-2');

  assert.deepEqual(restrictedActor.publicProfile, {
    schemaVersion: 1, summary: '城门守卫', appearance: '红色披风', knownFacts: ['来自北门'],
    visibleStatusDefinitionIds: ['burning'],
  });
  assert.equal(Object.hasOwn(restrictedActor.publicProfile, 'extension'), false);
  assert.deepEqual(restrictedActor.system, {});
  assert.deepEqual(restrictedActor.effects, []);
  assert.deepEqual(first.publicStatuses, [{ name: '燃烧', icon: 'flame', color: '#cc4400', category: 'debuff', stacks: 2 }]);
  assert.deepEqual(second.publicStatuses, []);
  assert.equal(JSON.stringify(first).includes('secret note'), false);
  assert.equal(JSON.stringify(first).includes('secret-1'), false);
  assert.equal(JSON.stringify(first).includes('definitionId'), false);
  assert.deepEqual(first.actorDelta, { system: {}, effects: [] });
});
