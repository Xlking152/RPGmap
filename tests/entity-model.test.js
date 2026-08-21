import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport, addFormToActor, migrateLegacyCharacters } from '../src/entities/model.js';
import { addCustomResource, addEffect, cycleActorForm, resolveActor, setAttributeAdjustment, setResourceCurrent } from '../src/entities/resolver.js';

function imported(name, formName, hp, strength) {
  return {
    formName, identity: { name }, resources: { hp: { max: hp }, stamina: { max: 20 }, willpower: { max: 10 } },
    attributes: [{ id: 'strength', name: '力量', base: strength }], checks: { skills: [], saves: [] }, combat: { attacks: [], defenses: [] }, tokenAppearance: { color: '#3d9b63' }
  };
}

test('actor keeps runtime resources while cycling forms', () => {
  const actor = createActorFromImport(imported('银', '变身前', 41, 2));
  const first = actor.currentFormId;
  addFormToActor(actor, imported('银', '变身后', 80, 24), { name: '变身后' });
  actor.currentFormId = first;
  setResourceCurrent(actor, 'hp', 27);
  cycleActorForm(actor);
  const resolved = resolveActor(actor);
  assert.equal(resolved.form.name, '变身后');
  assert.equal(resolved.resources.find(item => item.id === 'hp').current, 27);
  assert.equal(resolved.resources.find(item => item.id === 'hp').max, 80);
  assert.equal(resolved.attributes.find(item => item.id === 'strength').value, 24);
});

test('runtime adjustments, custom resources and effects resolve without changing form base', () => {
  const actor = createActorFromImport(imported('银', '变身前', 41, 2));
  setAttributeAdjustment(actor, 'strength', 3);
  addCustomResource(actor, { id: 'spiral', name: '螺旋力', current: 2, max: 3 });
  addEffect(actor, { name: '生命强化', changes: [{ target: 'resources.hp.max', mode: 'add', value: 10 }] });
  const resolved = resolveActor(actor);
  assert.equal(resolved.attributes[0].base, 2);
  assert.equal(resolved.attributes[0].value, 5);
  assert.equal(resolved.resources.find(item => item.id === 'hp').baseMax, 41);
  assert.equal(resolved.resources.find(item => item.id === 'hp').max, 51);
  assert.equal(resolved.resources.find(item => item.id === 'spiral').current, 2);
});

test('legacy characters migrate to actor plus token once', () => {
  const character = { id: 'c1', name: '旧角色', color: '#123456', avatarDataUrl: null, location: { type: 'map', x: 1, y: 2 } };
  const first = migrateLegacyCharacters(null, [character]);
  assert.equal(first.migrated, 1);
  assert.equal(first.state.actors.length, 1);
  assert.equal(first.state.tokens[0].characterId, 'c1');
  const second = migrateLegacyCharacters(first.state, [character]);
  assert.equal(second.migrated, 0);
});
