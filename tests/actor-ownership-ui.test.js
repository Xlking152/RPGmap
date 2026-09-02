import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  actorOwnershipCatalogReady,
  actorOwnershipRows,
  buildActorOwnershipChanges,
} from '../src/multiplayer/actor-ownership-ui.js';

const access = {
  canManage: true,
  actors: [{ id: 'actor-a', name: 'Actor A' }],
  users: [
    {
      id: 'player-a',
      name: 'Alice',
      online: true,
      defaultActorId: 'actor-a',
      ownership: { 'actor-a': 'owner' },
    },
    {
      id: 'player-b',
      name: 'Bob',
      online: false,
      defaultActorId: null,
      ownership: { 'actor-a': 'observer' },
    },
    {
      id: 'player-c',
      name: 'Carol',
      disabled: true,
      defaultActorId: null,
      ownership: {},
    },
  ],
};

test('actorOwnershipRows presents one Actor across all persistent Player users', () => {
  assert.deepEqual(actorOwnershipRows(access, 'actor-a'), [
    {
      userId: 'player-a', name: 'Alice', online: true, disabled: false,
      defaultActor: true, level: 'owner',
    },
    {
      userId: 'player-b', name: 'Bob', online: false, disabled: false,
      defaultActor: false, level: 'observer',
    },
    {
      userId: 'player-c', name: 'Carol', online: false, disabled: true,
      defaultActor: false, level: 'none',
    },
  ]);
});

test('default Actor stays OWNER while other users can change through four access levels', () => {
  const changes = buildActorOwnershipChanges(access, 'actor-a', {
    'player-a': 'none',
    'player-b': 'limited',
    'player-c': 'owner',
  });
  assert.deepEqual(changes, [
    { userId: 'player-b', actorId: 'actor-a', level: 'limited' },
    { userId: 'player-c', actorId: 'actor-a', level: 'owner' },
  ]);
});

test('new Actor ownership cannot save until the server access catalog contains that Actor', () => {
  assert.equal(actorOwnershipCatalogReady(access, 'actor-a'), true);
  assert.equal(actorOwnershipCatalogReady({ ...access, actors: [] }, 'actor-a'), false);
  assert.equal(actorOwnershipCatalogReady(access, 'missing'), false);
});

test('actor ownership UI keeps Token visibility/control semantics separate', () => {
  const source = readFileSync(new URL('../src/multiplayer/actor-ownership-ui.js', import.meta.url), 'utf8');
  assert.match(source, /Token 的地图可见性/);
  assert.match(source, /controllerUserIds/);
  assert.match(source, /data-mp-actor-permission/);
  assert.match(source, /actorOwnershipCatalogReady/);
  assert.doesNotMatch(source, /controllerUserIds\s*=/);
  assert.doesNotMatch(source, /visibility\.userIds\s*=/);
});

test('multiplayer system registers actor-centric ownership UI after the canonical controller', () => {
  const source = readFileSync(new URL('../src/multiplayer/index.js', import.meta.url), 'utf8');
  const controllerRegister = source.indexOf('controller.register(api)');
  const ownershipRegister = source.indexOf('actorOwnershipUi.register(api)');
  assert.ok(controllerRegister >= 0);
  assert.ok(ownershipRegister > controllerRegister);
});
