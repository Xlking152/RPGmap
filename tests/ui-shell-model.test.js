import test from 'node:test';
import assert from 'node:assert/strict';
import { entityStateFromApp, findSelectedEntity, isMovementStatus, selectionStatus } from '../src/ui/model.js';

test('entityStateFromApp falls back to the current Entity schema', () => {
  assert.deepEqual(entityStateFromApp({ preferences: {} }), { schemaVersion: 3, actors: [], tokens: [] });
});

test('findSelectedEntity resolves canonical Token, Actor and Form without Character backing', () => {
  const app = {
    preferences: { entitySystem: {
      actors: [{ id: 'a1', name: '银', currentFormId: 'f2', forms: [{ id: 'f1', name: '变身前' }, { id: 'f2', name: '变身后' }] }],
      tokens: [{ id: 't1', actorId: 'a1', locked: true, placement: 'map', x: 10, y: 20 }],
    } },
    characters: [],
  };
  const selection = findSelectedEntity(app, 't1');
  assert.equal(selection.actor.name, '银');
  assert.equal(selection.form.name, '变身后');
  assert.equal(selection.token.x, 10);
  assert.equal(selection.character, undefined);
  assert.equal(selectionStatus(selection), '银 · 变身后 · 已锁定');
});

test('movement status detection only activates the contextual HUD during Token movement', () => {
  assert.equal(isMovementStatus('路线已就绪 · 65 m · 确认移动 / Enter，Esc 取消'), true);
  assert.equal(isMovementStatus('移动吸附 20 m · 滚轮继续切档'), true);
  assert.equal(isMovementStatus('浏览模式：拖动地图'), false);
});
