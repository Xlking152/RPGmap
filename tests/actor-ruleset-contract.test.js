import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listActorAttributePaths,
  performActorOperation,
  resolveActorAttribute,
  resolveActor,
} from '../src/entities/resolver.js';
import { normalizeEntityState } from '../src/entities/model.js';
import { resolveActorEffects } from '../src/status/model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function liveJavaScriptFiles(relativeRoot) {
  const files = [];
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (/\.(?:js|mjs)$/.test(name)) files.push(absolute);
    }
  };
  visit(path.join(ROOT, relativeRoot));
  return files;
}

function legacyActor() {
  return {
    id: 'actor-legacy',
    name: '旧角色',
    currentFormId: 'form-legacy',
    forms: [{
      id: 'form-legacy',
      name: '默认形态',
      avatarDataUrl: 'data:image/png;base64,LEGACY',
      identity: { name: '旧角色' },
      resourceBases: {
        hp: { id: 'hp', name: '生命', baseMax: 12 },
        stamina: { id: 'stamina', name: '精力', baseMax: 5 },
      },
      attributes: [{ id: 'strength', name: '力量', base: 10 }],
      checks: { skills: [], saves: [] },
      badStatuses: [],
      combat: { attacks: [], defenses: [] },
      tokenAppearance: { color: '#334455', scale: 1 },
      source: { type: 'manual' },
    }],
    runtime: {
      resources: {
        hp: { current: 8, maxOverride: null, policy: 'preserve' },
        stamina: { current: 4, maxOverride: null, policy: 'preserve' },
      },
      customResources: [{ id: 'focus', name: '专注', baseMax: 3, current: 2, maxOverride: null, policy: 'preserve' }],
      attributeAdjustments: { strength: 2 },
      badStatuses: { 'bad-status-32': 3 },
      health: {
        mode: 'wound-track',
        maxOverride: null,
        wounds: { bashing: 2, lethal: 1, aggravated: 0 },
      },
    },
    effects: [{
      id: 'effect-old', definitionId: 'custom-status', stacks: 1, enabled: true,
      changes: [{ target: 'attributes.strength', mode: 'add', value: 1 }],
    }],
  };
}

function normalizedLegacyState() {
  return normalizeEntityState({
    schemaVersion: 2,
    statusDefinitions: [{ id: 'custom-status', name: '自定义状态', scopes: ['actor'], changes: [], builtIn: false }],
    actors: [legacyActor()],
    tokens: [{ id: 'token-legacy', actorId: 'actor-legacy', actorLink: true, effects: [] }],
  });
}

function actorContext(state, actor) {
  return { effects: resolveActorEffects(actor, state.statusDefinitions) };
}

test('Infinite Horror migrates legacy HP base/runtime into independent Health data', () => {
  const state = normalizedLegacyState();
  const actor = state.actors[0];
  assert.deepEqual(Object.keys(actor).sort(), [
    'createdAt', 'effects', 'id', 'img', 'name', 'notes', 'prototypeToken', 'system', 'updatedAt',
  ]);
  assert.equal(actor.img, 'data:image/png;base64,LEGACY');
  assert.equal(actor.prototypeToken.texture.src, actor.img);
  assert.equal(actor.prototypeToken.color, '#334455');
  assert.equal(Object.hasOwn(actor, 'forms'), false);
  assert.equal(Object.hasOwn(actor, 'runtime'), false);
  assert.equal(actor.system.currentFormId, 'form-legacy');
  assert.equal(actor.system.runtime.customResources[0].id, 'focus');
  assert.equal(actor.system.runtime.badStatuses['bad-status-32'], 3);
  assert.equal(actor.system.runtime.resources.hp, undefined);
  assert.equal(actor.system.forms[0].resourceBases.hp, undefined);
  assert.equal(actor.system.forms[0].healthBase.baseMax, 12);
  assert.equal(actor.effects[0].id, 'effect-old');
  assert.equal('changes' in actor.effects[0], false);
  assert.equal(state.statusDefinitions[0].id, 'custom-status');
  assert.equal(state.tokens[0].actorId, actor.id);

  const derived = resolveActor(actor, actorContext(state, actor));
  assert.equal(derived.health.bashing, 2);
  assert.equal(derived.health.lethal, 1);
  assert.equal(derived.health.current, 9);
  assert.equal(derived.health.max, 12);
  assert.equal(derived.health.mode, 'wound-track');
  assert.equal(derived.resources.find(resource => resource.id === 'stamina')?.current, 4);
  assert.equal(derived.resources.find(resource => resource.id === 'focus')?.current, 2);
});

test('Actor presentation exposes canonical Health paths and Resource operations cannot mutate HP', () => {
  const state = normalizedLegacyState();
  const actor = state.actors[0];
  const context = actorContext(state, actor);
  const paths = listActorAttributePaths(actor);
  const listed = new Set(paths.map(entry => entry.path));
  assert.equal(listed.has('system.health.max'), true);
  assert.equal(listed.has('system.health.current'), false);
  assert.equal(listed.has('system.resources.hp.max'), false);
  assert.equal(listed.has('system.resources.hp.current'), false);
  assert.equal(resolveActorAttribute(actor, 'system.health.max', context), 12);
  assert.equal(resolveActorAttribute(actor, 'system.health.current', context), 9);
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.max', context), 12);
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.current', context), null);

  const directSet = performActorOperation(actor, { type: 'resource.set-current', resourceId: 'hp', value: 1 }, context);
  const directMax = performActorOperation(actor, { type: 'resource.set-max', resourceId: 'hp', value: 99 }, context);
  const custom = performActorOperation(actor, { type: 'resource.add-custom', resourceId: 'hp', name: '假生命', max: 99 }, context);
  assert.equal(directSet.changed, false);
  assert.equal(directSet.blocked, 'health_is_not_resource');
  assert.equal(directMax.changed, false);
  assert.equal(directMax.blocked, 'health_is_not_resource');
  assert.equal(custom.changed, false);
  assert.equal(custom.blocked, 'reserved_resource_id');
});

test('legacy wound Health wins over a stale resource-only Synthetic Actor HP mirror', () => {
  const state = normalizedLegacyState();
  const actor = state.actors[0];
  actor.system.runtime.resources.hp = { current: 1, maxOverride: 4 };
  actor.system.runtime.health = {
    mode: 'wound-track',
    maxOverride: null,
    wounds: { bashing: 2, lethal: 1, aggravated: 0 },
  };
  const normalized = normalizeEntityState({
    schemaVersion: 3,
    statusDefinitions: state.statusDefinitions,
    actors: [actor],
    tokens: state.tokens,
  });
  const migrated = normalized.actors[0];
  assert.equal(migrated.system.runtime.resources.hp, undefined);
  assert.equal(migrated.system.runtime.health.maxOverride, null);
  assert.deepEqual(migrated.system.runtime.health.wounds, { bashing: 2, lethal: 1, aggravated: 0 });
  assert.equal(resolveActor(migrated, actorContext(normalized, migrated)).health.current, 9);
});

test('retired Health/Resource bridges are physically absent from live source', () => {
  const healthDir = path.join(ROOT, 'src/health');
  assert.equal(readdirSync(healthDir).includes('actor.js'), false);
  const entityIndex = readFileSync(path.join(ROOT, 'src/entities/index.js'), 'utf8');
  const actorSource = readFileSync(path.join(ROOT, 'src/rulesets/infinite-horror/actor.js'), 'utf8');
  assert.doesNotMatch(entityIndex, /addEffect/);
  assert.doesNotMatch(actorSource, /resource\.set-current[\s\S]{0,500}resourceId:\s*['"]hp['"]/);
});

test('Core Actor consumers do not read Infinite Horror legacy storage fields', () => {
  const offenders = [];
  for (const relativeRoot of ['src/actor', 'src/health', 'src/render', 'src/token']) {
    for (const file of liveJavaScriptFiles(relativeRoot)) {
      const source = readFileSync(file, 'utf8');
      if (/runtime\.resources\.hp|resourceBases\.hp/.test(source)) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});
