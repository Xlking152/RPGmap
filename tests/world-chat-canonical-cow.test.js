import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldOperations, applyWorldOperationsAsync } from '../src/world/operations.js';
import { reduceStatusOperation } from '../src/status/model.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const now = '2026-10-04T10:00:00.000Z';
const worldOf = state => state.preferences.worldV2;
const append = text => ({ type: 'chat.append', payload: { text } });
const clear = { type: 'chat.clear', payload: {} };
const move = { type: 'token.move', payload: { sceneId: 'scene-a', tokenId: 'token-a', x: 30, y: 40 } };
const status = { type: 'status.apply', payload: { scope: 'actor', targetId: 'actor-a', statusId: 'focused' } };

function fixture(messageCount = 1) {
  const actors = ['a', 'b'].map(id => ({ id: `actor-${id}`, name: id, type: 'pc', partyId: `party-${id}`,
    system: { privateNotes: `secret-${id}` }, effects: [] }));
  const tokens = actors.map((actor, index) => ({ id: `token-${index ? 'b' : 'a'}`, actorId: actor.id,
    actorLink: true, actorDelta: null, placement: 'map', x: 10 + index, y: 20, featureId: null,
    diameterMeters: 1, elevationMeters: 0, rotation: 0, effects: [], hidden: false, locked: false, showName: true }));
  const definition = { id: 'focused', name: 'Focused', category: 'neutral', scopes: ['actor', 'token'],
    maxStacks: 1, changes: [], capabilities: {} };
  return migrateTestStateToWorldV3({ markers: [], attackAreas: [], sceneEvents: [], preferences: {
    worldV2: { schemaVersion: 2, id: 'world-chat-cow', name: 'Chat',
      ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene-a', actors,
      statusDefinitions: [definition], scenes: ['a', 'b'].map((id, index) => ({ id: `scene-${id}`, name: id,
        mapPackage: { id: 'map', version: '1' }, tokens: index ? [] : tokens,
        markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: { gridVisible: true },
        fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } })),
      createdAt: now, updatedAt: now },
    chatSystem: { schemaVersion: 1, custom: { preserve: true }, messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `old-${index}`, type: 'chat', text: `old message ${index}`, createdAt: now,
      sender: { id: 'user', role: 'player', name: 'Player' }, data: { nested: { index } },
    })) },
  } });
}

function context(validate = null, extra = {}) {
  let sequence = 0;
  return { now, source: { role: 'gm' }, sender: { id: 'gm', name: 'GM', role: 'gm' },
    randomId: () => `new-${sequence++}`, idFactory: () => `effect-${sequence++}`,
    ...(validate ? { isCanonicalData: validate.isImmutableData } : {}), ...extra };
}

function setup(messageCount = 1) {
  const before = fixture(messageCount), validate = createCanonicalWorldValidator();
  validate(before);
  assert.equal(validate.isImmutableData(before), true);
  return { before, validate };
}

function checked(before, validate, operations, extra = {}) {
  const beforeJson = JSON.stringify(before);
  // Without the new server proof, a batch containing chat still executes the
  // original complete structuredClone transaction path.
  const expected = applyWorldOperations(before, operations, context(null, extra));
  const actual = applyWorldOperations(before, operations, context(validate, extra));
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(before), beforeJson);
  return actual;
}

test('accepted frozen chat append and clear preserve full output without replacing any Scene', async () => {
  for (const operations of [[append('  hello\u0000  ')], [clear], [append('first'), clear, append('last')]]) {
    const { before, validate } = setup();
    const { state } = checked(before, validate, operations);
    assert.notEqual(state, before);
    assert.notEqual(state.preferences, before.preferences);
    assert.notEqual(worldOf(state), worldOf(before));
    assert.equal(worldOf(state).scenes, worldOf(before).scenes);
    assert.equal(worldOf(state).actors, worldOf(before).actors);
    assert.equal(worldOf(state).statusDefinitions, worldOf(before).statusDefinitions);
    assert.equal(state.preferences.entitySystem.actors, before.preferences.entitySystem.actors);
    assert.equal(state.preferences.entitySystem.tokens, before.preferences.entitySystem.tokens);
    assert.notEqual(state.preferences.chatSystem, before.preferences.chatSystem);
    assert.notEqual(state.preferences.chatSystem.messages, before.preferences.chatSystem.messages);
    const asyncResult = await applyWorldOperationsAsync(before, operations, context(validate));
    assert.deepEqual(asyncResult, applyWorldOperations(before, operations, context()));
    validate(state);
    assert.equal(validate.isImmutableData(state), true);
  }
});

test('500-message truncation retains exactly the last 500 messages and immutable old records', () => {
  const { before, validate } = setup(500);
  const { state } = checked(before, validate, [append('one'), append('two')]);
  const messages = state.preferences.chatSystem.messages;
  assert.equal(messages.length, 500);
  assert.equal(messages[0], before.preferences.chatSystem.messages[2]);
  assert.deepEqual(messages.slice(-2).map(message => message.text), ['one', 'two']);
  assert.equal(before.preferences.chatSystem.messages.length, 500);
  assert.equal(before.preferences.chatSystem.messages[0].id, 'old-0');
  validate(state);
});

test('new chat arrays, appended messages and nested data are isolated from payload and input', () => {
  const { before, validate } = setup(), beforeJson = JSON.stringify(before);
  const payload = { text: 'new', data: { nested: { value: 1 } } };
  const { state } = checked(before, validate, [{ type: 'chat.append', payload }]);
  const messages = state.preferences.chatSystem.messages;
  messages.at(-1).text = 'changed';
  messages.at(-1).data.nested.value = 2;
  messages.push({ id: 'local-only' });
  assert.equal(payload.data.nested.value, 1);
  assert.equal(JSON.stringify(before), beforeJson);
  assert.throws(() => { messages[0].data.nested.index = 9; }, TypeError);
});

function applyStatus(current, operation, operationContext) {
  const reduced = reduceStatusOperation(current.preferences.entitySystem, operation,
    { ...operationContext, assumeNormalized: true });
  current.preferences.entitySystem = reduced.state;
  return { state: current, results: reduced.results };
}

test('mixed chat, move and status batches retain complete clone isolation', () => {
  for (const operations of [[append('before move'), move, status], [status, clear, move, append('after move')]]) {
    const { before, validate } = setup();
    const { state } = checked(before, validate, operations, { applyStatus, trustedOperationHooks: true });
    assert.notEqual(worldOf(state).scenes[0], worldOf(before).scenes[0]);
    assert.notEqual(worldOf(state).scenes[1], worldOf(before).scenes[1]);
    assert.equal(worldOf(state).scenes[0].tokens[0].x, 30);
    assert.equal(worldOf(state).actors[0].effects[0].definitionId, 'focused');
    assert.deepEqual(worldOf(before).actors[0].effects, []);
    validate(state);
  }
});

test('scene activation prunes frozen combat references without mutating accepted input', () => {
  for (const keep of [false, true]) {
    const input = fixture();
    if (keep) {
      worldOf(input).scenes[1].tokens = [structuredClone(worldOf(input).scenes[0].tokens[1])];
      worldOf(input).scenes[0].tokens.pop();
    }
    input.preferences.combatSystem = { custom: { value: 1 }, combat: { round: 3, turnIndex: 8,
      combatants: [{ id: 'combat-a', tokenId: 'token-a', actorId: 'actor-a' },
        { id: 'combat-b', tokenId: 'token-b', actorId: 'actor-b' }] } };
    const validate = createCanonicalWorldValidator();
    validate(input);
    const original = JSON.stringify(input);
    for (const operations of [[{ type: 'scene.activate', payload: { sceneId: 'scene-b' } }],
      [append('switch scene'), { type: 'scene.activate', payload: { sceneId: 'scene-b' } }]]) {
      const expected = applyWorldOperations(structuredClone(input), operations, context());
      const actual = applyWorldOperations(input, operations, context(validate, { trustedOperationHooks: true }));
      assert.deepEqual(actual, expected);
      assert.equal(JSON.stringify(input), original);
      assert.deepEqual(actual.state.preferences.combatSystem.combat,
        keep ? { round: 3, turnIndex: 0, combatants: [{ id: 'combat-b', tokenId: 'token-b', actorId: 'actor-b' }] } : null);
    }
  }
});

test('unsupported mixed operation types keep the complete clone even with an accepted proof', () => {
  const { before, validate } = setup();
  const { state } = checked(before, validate, [append('renaming'), { type: 'world.rename', payload: { name: 'new name' } }]);
  assert.notEqual(worldOf(state).actors, worldOf(before).actors);
  assert.notEqual(worldOf(state).scenes[1], worldOf(before).scenes[1]);
  assert.equal(worldOf(state).name, 'new name');
});

test('later operations, state hooks and message-clone failures cannot leak partial writes', () => {
  const cases = [
    { operations: [append('one'), { ...move, payload: { ...move.payload, tokenId: 'missing' } }], extra: {} },
    { operations: [append('one'), move, status], extra: {} },
    { operations: [append('one'), append('two')], extra: { trustedOperationHooks: true,
      prepareOperation({ index }) { if (index === 1) throw new Error('prepare failure'); } } },
    { operations: [append('one'), move], extra: { trustedOperationHooks: true,
      onOperationApplied({ index }) { if (index === 1) throw new Error('applied failure'); } } },
    { operations: [append('one'), append('two')], extra: {
      createChatMessage(input) { return { id: `message-${input.text}`, type: 'chat', text: input.text,
        createdAt: now, data: input.text === 'two' ? { cannotClone() {} } : null }; } } },
  ];
  for (const { operations, extra } of cases) {
    const { before, validate } = setup(), json = JSON.stringify(before);
    let expected, actual;
    try { applyWorldOperations(before, operations, context(null, extra)); }
    catch (error) { expected = { name: error.name, message: error.message, code: error.code }; }
    try { applyWorldOperations(before, operations, context(validate, extra)); }
    catch (error) { actual = { name: error.name, message: error.message, code: error.code }; }
    assert.ok(expected);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(before), json);
  }
});

test('untrusted state hooks retain their mutable private World even when the input is canonical', () => {
  for (const hook of ['prepareOperation', 'onOperationApplied']) {
    const { before, validate } = setup();
    const extra = { [hook]({ state }) { worldOf(state).actors[0].system.privateNotes = 'hook changed private copy'; } };
    const { state } = checked(before, validate, [append('with hook')], extra);
    assert.equal(worldOf(state).actors[0].system.privateNotes, 'hook changed private copy');
    assert.equal(worldOf(before).actors[0].system.privateNotes, 'secret-a');
    assert.notEqual(worldOf(state).actors[0], worldOf(before).actors[0]);
  }
  const { before, validate } = setup();
  const { state } = checked(before, validate, [append('custom ruleset')], { ruleset: {} });
  assert.notEqual(worldOf(state).actors, worldOf(before).actors);
});

test('mutable or unaccepted frozen input and nonboolean proofs retain the old output isolation', () => {
  for (const kind of ['mutable', 'frozen-unaccepted', 'truthy-proof']) {
    const before = fixture(), validate = createCanonicalWorldValidator();
    if (kind === 'frozen-unaccepted') {
      const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } };
      freeze(before);
    }
    const proof = kind === 'truthy-proof' ? { isImmutableData: () => 'true' } : validate;
    const { state } = checked(before, proof, [append('fallback')]);
    assert.notEqual(worldOf(state).actors[0], worldOf(before).actors[0]);
    worldOf(state).actors[0].system.privateNotes = 'result only';
    assert.equal(worldOf(before).actors[0].system.privateNotes, 'secret-a');
  }
});

test('accessor, Proxy and uncloneable inputs preserve complete clone traces and failure behavior', () => {
  for (const kind of ['accessor', 'accepted-accessor', 'throwing-accessor', 'proxy', 'function']) {
    const exercise = withProof => {
      const before = fixture(), trace = [], validate = createCanonicalWorldValidator();
      if (kind.includes('accessor')) Object.defineProperty(before, 'extension', { enumerable: true, configurable: true,
        get() { trace.push('getter'); if (kind === 'throwing-accessor') throw new Error('getter failure'); return { value: 1 }; } });
      if (kind === 'proxy') before.extension = new Proxy({ value: 1 }, {});
      if (kind === 'function') before.extension = { cannotClone() {} };
      if (kind === 'accepted-accessor') { validate(before); trace.length = 0; }
      if (withProof) assert.equal(validate.isImmutableData(before), false);
      try { return { result: applyWorldOperations(before, [append('fallback')], context(withProof ? validate : null)), trace }; }
      catch (error) { return { error: { name: error.name, message: error.message, code: error.code }, trace }; }
    };
    assert.deepEqual(exercise(true), exercise(false), kind);
  }
});
