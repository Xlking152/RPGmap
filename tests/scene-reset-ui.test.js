import test from 'node:test';
import assert from 'node:assert/strict';
import { resetCurrentScene } from '../src/ui/scene-reset.js';

function fixture(role = 'gm') {
  const calls = [];
  const api = {
    multiplayer: { getStatus: () => ({ connected: true, session: { role } }) },
    world: { getActiveScene: () => ({ id: 'current', name: '地图' }),
      performOperations: async (...args) => calls.push(args) },
    showToast: (...args) => calls.push(args),
  };
  return { api, calls };
}

test('reset confirmation cancellation does not submit or report success', async () => {
  const { api, calls } = fixture();
  assert.equal(await resetCurrentScene(api, () => false), false);
  assert.deepEqual(calls, []);
});

test('reset submits only the selected Scene and reports success after acknowledgement', async () => {
  const { api, calls } = fixture();
  assert.equal(await resetCurrentScene(api, message => message.includes('保留角色卡')), true);
  assert.deepEqual(calls[0][0], [{ type: 'scene.reset', payload: { sceneId: 'current' } }]);
  assert.equal(calls[1][1], 'success');
});

test('reset denies players before confirmation and surfaces server failure without success', async () => {
  const player = fixture('player');
  await assert.rejects(resetCurrentScene(player.api, () => { throw new Error('must not prompt'); }), /只有 GM/);
  assert.deepEqual(player.calls, []);
  const gm = fixture();
  gm.api.world.performOperations = async () => { throw new Error('connection lost'); };
  await assert.rejects(resetCurrentScene(gm.api, () => true), /connection lost/);
  assert.deepEqual(gm.calls, []);
});
