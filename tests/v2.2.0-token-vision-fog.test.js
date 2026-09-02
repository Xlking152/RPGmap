import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorFromRulesetImport, deriveActorDocument } from '../src/actor/index.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { reduceStatusOperation } from '../src/status/model.js';
import { resolveTokenActor } from '../src/token/actor.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { resolveLiveAudienceVision } from '../src/vision/system.js';
import {
  exploreFogCircle,
  exploreFogSweep,
  hideFogCircle,
  isFogCellExplored,
  resetFogParty,
} from '../src/vision/fog.js';
import { migrateWorldSchema3State } from '../src/world/migration.js';
import { normalizeWorldV2 } from '../src/world/model.js';
import { applyWorldOperations } from '../src/world/operations.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: 'Test Map', width: 500, height: 500 };

function actor({ id, name = id, type = 'pc', partyId = 'party-default', health = 10, perception = null } = {}) {
  return createActorFromRulesetImport({
    formName: 'Default',
    identity: { name },
    resources: { hp: { max: health }, stamina: { max: 5 }, willpower: { max: 5 } },
    attributes: perception === null ? [] : [{ id: 'perception', name: 'Perception', base: perception }],
    checks: { skills: [], saves: [] },
    badStatuses: [],
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: '#334455', scale: 1 },
    source: { type: 'manual' },
  }, {
    id,
    name,
    type,
    partyId,
    variantId: `${id}-form`,
    variantName: 'Default',
    ruleset: infiniteHorrorRuleset,
  });
}

function token({ id, actorId, actorLink = true, x = 10, y = 10, controllerUserIds = [], visibility = null, actorDelta } = {}) {
  return {
    id,
    actorId,
    actorLink,
    ...(actorDelta === undefined ? {} : { actorDelta }),
    placement: 'map',
    x,
    y,
    featureId: null,
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    controllerUserIds,
    ...(visibility ? { visibility } : {}),
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
    locked: false,
    showName: true,
    effects: [],
  };
}

function state({ actors, tokens, markers = [] } = {}) {
  const world = normalizeWorldV2({
    schemaVersion: 3,
    id: 'world-test',
    name: 'Test World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-a',
    actors,
    statusDefinitions: [],
    scenes: [{
      id: 'scene-a',
      name: 'Scene A',
      mapPackage: { id: mapPackage.id, version: mapPackage.version },
      tokens,
      markers,
      attackAreas: [],
      sceneEvents: [],
      featureStates: {},
      fog: {},
      settings: { gridVisible: true },
    }],
  }, { mapPackage, ruleset: infiniteHorrorRuleset });
  return {
    saveVersion: 2,
    mapId: mapPackage.id,
    mapVersion: mapPackage.version,
    markers: structuredClone(world.scenes[0].markers),
    attackAreas: [],
    sceneEvents: [],
    preferences: {
      worldV2: world,
      entitySystem: {
        schemaVersion: 3,
        actors: structuredClone(world.actors),
        tokens: structuredClone(world.scenes[0].tokens),
        statusDefinitions: structuredClone(world.statusDefinitions),
      },
    },
  };
}

function apply(current, operations) {
  return applyWorldOperations(current, operations, {
    ruleset: infiniteHorrorRuleset,
    mapMetrics: { metersPerUnit: 1, width: 500, height: 500 },
    now: '2026-01-01T00:00:00.000Z',
  }).state;
}

function tokenHealth(current, tokenId) {
  const resolved = resolveTokenActor(current.preferences.worldV2, tokenId, { ruleset: infiniteHorrorRuleset });
  return deriveActorDocument(resolved.actor, { ruleset: infiniteHorrorRuleset }).health;
}

test('World schema 2 migration is idempotent and preserves linkage and extensions', () => {
  const original = {
    saveVersion: 2,
    preferences: {
      worldV2: {
        schemaVersion: 2,
        id: 'legacy-world',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-a',
        actors: [{ id: 'actor-a', name: 'Legacy', system: {}, customActorField: { retained: true } }],
        statusDefinitions: [],
        scenes: [{
          id: 'scene-a', mapPackage: { id: 'map-a', version: '1' },
          tokens: [{ id: 'token-a', actorId: 'actor-a', actorLink: true, hidden: true, customTokenField: 7 }],
          markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: {}, customSceneField: 'kept',
        }],
      },
    },
  };

  const first = migrateWorldSchema3State(original);
  const world = first.state.preferences.worldV2;
  assert.equal(first.migrated, true);
  assert.equal(world.schemaVersion, 3);
  assert.equal(world.actors[0].type, 'pc');
  assert.equal(world.actors[0].partyId, 'party-default');
  assert.deepEqual(world.actors[0].customActorField, { retained: true });
  assert.equal(world.scenes[0].tokens[0].actorLink, true);
  assert.equal(world.scenes[0].tokens[0].hidden, undefined);
  assert.equal(world.scenes[0].tokens[0].visibility.mode, 'gm');
  assert.equal(world.scenes[0].tokens[0].customTokenField, 7);
  assert.equal(world.scenes[0].customSceneField, 'kept');
  assert.deepEqual(world.scenes[0].fog, { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} });

  const second = migrateWorldSchema3State(first.state);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.state, first.state);
});

test('Infinite Horror describes bounded vision without exposing private storage to Core', () => {
  const fallback = actor({ id: 'fallback', perception: null });
  const normal = actor({ id: 'normal', perception: 5 });
  const high = actor({ id: 'high', perception: 20 });
  assert.equal(infiniteHorrorRuleset.vision.describe(fallback).rangeMeters, 40);
  assert.equal(infiniteHorrorRuleset.vision.describe(normal).rangeMeters, 80);
  assert.equal(infiniteHorrorRuleset.vision.describe(high).rangeMeters, 120);
  assert.equal(infiniteHorrorRuleset.actor.instances.supported, true);
});

test('live audience vision follows the latest authoritative Token coordinates and clears invalid sources', () => {
  const audience = {
    source: { tokenId: 'scout', x: 10, y: 10, preciseRangeMeters: 15, vagueRangeMeters: 30 },
    partyIds: ['party-a'],
  };
  const scene = { tokens: [{ id: 'scout', placement: 'map', x: 45, y: 60 }] };
  assert.deepEqual(resolveLiveAudienceVision(audience, scene, 'scout').source, {
    tokenId: 'scout', x: 45, y: 60, preciseRangeMeters: 15, vagueRangeMeters: 30,
  });
  assert.equal(resolveLiveAudienceVision(audience, { tokens: [] }, 'scout').source, null);
  assert.equal(resolveLiveAudienceVision(audience, scene, null).source, null);
  assert.equal(resolveLiveAudienceVision(audience, {
    tokens: [{ id: 'scout', placement: 'feature', x: 45, y: 60 }],
  }, 'scout').source, null);
});

test('monster Tokens use independent runtime state and reject linked placement', () => {
  const template = actor({ id: 'monster-template', type: 'monster', partyId: null, health: 14 });
  let current = state({
    actors: [template],
    tokens: [
      token({ id: 'monster-a', actorId: template.id, actorLink: false }),
      token({ id: 'monster-b', actorId: template.id, actorLink: false, x: 20 }),
    ],
  });
  current = apply(current, [{
    type: 'actor.runtime.perform',
    payload: { sceneId: 'scene-a', tokenId: 'monster-a', operation: { type: 'health.damage', amount: 4 } },
  }]);
  assert.equal(tokenHealth(current, 'monster-a').current, 10);
  assert.equal(tokenHealth(current, 'monster-b').current, 14);
  assert.throws(() => apply(current, [{
    type: 'token.create',
    payload: { sceneId: 'scene-a', token: token({ id: 'linked-monster', actorId: template.id, actorLink: true }) },
  }]), error => error?.code === 'instance_link_forbidden');
});

test('two NPC Tokens keep runtime Health independent and actorId-only mutation is rejected', () => {
  const template = actor({ id: 'npc-template', type: 'npc', partyId: null, health: 10 });
  let current = state({
    actors: [template],
    tokens: [
      token({ id: 'npc-a', actorId: template.id, actorLink: false, actorDelta: infiniteHorrorRuleset.actor.instances.createDelta(template) }),
      token({ id: 'npc-b', actorId: template.id, actorLink: false, x: 20, actorDelta: infiniteHorrorRuleset.actor.instances.createDelta(template) }),
    ],
  });

  current = apply(current, [{
    type: 'actor.runtime.perform',
    payload: { sceneId: 'scene-a', tokenId: 'npc-a', operation: { type: 'health.damage', amount: 3, damageType: 'L' } },
  }]);
  assert.equal(tokenHealth(current, 'npc-a').current, 7);
  assert.equal(tokenHealth(current, 'npc-b').current, 10);
  assert.equal(deriveActorDocument(current.preferences.worldV2.actors[0], { ruleset: infiniteHorrorRuleset }).health.current, 10);
  assert.ok(current.preferences.worldV2.scenes[0].tokens[0].actorDelta.system.currentFormId);
  assert.ok(current.preferences.worldV2.scenes[0].tokens[0].actorDelta.system.runtime);
  assert.deepEqual(current.preferences.worldV2.scenes[0].tokens[0].actorDelta.effects, []);

  assert.throws(() => apply(current, [{
    type: 'actor.runtime.perform',
    payload: { actorId: template.id, operation: { type: 'health.damage', amount: 1 } },
  }]), error => error?.code === 'instance_target_required');

  assert.throws(() => apply(current, [{
    type: 'token.create',
    payload: { sceneId: 'scene-a', token: token({ id: 'forged', actorId: template.id, actorLink: true }) },
  }]), error => error?.code === 'instance_link_forbidden');
});

test('NPC statuses require Synthetic Actor targets and remain isolated per Token', () => {
  const template = actor({ id: 'npc-template', type: 'npc', partyId: null });
  const entity = {
    schemaVersion: 3,
    actors: [template],
    tokens: [
      token({ id: 'npc-a', actorId: template.id, actorLink: false }),
      token({ id: 'npc-b', actorId: template.id, actorLink: false, x: 20 }),
    ],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
  };
  assert.throws(() => reduceStatusOperation(entity, {
    type: 'status.apply', scope: 'actor', targetId: template.id,
    definitionId: 'status-invisible',
  }), error => error?.code === 'instance_target_required');

  const applied = reduceStatusOperation(entity, {
    type: 'status.apply', scope: 'syntheticActor', targetId: 'npc-a',
    definitionId: 'status-invisible',
  });
  assert.equal(applied.state.tokens[0].actorDelta.effects[0].definitionId, 'status-invisible');
  assert.deepEqual(applied.state.tokens[1].actorDelta?.effects || [], []);
  assert.deepEqual(applied.state.actors[0].effects || [], []);
});

test('template changes rebase instance data, cap Health, and protect in-use variants', () => {
  const template = actor({ id: 'npc-template', type: 'npc', partyId: null, health: 10 });
  let current = state({ actors: [template], tokens: [token({ id: 'npc-a', actorId: template.id, actorLink: false })] });
  current = apply(current, [{
    type: 'actor.runtime.perform',
    payload: { sceneId: 'scene-a', tokenId: 'npc-a', operation: { type: 'health.damage', amount: 2 } },
  }]);
  current.preferences.worldV2.scenes[0].tokens[0].actorDelta.customExtension = { kept: true };
  const reduced = structuredClone(current.preferences.worldV2.actors[0]);
  reduced.system.forms[0].healthBase.baseMax = 5;
  reduced.notes = 'template changed';
  current = apply(current, [{ type: 'actor.upsert', payload: { actor: reduced } }]);
  assert.equal(tokenHealth(current, 'npc-a').max, 5);
  assert.equal(tokenHealth(current, 'npc-a').current, 5);
  assert.deepEqual(current.preferences.worldV2.scenes[0].tokens[0].actorDelta.customExtension, { kept: true });

  const withVariant = structuredClone(current.preferences.worldV2.actors[0]);
  const extra = { ...structuredClone(withVariant.system.forms[0]), id: 'form-extra', name: 'Extra' };
  withVariant.system.forms.push(extra);
  current = apply(current, [{ type: 'actor.upsert', payload: { actor: withVariant } }]);
  current.preferences.worldV2.scenes[0].tokens[0].actorDelta.system.currentFormId = 'form-extra';
  const withoutVariant = structuredClone(withVariant);
  withoutVariant.system.forms = withoutVariant.system.forms.filter(form => form.id !== 'form-extra');
  assert.throws(() => apply(current, [{ type: 'actor.upsert', payload: { actor: withoutVariant } }]),
    error => error?.code === 'variant_in_use');
});

test('Audience projection removes hostile private data and invisible or GM-only entities', () => {
  const scout = actor({ id: 'pc-scout', type: 'pc', partyId: 'party-a', perception: 5 });
  const hostile = actor({ id: 'npc-hostile', type: 'npc', partyId: 'party-b' });
  const invisible = actor({ id: 'npc-invisible', type: 'npc', partyId: 'party-b' });
  const alliedInvisible = actor({ id: 'summon-invisible', type: 'summon', partyId: 'party-a' });
  const secret = actor({ id: 'npc-secret', type: 'npc', partyId: null });
  const hostileDelta = infiniteHorrorRuleset.actor.instances.createDelta(hostile);
  const invisibleDelta = infiniteHorrorRuleset.actor.instances.createDelta(invisible);
  invisibleDelta.effects = [{ id: 'effect-invisible', definitionId: 'status-invisible', stacks: 1, enabled: true }];
  const alliedInvisibleDelta = infiniteHorrorRuleset.actor.instances.createDelta(alliedInvisible);
  alliedInvisibleDelta.effects = [{ id: 'effect-allied-invisible', definitionId: 'status-invisible', stacks: 1, enabled: true }];
  const current = state({
    actors: [scout, hostile, invisible, alliedInvisible, secret],
    tokens: [
      token({ id: 'scout-token', actorId: scout.id, x: 10, y: 10 }),
      token({ id: 'hostile-token', actorId: hostile.id, actorLink: false, x: 20, y: 10, actorDelta: hostileDelta, visibility: { mode: 'public', userIds: [] } }),
      token({ id: 'invisible-token', actorId: invisible.id, actorLink: false, x: 25, y: 10, actorDelta: invisibleDelta, visibility: { mode: 'public', userIds: [] } }),
      token({ id: 'allied-invisible-token', actorId: alliedInvisible.id, actorLink: false, x: 30, y: 10, actorDelta: alliedInvisibleDelta, visibility: { mode: 'party', userIds: [] } }),
      token({ id: 'secret-token', actorId: secret.id, actorLink: false, x: 15, y: 10, visibility: { mode: 'gm', userIds: ['player-a'] } }),
    ],
  });
  const context = {
    role: 'player',
    userId: 'player-a',
    user: { id: 'player-a', ownership: { [scout.id]: 'owner' } },
    visionSourceTokenId: 'scout-token',
    ruleset: infiniteHorrorRuleset,
    mapMetrics: { metersPerUnit: 1 },
  };
  const projected = projectStateForAudience(current, context);
  const projectedWorld = projected.preferences.worldV2;
  assert.deepEqual(projectedWorld.scenes[0].tokens.map(item => item.id).sort(), ['allied-invisible-token', 'hostile-token', 'scout-token']);
  const projectedHostile = projectedWorld.actors.find(item => item.id === hostile.id);
  assert.equal(projectedHostile.audienceRestricted, true);
  assert.deepEqual(projectedHostile.system, {});
  assert.deepEqual(projectedWorld.scenes[0].tokens.find(item => item.id === 'hostile-token').effects, []);
  assert.equal(projectedWorld.scenes[0].tokens.some(item => item.id === 'invisible-token'), false);
  assert.equal(projectedWorld.scenes[0].tokens.some(item => item.id === 'secret-token'), false);
  assert.equal(projectedWorld.scenes[0].tokens.find(item => item.id === 'allied-invisible-token').audienceVisibility, 'allied-invisible');

  const gm = projectStateForAudience(current, { role: 'gm', userId: 'gm', ruleset: infiniteHorrorRuleset });
  assert.equal(gm.preferences.worldV2.scenes[0].tokens.length, 5);
  assert.ok(gm.preferences.worldV2.actors.find(item => item.id === hostile.id).system.forms.length);
});

test('vague detection projects only an anonymous quantized outline without canonical references', () => {
  const scout = actor({ id: 'pc-vague-scout', type: 'pc', partyId: 'party-a' });
  scout.system.forms[0].detection = {
    configured: true, preciseRangeMeters: 20, vagueRangeMeters: 100,
    senses: { trueSight: false, xrayVision: false, spiritSight: false, lowLightVision: false, darkvision: false },
  };
  const hostile = actor({ id: 'npc-vague-hostile', name: 'Secret Horror', type: 'npc', partyId: 'party-b' });
  const current = state({
    actors: [scout, hostile],
    tokens: [
      token({ id: 'vague-scout-token', actorId: scout.id, x: 10, y: 10 }),
      token({ id: 'canonical-hostile-token', actorId: hostile.id, actorLink: false, x: 53, y: 12,
        actorDelta: infiniteHorrorRuleset.actor.instances.createDelta(hostile), visibility: { mode: 'public', userIds: [] } }),
    ],
  });
  current.preferences.combatSystem = { combat: {
    state: 'active', turnIndex: 0, combatants: [{ tokenId: 'canonical-hostile-token', actorId: hostile.id }],
  } };
  current.preferences.chatSystem = { messages: [{ id: 'secret-chat', data: { tokenId: 'canonical-hostile-token' }, text: 'leak' }] };
  current.preferences.worldV2.scenes[0].attackAreas = [{ id: 'secret-area', anchor: { type: 'token', tokenId: 'canonical-hostile-token' } }];
  const projected = projectStateForAudience(current, {
    role: 'player', userId: 'player-a',
    user: { id: 'player-a', ownership: { [scout.id]: 'owner' } },
    visionSourceTokenId: 'vague-scout-token', ruleset: infiniteHorrorRuleset,
    mapMetrics: { metersPerUnit: 1 },
  });
  const projectedWorld = projected.preferences.worldV2;
  const outline = projectedWorld.scenes[0].tokens.find(item => item.audienceVisibility === 'vague');
  assert.ok(outline);
  assert.notEqual(outline.id, 'canonical-hostile-token');
  assert.notEqual(outline.actorId, hostile.id);
  assert.equal(outline.showName, false);
  assert.equal(outline.texture.src, null);
  assert.equal(outline.x % 5, 0);
  assert.equal(projectedWorld.actors.some(item => item.id === hostile.id), false);
  assert.equal(projectedWorld.actors.find(item => item.id === outline.actorId).name, '模糊轮廓');
  assert.equal(projected.preferences.combatSystem.combat, null);
  assert.deepEqual(projected.preferences.chatSystem.messages, []);
  assert.deepEqual(projectedWorld.scenes[0].attackAreas, []);
});

test('controlling one NPC does not grant visibility to its entire hostile party', () => {
  const controlled = actor({ id: 'npc-controlled', type: 'npc', partyId: 'hostile-party' });
  const sibling = actor({ id: 'npc-sibling', type: 'npc', partyId: 'hostile-party' });
  const current = state({
    actors: [controlled, sibling],
    tokens: [
      token({
        id: 'controlled-token', actorId: controlled.id, actorLink: false,
        controllerUserIds: ['player-a'], visibility: { mode: 'public', userIds: [] },
      }),
      token({
        id: 'party-token', actorId: sibling.id, actorLink: false, x: 20,
        visibility: { mode: 'party', userIds: [] },
      }),
    ],
  });

  const projected = projectStateForAudience(current, {
    role: 'player', userId: 'player-a', user: { id: 'player-a', ownership: {} },
    ruleset: infiniteHorrorRuleset, mapMetrics: { metersPerUnit: 1 },
  });
  const tokenIds = projected.preferences.worldV2.scenes[0].tokens.map(item => item.id);
  assert.deepEqual(tokenIds, ['controlled-token']);
});

test('placement grants expose only a restricted Actor template catalog entry', () => {
  const template = actor({ id: 'granted-npc', name: 'Granted NPC', type: 'npc', partyId: null });
  const current = state({ actors: [template], tokens: [] });
  const projected = projectStateForAudience(current, {
    role: 'player', userId: 'player-a',
    user: {
      id: 'player-a', ownership: {},
      placementGrants: { actorTypes: [], actorIds: ['granted-npc'], markerKinds: [] },
    },
    ruleset: infiniteHorrorRuleset, mapMetrics: { metersPerUnit: 1 },
  });
  const entry = projected.preferences.worldV2.actors.find(item => item.id === 'granted-npc');
  assert.equal(entry.type, 'npc');
  assert.equal(entry.audienceRestricted, true);
  assert.deepEqual(entry.system, {});
  assert.deepEqual(entry.effects, []);
});

test('LIMITED ownership exposes only the legal Actor summary', () => {
  const template = actor({ id: 'limited-npc', name: 'Limited NPC', type: 'npc', partyId: null });
  template.notes = 'private notes';
  const projected = projectStateForAudience(state({ actors: [template], tokens: [] }), {
    role: 'player', userId: 'player-limited',
    user: { id: 'player-limited', ownership: { 'limited-npc': 'limited' } },
    ruleset: infiniteHorrorRuleset,
  });
  const entry = projected.preferences.worldV2.actors.find(item => item.id === 'limited-npc');
  assert.equal(entry.audienceRestricted, true);
  assert.equal(entry.name, 'Limited NPC');
  assert.deepEqual(entry.system, {});
  assert.equal(entry.notes, undefined);
});

test('public and party Markers do not disclose controller or explicit-user access lists', () => {
  const pc = actor({ id: 'actor-a', partyId: 'party-default' });
  const source = state({ actors: [pc], tokens: [token({ id: 'token-a', actorId: pc.id })], markers: [{
    id: 'marker-public', kind: 'target', name: 'Target', x: 5, y: 5,
    controllerUserIds: ['user-owner'],
    visibility: { mode: 'public', userIds: ['user-explicit'] },
    extension: { preserved: true },
  }, {
    id: 'marker-party', kind: 'note', name: 'Party note', x: 6, y: 5,
    partyId: 'party-default', controllerUserIds: ['user-owner'],
    visibility: { mode: 'party', userIds: ['user-explicit'] },
  }] });
  const projected = projectStateForAudience(source, {
    role: 'player', userId: 'user-viewer',
    user: { ownership: { 'actor-a': 'owner' }, placementGrants: {} },
    ruleset: infiniteHorrorRuleset,
  });
  for (const marker of projected.preferences.worldV2.scenes[0].markers) {
    assert.deepEqual(marker.controllerUserIds, []);
    assert.deepEqual(marker.visibility.userIds, []);
  }
  assert.equal(projected.preferences.worldV2.scenes[0].markers[0].extension.preserved, true);
});

test('5 metre fog rows merge sweeps, share by party, and support hide/reset', () => {
  let fog = exploreFogCircle({}, 'party-a', { x: 10, y: 10, radiusMeters: 6 }, {
    metersPerUnit: 1, width: 100, height: 100,
  });
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 10, y: 10 }), true);
  assert.equal(isFogCellExplored(fog, 'party-b', { x: 10, y: 10 }), false);
  fog = exploreFogSweep(fog, 'party-a', { x: 10, y: 10 }, { x: 40, y: 10 }, 6, {
    metersPerUnit: 1, width: 100, height: 100,
  });
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 35, y: 10 }), true);
  fog = hideFogCircle(fog, 'party-a', { x: 40, y: 10, radiusMeters: 8 }, {
    metersPerUnit: 1, width: 100, height: 100,
  });
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 40, y: 10 }), false);
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 10, y: 10 }), true);
  fog = resetFogParty(fog, 'party-a');
  assert.deepEqual(fog.exploredByParty, {});
});

test('fog operations remain isolated between Scenes during activation changes', () => {
  const scout = actor({ id: 'scout', type: 'pc', partyId: 'party-a' });
  let current = state({ actors: [scout], tokens: [token({ id: 'scout-a', actorId: scout.id })] });
  const world = current.preferences.worldV2;
  world.scenes.push({
    ...structuredClone(world.scenes[0]),
    id: 'scene-b', name: 'Scene B',
    tokens: [token({ id: 'scout-b', actorId: scout.id, x: 50, y: 50 })],
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
  });

  current = apply(current, [{
    type: 'scene.fog.explore',
    payload: { sceneId: 'scene-b', partyId: 'party-a', x: 50, y: 50, radiusMeters: 20 },
  }]);
  assert.deepEqual(current.preferences.worldV2.scenes[0].fog.exploredByParty, {});
  assert.ok(Object.keys(current.preferences.worldV2.scenes[1].fog.exploredByParty['party-a'].rows).length > 0);

  current = apply(current, [{ type: 'scene.activate', payload: { sceneId: 'scene-b' } }]);
  assert.equal(current.preferences.worldV2.activeSceneId, 'scene-b');
  assert.ok(Object.keys(current.preferences.worldV2.scenes[1].fog.exploredByParty['party-a'].rows).length > 0);
});
