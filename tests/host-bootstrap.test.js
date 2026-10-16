import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHostLaunchUrl } from '../deployment/local-server/launcher.mjs';
import {
  createMultiplayerHostBootstrapSystem,
  parseHostBootstrap,
} from '../src/multiplayer/host-bootstrap.js';
import { stageSceneReloadConnection, consumeSceneReloadConnection, clearSceneReloadConnection } from '../src/multiplayer/session.js';

function tabStorage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
}

test('host launch URL keeps GM bootstrap in a localhost hash fragment', () => {
  const url = buildHostLaunchUrl({ port: 30000, gmSecret: 'FEDCBA9876543210' });
  assert.match(url, /^http:\/\/127\.0\.0\.1:30000\/#/);
  assert.doesNotMatch(url, /\?gmSecret=/);
  const hash = new URL(url).hash;
  assert.deepEqual(parseHostBootstrap(hash), {
    name: 'GM',
    requestedRole: 'gm',
    gmSecret: 'FEDCBA9876543210',
  });
});

test('host bootstrap clears the secret hash and auto-connects localhost as GM', async () => {
  const calls = [];
  const replaced = [];
  const windowNode = {
    location: {
      hostname: '127.0.0.1',
      pathname: '/',
      search: '',
      hash: '#rpgmap-host=1&gmSecret=A1B2C3D4E5F60708',
    },
    history: {
      replaceState(_state, _title, url) { replaced.push(url); },
    },
  };
  const api = {
    map: {
      getContainer() { return { ownerDocument: { defaultView: windowNode } }; },
    },
    multiplayer: {
      connect(options) { calls.push(options); },
    },
  };

  createMultiplayerHostBootstrapSystem().register(api);
  await Promise.resolve();

  assert.deepEqual(replaced, ['/']);
  assert.deepEqual(calls, [{
    name: 'GM',
    requestedRole: 'gm',
    gmSecret: 'A1B2C3D4E5F60708',
  }]);
});

test('host bootstrap never auto-connects from a non-local URL', async () => {
  const calls = [];
  const windowNode = {
    location: {
      hostname: 'example.trycloudflare.com',
      pathname: '/',
      search: '',
      hash: '#rpgmap-host=1&gmSecret=A1B2C3D4E5F60708',
    },
    history: { replaceState() { throw new Error('must not consume remote hash'); } },
  };
  const api = {
    map: {
      getContainer() { return { ownerDocument: { defaultView: windowNode } }; },
    },
    multiplayer: {
      connect(options) { calls.push(options); },
    },
  };

  createMultiplayerHostBootstrapSystem().register(api);
  await Promise.resolve();
  assert.deepEqual(calls, []);
});

test('Scene reload reconnects the same World once, for localhost GM and remote Player', async () => {
  for (const role of ['gm', 'player']) {
    const storage = tabStorage(), calls = [], options = { name: role, requestedRole: role, joinCode: 'join',
      gmSecret: role === 'gm' ? 'secret' : '', playerKey: role === 'player' ? 'claim' : '' };
    assert.equal(stageSceneReloadConnection(storage, 'world', options), true);
    const api = { world: { get: () => ({ id: 'world' }) }, map: { getContainer: () => ({ ownerDocument: { defaultView: {
      sessionStorage: storage, location: { hostname: role === 'gm' ? '127.0.0.1' : 'game.example', hash: '' },
      history: { replaceState() { throw new Error('reload must not add credentials to history'); } },
    } } }) }, multiplayer: { connect: options => calls.push(options) } };
    createMultiplayerHostBootstrapSystem().register(api);
    await Promise.resolve();
    assert.deepEqual(calls, [options]);
    createMultiplayerHostBootstrapSystem().register(api);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(storage.data.size, 0);
  }
});

test('reload credentials cannot cross Worlds, outlive the switch, elevate a remote GM, or survive disconnect', () => {
  const cases = [ ['other', true, 100], ['world', false, 100], ['world', true, 120101], ['world', true, 99] ];
  for (const [world, local, now] of cases) {
    const storage = tabStorage();
    stageSceneReloadConnection(storage, 'world', { name: 'GM', requestedRole: 'gm', gmSecret: 'secret' }, 100);
    assert.equal(consumeSceneReloadConnection(storage, world, local, now), null);
    assert.equal(storage.data.size, 0);
  }
  const storage = tabStorage();
  stageSceneReloadConnection(storage, 'world', { requestedRole: 'player' });
  clearSceneReloadConnection(storage);
  assert.equal(consumeSceneReloadConnection(storage, 'world', true), null);
  assert.equal(stageSceneReloadConnection(null, 'world', { requestedRole: 'player' }), false);
  assert.equal(consumeSceneReloadConnection(null, 'world', true), null);
});
