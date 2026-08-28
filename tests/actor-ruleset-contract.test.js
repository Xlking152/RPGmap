import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeActor,
  describeActorSheet,
  listActorAttributePaths,
  normalizeActorDocument,
  performActorOperation,
  resolveActorAttribute,
  validateActorDocument,
} from '../src/actor/index.js';
import { addEffect, resolveActor } from '../src/entities/resolver.js';
import { normalizeEntityState } from '../src/entities/model.js';
import { normalizeWorldV2 } from '../src/world/model.js';
import { resolveTokenActor } from '../src/token/actor.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function legacyActor() {
  return {
    id: 'actor-legacy',
    name: '旧角色',
    currentFormId: 'form-legacy',
    forms: [{
      id: 'form-legacy',
      name: '旧形态',
      avatarDataUrl: 'data:image/png;base64,AAAA',
      resourceBases: {
        hp: { id: 'hp', name: '生命', kind: 'hp', baseMax: 12 },
        stamina: { id: 'stamina', name: '精力', kind: 'stamina', baseMax: 6 },
        willpower: { id: 'willpower', name: '意志', kind: 'willpower', baseMax: 4 },
      },
      attributes: [{ id: 'strength', name: '力量', base: 5 }],
      checks: { skills: [], saves: [] },
      badStatuses: [{ id: 'bad-status-32', name: '冻结点数', light: 2, severe: 4, destruction: 6 }],
      combat: { attacks: [], defenses: [] },
      tokenAppearance: { color: '#123456', scale: 1 },
      source: { type: 'xlsx' },
    }],
    runtime: {
      resources: {
        hp: { current: 7, maxOverride: null, policy: 'preserve' },
        stamina: { current: 5, maxOverride: null, policy: 'preserve' },
        willpower: { current: 4, maxOverride: null, policy: 'preserve' },
      },
      customResources: [{ id: 'focus', name: '专注', current: 2, max: 3 }],
      attributeAdjustments: { strength: 1 },
      badStatuses: { 'bad-status-32': 3 },
      health: { mode: 'wound-track', wounds: { bashing: 2, lethal: 2, aggravated: 1 } },
    },
    effects: [{
      id: 'effect-old',
      name: '旧加成',
      enabled: true,
      changes: [{ target: 'resources.hp.max', mode: 'add', value: 2 }],
    }],
    notes: '保留笔记',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

test('Infinite Horror migrates legacy HP runtime into the generic Actor shell without dual authority', () => {
  const state = normalizeEntityState({
    schemaVersion: 3,
    statusDefinitions: [{ id: 'custom-status', name: '自定义状态', scopes: ['actor'], changes: [], builtIn: false }],
    actors: [legacyActor()],
    tokens: [{ id: 'token-legacy', actorId: 'actor-legacy', actorLink: true, effects: [] }],
  });
  const actor = state.actors[0];
  assert.deepEqual(Object.keys(actor).sort(), [
    'createdAt', 'effects', 'id', 'name', 'notes', 'system', 'updatedAt',
  ]);
  assert.equal(Object.hasOwn(actor, 'forms'), false);
  assert.equal(Object.hasOwn(actor, 'runtime'), false);
  assert.equal(actor.system.currentFormId, 'form-legacy');
  assert.equal(actor.system.runtime.customResources[0].id, 'focus');
  assert.equal(actor.system.runtime.badStatuses['bad-status-32'], 3);
  assert.equal(actor.system.runtime.resources.hp, undefined);
  assert.equal(actor.effects[0].id, 'effect-old');
  assert.equal(state.statusDefinitions[0].id, 'custom-status');
  assert.equal(state.tokens[0].actorId, actor.id);

  const derived = resolveActor(actor);
  assert.equal(derived.health.bashing, 2);
  assert.equal(derived.health.lethal, 2);
  assert.equal(derived.health.aggravated, 1);
  assert.equal(derived.resources.find(item => item.id === 'hp').max, 14);
  assert.equal(derived.attributes.find(item => item.id === 'strength').value, 6);
  assert.equal(derived.badStatuses[0].current, 3);
  assert.deepEqual(validateActorDocument(actor), []);
});

test('Actor presentation and legacy HP paths resolve through Ruleset Health Runtime', () => {
  const actor = normalizeActorDocument(legacyActor());
  const presentation = describeActor(actor);
  const sheet = describeActorSheet(actor);
  assert.equal(presentation.variantLabel, '旧形态');
  assert.equal(presentation.color, '#123456');
  assert.ok(sheet.tabs.some(tab => tab.id === 'bad-status'));
  assert.ok(listActorAttributePaths(actor).some(item => item.path === 'system.resources.hp.current'));
  assert.equal(resolveActorAttribute(actor, 'system.attributes.strength'), 6);

  performActorOperation(actor, { type: 'health.set-mode', mode: 'simple' });
  const operation = performActorOperation(actor, {
    type: 'resource.set-current',
    resourceId: 'hp',
    value: 4,
  });
  assert.equal(operation.changed, true);
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.current'), 4);
  assert.equal(actor.system.runtime.health.current, 4);
  assert.equal(actor.system.runtime.resources.hp, undefined);

  const effect = addEffect(actor, {
    changes: [{ target: 'resources.hp.max', mode: 'add', value: 3 }],
  });
  assert.equal(effect.changes[0].target, 'system.resources.hp.max');
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.max'), 17);
});

test('legacy wound Health wins over a stale resource-only Synthetic Actor HP mirror', () => {
  const world = normalizeWorldV2({
    schemaVersion: 2,
    id: 'world-test',
    name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [legacyActor()],
    statusDefinitions: [],
    activeSceneId: 'scene-test',
    scenes: [{
      id: 'scene-test',
      name: 'Scene',
      mapPackage: { id: 'test-map', version: '1' },
      tokens: [{
        id: 'token-synthetic',
        actorId: 'actor-legacy',
        actorLink: false,
        actorDelta: { runtime: { resources: { hp: { current: 3 } } } },
        placement: 'map', x: 1, y: 2,
      }],
    }],
  }, {
    mapPackage: { id: 'test-map', version: '1' },
    ruleset: infiniteHorrorRuleset,
  });
  const token = world.scenes[0].tokens[0];
  assert.equal(Object.hasOwn(token.actorDelta, 'runtime'), false);
  assert.equal(token.actorDelta.system?.runtime?.resources?.hp, undefined);
  const resolved = resolveTokenActor(world, token.id);
  assert.equal(resolveActor(resolved.actor).health.current, 7);
  assert.equal(resolveActor(resolved.baseActor).health.current, 7);
});

test('Core Actor consumers do not read Infinite Horror legacy storage fields', async () => {
  const roots = [path.join(repositoryRoot, 'src'), path.join(repositoryRoot, 'deployment', 'local-server')];
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (target.includes(`${path.sep}src${path.sep}rulesets${path.sep}`)) continue;
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
    }
  }
  for (const root of roots) await visit(root);
  const forbidden = [
    /actor\??\.(?:forms|currentFormId|runtime)\b/,
    /actor\?\.runtime\b/,
    /actorDelta\??\.(?:forms|currentFormId|runtime)\b/,
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, path.relative(repositoryRoot, file));
  }
});
