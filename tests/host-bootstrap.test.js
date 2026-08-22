import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHostLaunchUrl } from '../deployment/local-server/launcher.mjs';
import {
  createMultiplayerHostBootstrapSystem,
  parseHostBootstrap,
} from '../src/multiplayer/host-bootstrap.js';

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
