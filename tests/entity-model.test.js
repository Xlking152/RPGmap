import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport, createTokenForActor, addFormToActor, normalizeEntityState } from '../src/entities/model.js';
import { migrateLegacyCharacters } from '../src/legacy/save-v2.js';
import { addCustomResource, addEffect, cycleActorForm, resolveActor, setAttributeAdjustment } from '../src/entities/resolver.js';
import { performActorOperation } from '../src/actor/index.js';

function imported(name, formName, hp, strength, statusLight = 4) {
  return {
    formName, identity: { name }, resources: { hp: { max: hp }, stamina: { max: 20 }, willpower: { max: 10 } },
    attributes: [{ id: 'strength', name: '力量', base: strength }], checks: { skills: [], saves: [] },
    badStatuses: [{ id: 'bad-status-32', name: '冻结点数', light: statusLight, severe: statusLight * 6, destruction: statusLight * 8 }],
    combat: { attacks: [], defenses: [] }, tokenAppearance: { color: '#3d9b63' }
  };
}

test('actor keeps Health runtime, generic resources and bad-status points while cycling forms', () => {
  const actor = createActorFromImport(imported('银', '变身前', 41, 2, 4));
  const first = actor.system.currentFormId;
  addFormToActor(actor, imported('银', '变身后', 80, 24, 22), { name: '变身后' });
  actor.system.currentFormId = first;
  performActorOperation(actor, {
    type: 'health.runtime',
    operation: { type: 'set-current', value: 27 },
  });
  performActorOperation(actor, { type: 'bad-status.set-current', statusId: 'bad-status-32', value: 10 });
  cycleActorForm(actor);
  const resolved = resolveActor(actor);
  assert.equal(resolved.form.name, '变身后');
  assert.equal(resolved.health.current, 27);
  assert.equal(resolved.health.max, 80);
  assert.equal(resolved.resources.some(item => item.id === 'hp'), false);
  assert.equal(resolved.attributes.find(item => item.id === 'strength').value, 24);
  assert.equal(resolved.badStatuses[0].current, 10);
  assert.equal(resolved.badStatuses[0].light, 22);
});

test('runtime adjustments, custom resources and effects resolve without changing form Health base', () => {
  const actor = createActorFromImport(imported('银', '变身前', 41, 2));
  setAttributeAdjustment(actor, 'strength', 3);
  addCustomResource(actor, { id: 'spiral', name: '螺旋力', current: 2, max: 3 });
  addEffect(actor, { name: '生命强化', changes: [{ target: 'health.max', mode: 'add', value: 10 }] });
  const resolved = resolveActor(actor);
  assert.equal(resolved.attributes[0].base, 2);
  assert.equal(resolved.attributes[0].value, 5);
  assert.equal(resolved.form.healthBase.baseMax, 41);
  assert.equal(resolved.health.max, 51);
  assert.equal(resolved.resources.find(item => item.id === 'spiral').current, 2);
});

test('old resistance-threshold saves migrate into bad statuses without remaining as fake saves', () => {
  const actor = createActorFromImport(imported('银', '旧形态', 41, 2));
  delete actor.system.forms[0].badStatuses;
  actor.system.forms[0].checks.saves = [
    { name:'力+敏', light:4, severe:24, devastating:32 },
    { name:'耐+决', light:5, severe:33, devastating:44 },
    { name:'力+耐', light:3, severe:21, devastating:28 },
    { name:'耐+感', light:4, severe:24, devastating:32 },
    { name:'决+沉', light:5, severe:33, devastating:44 },
    { name:'决+风', light:7, severe:42, devastating:56 },
  ];
  delete actor.system.runtime.badStatuses;
  const normalized = normalizeEntityState({ schemaVersion:1, actors:[actor], tokens:[] });
  const form = normalized.actors[0].system.forms[0];
  assert.equal(form.checks.saves.length, 0);
  assert.equal(form.badStatuses.length, 21);
  assert.equal(form.badStatuses.find(item => item.name === '流血点数').severe, 21);
  assert.equal(form.badStatuses.find(item => item.name === '魅惑点数').destruction, 56);
  assert.equal(normalized.actors[0].system.runtime.badStatuses['bad-status-32'], 0);
});

test('legacy Character migration creates one Actor plus canonical Token id once', () => {
  const character = { id: 'c1', name: '旧角色', color: '#123456', avatarDataUrl: null, location: { type: 'map', x: 1, y: 2 } };
  const first = migrateLegacyCharacters(null, [character]);
  assert.equal(first.migrated, 1);
  assert.equal(first.state.actors.length, 1);
  assert.equal(first.state.tokens[0].id, 'c1');
  assert.equal(first.state.tokens[0].characterId, undefined);
  const second = migrateLegacyCharacters(first.state, [character]);
  assert.equal(second.migrated, 0);
});

test('empty or malformed character cards normalize before actor creation and produce safe canonical Token references', () => {
  const emptyActor = createActorFromImport();
  assert.equal(emptyActor.name, '未命名角色');
  assert.equal(emptyActor.system.forms[0].name, '默认形态');
  assert.equal(emptyActor.system.forms[0].healthBase.baseMax, 0);
  assert.equal(emptyActor.system.forms[0].resourceBases.hp, undefined);
  const token = createTokenForActor(emptyActor.id, 'empty-token');
  assert.equal(token.actorId, emptyActor.id);
  assert.equal(token.id, 'empty-token');
  assert.equal(token.characterId, undefined);

  const malformedActor = createActorFromImport({
    identity: null,
    resources: null,
    attributes: null,
    checks: null,
    badStatuses: null,
    combat: null,
    tokenAppearance: null,
    source: null,
  });
  assert.equal(malformedActor.name, '未命名角色');
  assert.equal(malformedActor.system.forms[0].tokenAppearance.color, '#3d9b63');
  assert.equal(malformedActor.system.forms[0].healthBase.baseMax, 0);
  assert.equal(malformedActor.system.forms[0].resourceBases.willpower.baseMax, 0);
});
