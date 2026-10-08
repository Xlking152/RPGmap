import test from 'node:test';
import assert from 'node:assert/strict';

// Count actual copies without a production hook. The module-local clone
// functions capture this transparent wrapper; input preparation is uncounted.
const nativeClone = globalThis.structuredClone;
let countCopies = false, copies = 0;
const countedClone = (...args) => {
  if (countCopies) copies += 1;
  return nativeClone(...args);
};
globalThis.structuredClone = countedClone;
let prepareCanonicalMovementInputs, resolveTokenActor, normalizeActorDocument, resolveStatuses,
  createCanonicalWorldValidator, worldCopyInput, copyRuleset, copyMap, exportRuntimeState;
try {
  ({ prepareCanonicalMovementInputs } = await import('../src/server/movement-authority-entry.js'));
  ({ resolveTokenActor } = await import('../src/token/actor.js'));
  ({ normalizeActorDocument } = await import('../src/actor/model.js'));
  ({ resolveStatuses } = await import('../src/status/model.js'));
  ({ createCanonicalWorldValidator } = await import('../deployment/local-server/world-schema.mjs'));
  ({ worldCopyInput, copyRuleset, copyMap } = await import('./fixtures/world-copy-inputs.js'));
  ({ exportRuntimeState } = await import('../src/engine/runtime-state.js'));
} finally { globalThis.structuredClone = nativeClone; }

let sequence = 0;
function fixture(change = () => {}) {
  const state = exportRuntimeState(worldCopyInput().state, { mapPackage: copyMap, ruleset: copyRuleset });
  state.preferences.worldV2.id = `canonical-miss-${++sequence}`;
  change(state.preferences.worldV2);
  const validate = createCanonicalWorldValidator();
  validate(state);
  const world = state.preferences.worldV2, scene = world.scenes[0], token = scene.tokens[0];
  return { state, validate, input: { world, scene, token, ruleset: copyRuleset, isCanonicalData: validate.isImmutableData } };
}

function oldMiss({ world, scene, token, ruleset }) {
  const actor = resolveTokenActor({ ...world, activeSceneId: scene.id, scenes: [scene] }, token.id, { ruleset }).actor;
  const status = resolveStatuses({ schemaVersion: 4, actors: [actor], tokens: [token], statusDefinitions: world.statusDefinitions },
    { actorId: token.actorId, tokenId: token.id, ruleset });
  return { actor: structuredClone(actor), status: structuredClone(status) };
}

function measure(callback) {
  copies = 0; countCopies = true;
  globalThis.structuredClone = countedClone;
  try { return { result: callback(), copies }; }
  finally { countCopies = false; globalThis.structuredClone = nativeClone; }
}

test('a real accepted linked cache miss preserves complete Actor/status bytes while removing exactly three discarded clones', () => {
  const { state, input } = fixture();
  const before = JSON.stringify(state);
  oldMiss(input); // Warm the shared immutable status-definition normalization.
  const old = measure(() => oldMiss(input));
  const optimized = measure(() => prepareCanonicalMovementInputs(input));
  assert.ok(optimized.result);
  assert.equal(JSON.stringify(optimized.result), JSON.stringify(old.result));
  assert.equal(old.copies - optimized.copies, 3,
    `complete miss copies: old=${old.copies}, optimized=${optimized.copies}`);
  assert.equal(JSON.stringify(state), before);
  assert.notEqual(optimized.result.actor, input.world.actors[0]);
  assert.notEqual(optimized.result.actor.system, input.world.actors[0].system);
  assert.notEqual(optimized.result.actor.effects, input.world.actors[0].effects);
  optimized.result.actor.extension.nested.value = 'caller edit';
  optimized.result.actor.system.runtime.resources.stamina.current = 77;
  optimized.result.status.capabilities.canMove = false;
  const repeated = prepareCanonicalMovementInputs(input);
  assert.equal(JSON.stringify(repeated), JSON.stringify(old.result));
  assert.equal(JSON.stringify(state), before);
});

test('normalization remains complete for accepted legacy fields, Actor/Token effects and replacement documents', () => {
  const f = fixture(world => {
    world.statusDefinitions.push({ id: 'miss-stop', name: 'Stop', scopes: ['actor', 'token'], maxStacks: 1,
      changes: [], capabilities: { canMove: false } });
    world.actors[0].effects = [{ id: 'actor-stop', definitionId: 'miss-stop', stacks: 1, enabled: true }];
    world.actors[0].extension.deep = { list: [1, { keep: true }] };
    world.scenes[0].tokens[0].effects = [{ id: 'token-stop', definitionId: 'miss-stop', stacks: 1, enabled: false }];
  });
  const expected = oldMiss(f.input);
  const actual = prepareCanonicalMovementInputs(f.input);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(actual.status.capabilities.canMove, false);
  const replacement = structuredClone(f.state);
  replacement.preferences.worldV2.actors[0].effects = [];
  // The full normalizer must still trim shell data and discard legacy fields.
  replacement.preferences.worldV2.actors[0].name = '  Changed Actor  ';
  replacement.preferences.worldV2.actors[0].runtime = { retired: true };
  f.validate(replacement);
  const world = replacement.preferences.worldV2, scene = world.scenes[0];
  const input = { ...f.input, world, scene, token: scene.tokens[0] };
  const next = prepareCanonicalMovementInputs(input);
  assert.equal(JSON.stringify(next), JSON.stringify(oldMiss(input)));
  assert.equal(next.actor.name, 'Changed Actor');
  assert.equal(Object.hasOwn(next.actor, 'runtime'), false);
  assert.equal(next.status.capabilities.canMove, true);
  assert.equal(prepareCanonicalMovementInputs(f.input).status.capabilities.canMove, false);
});

test('canonical selection stays exact and custom, synthetic, detached and rejected data remain ineligible', () => {
  const { input } = fixture();
  for (const changed of [
    { ...input, ruleset: { ...copyRuleset } },
    { ...input, token: structuredClone(input.token) },
    { ...input, isCanonicalData: () => false },
    { ...input, isCanonicalData: () => 'true' },
    { ...input, scene: { ...input.scene, tokens: [] } },
  ]) assert.equal(prepareCanonicalMovementInputs(changed), null);
  const synthetic = fixture(world => {
    world.scenes[0].tokens[0].actorLink = false;
    world.scenes[0].tokens[0].actorDelta = { system: { runtime: { movementCapabilities: { fly: true } } } };
  });
  assert.equal(prepareCanonicalMovementInputs(synthetic.input), null);
  assert.deepEqual(normalizeActorDocument(input.world.actors[0], { ruleset: copyRuleset }),
    resolveTokenActor(input.world, input.token.id, { ruleset: copyRuleset }).actor);
});

test('qualified host normalization errors retain the original resolver error and never seed an entry', () => {
  const { state, input } = fixture();
  let calls = 0;
  const expected = new TypeError('host-normalization-rejected');
  const ruleset = Object.freeze({ ...copyRuleset, actor: Object.freeze({ ...copyRuleset.actor,
    normalizeSystem() { calls += 1; throw expected; } }) });
  const host = { ...input, ruleset, canonicalMovementRuleset: ruleset };
  const before = JSON.stringify(state);
  assert.throws(() => oldMiss(host), error => error === expected);
  for (let index = 0; index < 2; index++) assert.throws(() => prepareCanonicalMovementInputs(host), error => error === expected);
  assert.equal(calls, 3);
  assert.equal(JSON.stringify(state), before);
});
