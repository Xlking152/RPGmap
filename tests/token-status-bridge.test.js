import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStatuses } from '../src/status/model.js';
import { createTokenStatusBridgeSystem } from '../src/token/status-bridge.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

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
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
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

test('linked status reads avoid Actor preparation but recheck the current Token on each call', () => {
  let linked = true, prepared = 0;
  const token = { id: 't', actorId: 'a' };
  const api = {
    tokens: {
      get: () => ({ ...token, actorLink: linked }),
      resolveActor: () => { prepared++; return { synthetic: false }; },
    },
    status: { resolve: context => ({ tokenId: context.tokenId, capabilities: { canInteract: false } }) },
  };
  createTokenStatusBridgeSystem().register(api);
  assert.equal(api.status.resolve({ tokenId: 't' }).capabilities.canInteract, false);
  assert.equal(prepared, 0);
  linked = false;
  api.status.resolve({ tokenId: 't' });
  assert.equal(prepared, 1);
});

test('unknown or failed Token lookup preserves the resolver fallback', () => {
  for (const get of [() => null, () => { throw new Error('lookup failed'); }]) {
    let prepared = 0;
    const api = { tokens: { get, resolveActor: () => { prepared++; throw new Error('unknown'); } },
      status: { resolve: () => ({ statuses: [], capabilities: { canMove: false } }) } };
    createTokenStatusBridgeSystem().register(api);
    assert.equal(api.status.resolve({ tokenId: 'missing' }).capabilities.canMove, false);
    assert.equal(prepared, 1);
  }
});

test('synthetic status reads copy only the private Entity view and keep authority unchanged', () => {
  const api = fixture();
  const state = api.getState();
  const before = structuredClone(state);
  const off = registerRuntimeStateReader(api, () => state);
  api.getState = () => { throw new Error('full World copies are unnecessary'); };
  try {
    const snapshot = api.status.resolve({ tokenId: 'npc-1' });
    assert.equal(snapshot.capabilities.canMove, false);
    assert.deepEqual(state, before);
  } finally { off(); }
});
