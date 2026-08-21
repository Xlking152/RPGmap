import test from 'node:test';
import assert from 'node:assert/strict';
import { entityStateFromApp, findSelectedEntity, isMovementStatus, selectionStatus } from '../src/ui/model.js';

test('entityStateFromApp falls back cleanly without Entity System data', () => {
  assert.deepEqual(entityStateFromApp({ preferences: {} }), { schemaVersion: 1, actors: [], tokens: [] });
});

test('findSelectedEntity resolves Actor, Form and backing Token character', () => {
  const app = {
    preferences: { entitySystem: {
      actors: [{ id: 'a1', name: '银', currentFormId: 'f2', forms: [{ id: 'f1', name: '变身前' }, { id: 'f2', name: '变身后' }] }],
      tokens: [{ id: 't1', characterId: 'c1', actorId: 'a1', locked: true }],
    } },
    characters: [{ id: 'c1', name: '银', location: { type: 'map', x: 10, y: 20 } }],
  };
  const selection = findSelectedEntity(app, 'c1');
  assert.equal(selection.actor.name, '银');
  assert.equal(selection.form.name, '变身后');
  assert.equal(selection.character.location.x, 10);
  assert.equal(selectionStatus(selection), '银 · 变身后 · 已锁定');
});

test('movement status detection only activates the contextual HUD during movement', () => {
  assert.equal(isMovementStatus('路线已就绪 · 65 m · 确认移动 / Enter，Esc 取消'), true);
  assert.equal(isMovementStatus('移动吸附 20 m · 滚轮继续切档'), true);
  assert.equal(isMovementStatus('浏览模式：拖动地图'), false);
});
