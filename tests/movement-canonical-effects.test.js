import test from 'node:test';
import assert from 'node:assert/strict';

// Observe real copies, including helpers which capture structuredClone when
// imported. No production instrumentation or alternate preparation path.
const nativeClone = globalThis.structuredClone;
let measuring = false, copies = 0;
const countedClone = (...args) => {
  if (measuring) copies++;
  return nativeClone(...args);
};
globalThis.structuredClone = countedClone;
let prepareCanonicalMovementInputs, validateAuthoritativeTokenMovePath, setServerMapResolver,
  createMovementAuthority, normalizeActorDocument, resolveStatuses, createCanonicalWorldValidator,
  worldCopyInput, copyRuleset, copyMap, exportRuntimeState, prepareRuleset;
try {
  ({ prepareCanonicalMovementInputs, validateAuthoritativeTokenMovePath, setServerMapResolver }
    = await import('../src/server/movement-authority-entry.js'));
  ({ createMovementAuthority } = await import('../src/movement/authority.js'));
  ({ normalizeActorDocument } = await import('../src/actor/model.js'));
  ({ resolveStatuses } = await import('../src/status/model.js'));
  ({ createCanonicalWorldValidator } = await import('../deployment/local-server/world-schema.mjs'));
  ({ worldCopyInput, copyRuleset, copyMap } = await import('./fixtures/world-copy-inputs.js'));
  ({ exportRuntimeState } = await import('../src/engine/runtime-state.js'));
  ({ prepareRuleset } = await import('../src/ruleset/contract.js'));
} finally { globalThis.structuredClone = nativeClone; }

setServerMapResolver(() => copyMap);
const detachedAuthority = createMovementAuthority(() => copyMap, { prepareActorInputs: prepareCanonicalMovementInputs });
let sequence = 0;
function fixture(ruleset = prepareRuleset(copyRuleset), change = () => {}) {
  const state = exportRuntimeState(worldCopyInput().state, { mapPackage: copyMap, ruleset: copyRuleset });
  const world = state.preferences.worldV2, scene = world.scenes[0], token = scene.tokens[0];
  world.id = `movement-effects-${++sequence}`;
  world.statusDefinitions = [{ id: 'stop', name: 'Stop', scopes: ['actor', 'token'], maxStacks: 1,
    changes: [], capabilities: { canMove: false } }];
  scene.sceneEvents = []; scene.featureStates = {}; token.elevationMeters = 0;
  change(world);
  const validate = createCanonicalWorldValidator(); validate(state);
  return { state, world, scene, token, ruleset, canonicalMovementRuleset: ruleset,
    isCanonicalData: validate.isImmutableData, validate,
    origin: { x: token.x, y: token.y }, waypoints: [{ x: token.x + 1, y: token.y }] };
}

function changed(input, extra = {}, removeKeys = []) {
  const actor = { ...input.world.actors[0], effects: [], ...extra };
  for (const key of removeKeys) delete actor[key];
  const world = { ...input.world, actors: [actor, ...input.world.actors.slice(1)] };
  const state = { ...input.state, preferences: { ...input.state.preferences, worldV2: world } };
  input.validate(state);
  return { ...input, state, world };
}

function measure(callback) {
  copies = 0; measuring = true; globalThis.structuredClone = countedClone;
  try { return { result: callback(), copies }; }
  finally { measuring = false; globalThis.structuredClone = nativeClone; }
}

function completeInputs(input) {
  const actor = normalizeActorDocument(input.world.actors[0], { ruleset: input.ruleset });
  const status = resolveStatuses({ schemaVersion: 4, actors: [actor], tokens: [input.token],
    statusDefinitions: input.world.statusDefinitions },
  { actorId: input.token.actorId, tokenId: input.token.id, ruleset: input.ruleset });
  return { actor, status };
}

test('effects-only refresh removes exactly the redundant full Actor normalization copies', () => {
  const importedForm = world => {
    world.actors[0].system.forms = [{ id: 'stable-form', name: 'Form', healthBase: { baseMax: 10 } }];
    world.actors[0].system.currentFormId = 'stable-form';
    world.actors[0].system.runtime.health.current = 10;
  };
  const input = fixture(undefined, importedForm);
  assert.notEqual(input.ruleset, copyRuleset, 'the server re-prepares its fixed built-in instance');
  validateAuthoritativeTokenMovePath(input);
  const next = changed(input);
  const refreshed = measure(() => validateAuthoritativeTokenMovePath(next));
  assert.equal(refreshed.result.valid, true);
  assert.deepEqual(prepareCanonicalMovementInputs(next), completeInputs(next));
  const normalization = measure(() => normalizeActorDocument(next.world.actors[0], { ruleset: next.ruleset }));

  const control = fixture(undefined, importedForm); detachedAuthority(control);
  const controlNext = changed(control);
  const full = measure(() => detachedAuthority(controlNext));
  assert.deepEqual(refreshed.result, full.result);
  assert.equal(full.copies - refreshed.copies, normalization.copies - 1 + 2,
    'one effects clone replaces full Actor normalization and the fixed private loan removes its two copies');
  assert.ok(normalization.copies > 1);
});

test('effects-only edits fully refresh status capabilities, lists and version without mutating earlier inputs', () => {
  const input = fixture(), before = JSON.stringify(input.state);
  assert.equal(validateAuthoritativeTokenMovePath(input).valid, true);
  const originalStatus = prepareCanonicalMovementInputs(input).status;
  const blocked = changed(input, { effects: [{ id: 'stopped', definitionId: 'stop', stacks: 1, enabled: true,
    extension: { keep: ['complete', 'effect'] } }] });
  assert.equal(validateAuthoritativeTokenMovePath(blocked).code, 'status_movement_forbidden');
  const prepared = prepareCanonicalMovementInputs(blocked);
  assert.deepEqual(prepared, completeInputs(blocked));
  assert.notEqual(prepared.status.statusVersion, originalStatus.statusVersion);
  assert.equal(prepared.status.statuses[0].definitionId, 'stop');
  prepared.actor.effects[0].extension.keep.push('caller edit');
  prepared.status.capabilities.canMove = true;
  assert.deepEqual(prepareCanonicalMovementInputs(blocked), completeInputs(blocked));
  const restored = changed(blocked);
  assert.equal(validateAuthoritativeTokenMovePath(restored).valid, true);
  assert.deepEqual(prepareCanonicalMovementInputs(restored), completeInputs(restored));
  assert.equal(JSON.stringify(input.state), before);
});

test('all other Actor field edits keep the complete normalization path', () => {
  for (const patch of [
    actor => ({ name: '  Changed name  ' }),
    actor => ({ system: nativeClone(actor.system) }),
    actor => ({ extension: { changed: true } }),
    actor => ({ updatedAt: '2026-10-16T00:00:00.000Z' }),
    actor => ({ additionalOwnField: true }),
    actor => ({ name: -0 }),
  ]) {
    const input = fixture(); validateAuthoritativeTokenMovePath(input);
    const next = changed(input, patch(input.world.actors[0]));
    const actual = measure(() => validateAuthoritativeTokenMovePath(next));
    const control = fixture(); detachedAuthority(control);
    const controlNext = changed(control, patch(control.world.actors[0]));
    const full = measure(() => detachedAuthority(controlNext));
    assert.deepEqual(actual.result, full.result);
    assert.equal(actual.copies + 2, full.copies,
      'other field edits retain full normalization; only the fixed private loan copies are removed');
    assert.deepEqual(prepareCanonicalMovementInputs(next), completeInputs(next));
  }
});

test('removed or renamed own fields cannot take the effects-only refresh', () => {
  for (const renamed of [false, true]) {
    const input = fixture(); validateAuthoritativeTokenMovePath(input);
    const extra = renamed ? { renamedExtension: input.world.actors[0].extension } : {};
    const next = changed(input, extra, ['extension']);
    const actual = measure(() => validateAuthoritativeTokenMovePath(next));
    const control = fixture(); detachedAuthority(control);
    const controlNext = changed(control,
      renamed ? { renamedExtension: control.world.actors[0].extension } : {}, ['extension']);
    const full = measure(() => detachedAuthority(controlNext));
    assert.deepEqual(actual.result, full.result);
    assert.equal(actual.copies + 2, full.copies);
    assert.deepEqual(prepareCanonicalMovementInputs(next), completeInputs(next));
  }
});

test('legacy forms with generated IDs keep fresh normalization after effects-only edits', () => {
  for (const topLevel of [false, true]) {
    const legacy = world => {
      const actor = world.actors[0];
      if (topLevel) actor.forms = [{ name: 'Legacy form' }];
      else actor.system.forms = [{ name: 'Legacy form' }];
    };
    const input = fixture(undefined, legacy); validateAuthoritativeTokenMovePath(input);
    const oldId = prepareCanonicalMovementInputs(input).actor.system.forms[0].id;
    const next = changed(input);
    const actual = measure(() => validateAuthoritativeTokenMovePath(next));
    const newId = prepareCanonicalMovementInputs(next).actor.system.forms[0].id;
    assert.notEqual(newId, oldId, 'normalization must generate a fresh legacy form identity');
    const control = fixture(undefined, legacy); detachedAuthority(control);
    const controlNext = changed(control);
    const full = measure(() => detachedAuthority(controlNext));
    assert.equal(actual.copies + 2, full.copies,
      'legacy input retains full normalization while the fixed private loan avoids its two copies');
  }
});

test('custom normalizers and derivers still run their complete behavior after effects-only edits', () => {
  for (const [section, key] of [['actor', 'migrateLegacy'], ['actor', 'normalizeSystem'],
    ['actor', 'derive'], ['statuses', 'derive'], ['movement', 'describe'], ['movement', 'calculateCost']]) {
    const ruleset = prepareRuleset({ ...copyRuleset, [section]: { ...copyRuleset[section],
      [key](...args) { return copyRuleset[section][key](...args); } } });
    const input = fixture(ruleset); validateAuthoritativeTokenMovePath(input);
    const next = changed(input);
    const actual = measure(() => validateAuthoritativeTokenMovePath(next));
    const control = fixture(ruleset); detachedAuthority(control);
    const controlNext = changed(control);
    const full = measure(() => detachedAuthority(controlNext));
    assert.deepEqual(actual.result, full.result, `${section}.${key}`);
    assert.equal(actual.copies, full.copies, `${section}.${key}`);
    assert.deepEqual(prepareCanonicalMovementInputs(next), completeInputs(next));
  }
});

test('an entry prepared before hooks became fixed cannot seed an effects-only refresh', () => {
  const actor = { ...copyRuleset.actor, normalizeSystem(...args) {
    return { ...copyRuleset.actor.normalizeSystem(...args), fromCustomNormalizer: true };
  } };
  const ruleset = { ...copyRuleset, actor }, input = fixture(ruleset);
  assert.equal(prepareCanonicalMovementInputs(input).actor.system.fromCustomNormalizer, true);
  actor.normalizeSystem = copyRuleset.actor.normalizeSystem;
  Object.freeze(actor); Object.freeze(ruleset);
  // Existing public cache semantics remain unchanged until a real dependency
  // changes. A later private loan cannot certify an earlier custom normalizer.
  validateAuthoritativeTokenMovePath(input);
  const next = changed(input);
  validateAuthoritativeTokenMovePath(next);
  const prepared = prepareCanonicalMovementInputs(next);
  assert.equal(prepared.actor.system.fromCustomNormalizer, undefined);
  assert.deepEqual(prepared, completeInputs(next));
});
