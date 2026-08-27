import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatuses } from '../src/status/model.js';
import { createTokenStatusBridgeSystem } from '../src/token/status-bridge.js';

function baseActor() {
  return {
    id: 'actor-template',
    name: '士兵模板',
    currentFormId: 'form-1',
    forms: [{ id: 'form-1', resourceBases: { hp: { baseMax: 10 } } }],
    runtime: {
      resources: { hp: { current: 10, maxOverride: null } },
      health: { mode: 'simple' },
    },
    effects: [],
  };
}

function fixture({ synthetic = true } = {}) {
  const actor = baseActor();
  const token = {
    id: 'npc-1', characterId: 'npc-1', actorId: actor.id,
    actorLink: !synthetic, actorDelta: null, effects: [],
  };
  const entityState = {
    schemaVersion: 3,
    statusDefinitions: [],
    actors: [actor],
    tokens: [token],
  };
  const api = {
    getState() { return { preferences: { entitySystem: structuredClone(entityState) } }; },
    tokens: {
      resolveActor() {
        if (!synthetic) return { token, baseActor: actor, actor: structuredClone(actor), synthetic: false };
        return {
          token,
          baseActor: actor,
          synthetic: true,
          actor: {
            ...structuredClone(actor),
            effects: [{
              id: 'effect-rooted-instance', definitionId: 'status-rooted',
              stacks: 1, enabled: true,
            }],
          },
        };
      },
    },
    status: {
      resolve(context = {}) { return resolveStatuses(entityState, context); },
      resolveStatuses(context = {}) { return resolveStatuses(entityState, context); },
      resolveCapabilities(context = {}) { return resolveStatuses(entityState, context).capabilities; },
      has(context = {}, definitionId) {
        return resolveStatuses(entityState, context).statuses.some(status => status.definitionId === definitionId);
      },
    },
    emit() {},
  };
  createTokenStatusBridgeSystem().register(api);
  return api;
}

test('unlinked Token resolves Actor-level effects from its Synthetic Actor only', () => {
  const api = fixture({ synthetic: true });
  const tokenSnapshot = api.status.resolve({ tokenId: 'npc-1' });
  assert.equal(tokenSnapshot.actorStatuses.some(status => status.definitionId === 'status-rooted'), true);
  assert.equal(tokenSnapshot.capabilities.canMove, false);
  assert.equal(api.status.has({ tokenId: 'npc-1' }, 'status-rooted'), true);

  const templateSnapshot = api.status.resolve({ actorId: 'actor-template' });
  assert.equal(templateSnapshot.actorStatuses.some(status => status.definitionId === 'status-rooted'), false);
});

test('linked Token keeps the existing Base Actor status resolution path', () => {
  const api = fixture({ synthetic: false });
  const snapshot = api.status.resolve({ tokenId: 'npc-1' });
  assert.equal(snapshot.actorStatuses.some(status => status.definitionId === 'status-rooted'), false);
  assert.notEqual(snapshot.capabilities.canMove, false);
});
