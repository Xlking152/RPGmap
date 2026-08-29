import test from 'node:test';
import assert from 'node:assert/strict';

import { readServerWorldBootstrap, readWorldBootstrap } from '../src/world/bootstrap.js';

const defaultRuleset = { id: 'infinite-horror', version: '1.0.0' };

function modernState() {
  return {
    preferences: {
      worldV2: {
        schemaVersion: 2,
        id: 'world-a',
        name: '测试 World',
        ruleset: defaultRuleset,
        activeSceneId: 'scene-b',
        actors: [],
        statusDefinitions: [],
        scenes: [
          { id: 'scene-a', name: 'A', mapPackage: { id: 'map-a', version: '1' }, tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {} },
          { id: 'scene-b', name: 'B', mapPackage: { id: 'map-b', version: '2' }, tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {} },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

test('local World bootstrap exposes Ruleset and Active Scene MapPackage before Runtime creation', () => {
  const bootstrap = readWorldBootstrap(modernState(), { defaultRuleset });
  assert.equal(bootstrap.kind, 'world-v2');
  assert.equal(bootstrap.worldId, 'world-a');
  assert.equal(bootstrap.worldName, '测试 World');
  assert.equal(bootstrap.activeSceneId, 'scene-b');
  assert.deepEqual(bootstrap.mapPackage, { id: 'map-b', version: '2' });
  assert.deepEqual(bootstrap.ruleset, defaultRuleset);
});

test('server World bootstrap exposes the same pre-Runtime MapPackage contract', () => {
  const bootstrap = readServerWorldBootstrap({
    initialized: true,
    kind: 'world-v2',
    schemaVersion: 2,
    worldId: 'server-world',
    name: 'LAN World',
    activeSceneId: 'scene-b',
    mapPackage: { id: 'map-b', version: '2' },
    ruleset: defaultRuleset,
  }, { defaultRuleset });
  assert.equal(bootstrap.remote, true);
  assert.equal(bootstrap.worldId, 'server-world');
  assert.deepEqual(bootstrap.mapPackage, { id: 'map-b', version: '2' });
});
