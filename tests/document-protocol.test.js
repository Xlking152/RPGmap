import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_OPERATION_SCHEMA_VERSION,
  assertDocumentBatchMessage,
  createDocumentChanges,
  documentWritesToWorldOperations,
  worldOperationsToDocumentWrites,
} from '../src/documents/protocol.js';
import {
  WORLD_OPERATION_SCHEMA_VERSION,
  applyWorldOperationPatch,
  applyWorldOperations,
  createWorldOperationPatch,
} from '../src/world/operations.js';

function state() {
  const actor = { id: 'actor-a', name: 'Actor A', type: 'pc', system: {}, effects: [], notes: '' };
  const token = {
    id: 'token-a', actorId: actor.id, actorLink: true, actorDelta: null,
    placement: 'map', x: 10, y: 20, featureId: null, texture: null, color: '#ffffff',
    diameterMeters: 1, rotation: 0, elevationFt: 0, locked: false, showName: true,
    effects: [], controllerUserIds: [], visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, rangeOverrideMeters: null, overrideUserIds: [] },
  };
  const world = {
    schemaVersion: 3, id: 'world-a', name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' }, activeSceneId: 'scene-a',
    actors: [actor], statusDefinitions: [],
    scenes: [{
      id: 'scene-a', name: 'Scene', mapPackage: { id: 'unknown-test-map', version: '1.0.0' },
      tokens: [token], markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
      settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    version: 2, mapId: 'unknown-test-map', mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 3, actors: structuredClone(world.actors), tokens: structuredClone(world.scenes[0].tokens), statusDefinitions: [] },
      combatSystem: { schemaVersion: 2, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

function moveWrite() {
  return {
    action: 'move',
    document: { type: 'Token', id: 'token-a', parent: { type: 'Scene', id: 'scene-a' } },
    intent: 'token.movePath',
    data: { tokenIds: ['token-a'], waypoints: [{ x: 12, y: 22 }, { x: 15, y: 25 }], method: 'drag' },
    precondition: { expectedOrigins: { 'token-a': { x: 10, y: 20 } } },
  };
}

test('Document Operation Protocol 4 rejects mismatched schemas and unsafe intents', () => {
  assert.equal(DOCUMENT_OPERATION_SCHEMA_VERSION, 4);
  assert.equal(WORLD_OPERATION_SCHEMA_VERSION, 4);
  assert.throws(() => assertDocumentBatchMessage({
    type: 'document.batch', operationSchema: 2, operationId: 'op-a', baseRevision: 0, writes: [moveWrite()],
  }), error => error.code === 'operation_schema_incompatible');
  assert.throws(() => assertDocumentBatchMessage({
    type: 'document.batch', operationSchema: 4, operationId: 'op-a', baseRevision: 0,
    writes: [{ ...moveWrite(), intent: 'token.arbitraryJsonPatch' }],
  }), error => error.code === 'unknown_document_intent');
});

test('Actor Document deletion requires explicit referenced Token deletion semantics', () => {
  assert.throws(() => documentWritesToWorldOperations([{
    action: 'delete',
    document: { type: 'Actor', id: 'actor-a', parent: null },
    intent: 'actor.delete',
    data: {},
  }]), error => error.code === 'actor_delete_confirmation_required');
  assert.deepEqual(documentWritesToWorldOperations([{
    action: 'delete',
    document: { type: 'Actor', id: 'actor-a', parent: null },
    intent: 'actor.delete',
    data: { deleteReferencedTokens: true },
  }]), [{ type: 'actor.delete', payload: { actorId: 'actor-a', deleteReferencedTokens: true } }]);
});

test('Document address must match the intent type, payload id and Scene parent', () => {
  assert.throws(() => documentWritesToWorldOperations([{ ...moveWrite(), data: { ...moveWrite().data, tokenId: 'other' } }]), error => error.code === 'document_target_mismatch');
  assert.throws(() => documentWritesToWorldOperations([{ ...moveWrite(), data: { ...moveWrite().data, sceneId: 'other' } }]), error => error.code === 'document_target_mismatch');
  assert.throws(() => documentWritesToWorldOperations([{ ...moveWrite(), intent: 'actor.delete', data: { actorId: 'actor-a', deleteReferencedTokens: true } }]), error => error.code === 'document_target_mismatch');
  assert.throws(() => documentWritesToWorldOperations([{ ...moveWrite(), data: JSON.parse('{"constructor":{"prototype":{}}}') }]), error => error.code === 'invalid_document_operation');
});

test('Existing World callers are encoded as addressed Document writes without changing reducer semantics', () => {
  const operations = [
    { type: 'token.move', payload: { sceneId: 'scene-a', tokenId: 'token-a', x: 20, y: 30 } },
    { type: 'actor.runtime.perform', payload: { sceneId: 'scene-a', tokenId: 'token-a', operation: { type: 'variant.cycle', direction: 1 } } },
    { type: 'marker.upsert', payload: { sceneId: 'scene-a', marker: { id: 'marker', x: 10, y: 10 } } },
    { type: 'scene.featureState.patch', payload: { sceneId: 'scene-a', featureId: 'door', patch: { open: true } } },
    { type: 'chat.append', payload: { text: 'hello' } },
    { type: 'status.batch', payload: { operations: [{ type: 'status.remove', scope: 'actor', targetId: 'actor-a', statusId: 'custom' }] } },
  ];
  const writes = worldOperationsToDocumentWrites(operations, { worldId: 'world-a', sceneId: 'scene-a' });
  const roundTrip = documentWritesToWorldOperations(writes);
  for (let index = 0; index < operations.length; index += 1) {
    assert.equal(roundTrip[index].type, operations[index].type);
    for (const [key, value] of Object.entries(operations[index].payload)) assert.deepEqual(roundTrip[index].payload[key], value);
  }
  assert.equal(writes[1].document.type, 'Token');
  assert.equal(writes[1].document.id, 'token-a');
});

test('Token Document move becomes one atomic path operation with preconditions', () => {
  const [operation] = documentWritesToWorldOperations([moveWrite()]);
  assert.equal(operation.type, 'token.movePath');
  assert.deepEqual(operation.payload.expectedOrigins, { 'token-a': { x: 10, y: 20 } });
  const applied = applyWorldOperations(state(), [operation], {
    now: '2026-01-02T00:00:00.000Z', mapMetrics: { width: 100, height: 100 },
  });
  const token = applied.state.preferences.worldV2.scenes[0].tokens[0];
  assert.deepEqual({ x: token.x, y: token.y }, { x: 15, y: 25 });
  assert.deepEqual(applied.results[0].motion[0].waypoints, [{ x: 12, y: 22 }, { x: 15, y: 25 }]);
  assert.deepEqual(applied.changeSet.tokens, [{ sceneId: 'scene-a', upsertIds: ['token-a'], removeIds: [] }]);
});

test('Token path precondition conflict rejects without mutating the source state', () => {
  const initial = state();
  const operation = documentWritesToWorldOperations([{ ...moveWrite(), precondition: {
    expectedOrigins: { 'token-a': { x: 9, y: 20 } },
  } }])[0];
  assert.throws(
    () => applyWorldOperations(initial, [operation]),
    error => error.code === 'entity_conflict' && error.conflictIds?.[0] === 'token-a',
  );
  assert.deepEqual(
    { x: initial.preferences.worldV2.scenes[0].tokens[0].x, y: initial.preferences.worldV2.scenes[0].tokens[0].y },
    { x: 10, y: 20 },
  );
});

test('Document changes contain only changed Token fields and preserve move semantics', () => {
  const before = state();
  const applied = applyWorldOperations(before, documentWritesToWorldOperations([moveWrite()]), {
    now: '2026-01-02T00:00:00.000Z',
  });
  const patch = createWorldOperationPatch(before, applied.state);
  const motion = applied.results.flatMap(result => result.motion || []);
  const changes = createDocumentChanges(before, applied.state, patch, { motion });
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].document, {
    type: 'Token', id: 'token-a', parent: { type: 'Scene', id: 'scene-a' },
  });
  assert.equal(changes[0].action, 'move');
  assert.deepEqual(changes[0].changed, { x: 15, y: 25 });
  assert.equal(Object.hasOwn(changes[0], 'state'), false);
});

test('authoritative chat append patches do not replace existing chat history', () => {
  const initial = state();
  initial.preferences.chatSystem.messages.push({ id: 'chat-old', kind: 'message', text: 'old' });
  const message = { id: 'chat-new', kind: 'message', text: 'new' };
  const applied = applyWorldOperationPatch(initial, {
    schemaVersion: WORLD_OPERATION_SCHEMA_VERSION,
    world: { updatedAt: '2026-01-02T00:00:00.000Z' },
    chatAppend: [message],
  });
  assert.deepEqual(applied.preferences.chatSystem.messages, [
    { id: 'chat-old', kind: 'message', text: 'old' },
    message,
  ]);
  assert.deepEqual(initial.preferences.chatSystem.messages, [{ id: 'chat-old', kind: 'message', text: 'old' }]);
});

test('Legacy WAL patch schema is accepted only at an explicitly versioned replay boundary', () => {
  const before = state();
  const after = structuredClone(before);
  after.preferences.worldV2.actors[0].name = 'replayed';
  const patch = { ...createWorldOperationPatch(before, after), schemaVersion: 3 };
  assert.throws(() => applyWorldOperationPatch(before, patch), /schema/i);
  const applied = applyWorldOperationPatch(before, patch, { acceptedSchemaVersions: [3, WORLD_OPERATION_SCHEMA_VERSION] });
  assert.equal(applied.preferences.worldV2.actors[0].name, 'replayed');
  assert.throws(() => applyWorldOperationPatch(before, { ...patch, schemaVersion: 99 }, { acceptedSchemaVersions: [3, WORLD_OPERATION_SCHEMA_VERSION] }), /schema/i);
});
