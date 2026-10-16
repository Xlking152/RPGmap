import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCanonicalMovementInputs, validateAuthoritativeTokenMovePath, setServerMapResolver }
  from '../src/server/movement-authority-entry.js';
import { createMovementAuthority } from '../src/movement/authority.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { RulesetPackageStore } from '../deployment/local-server/ruleset-store.mjs';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { worldCopyInput, copyRuleset, copyMap } from './fixtures/world-copy-inputs.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';

setServerMapResolver(() => copyMap);
let sequence = 0;
function fixture(ruleset = copyRuleset) {
  const state = exportRuntimeState(worldCopyInput().state, { mapPackage: copyMap, ruleset: copyRuleset });
  const world = state.preferences.worldV2;
  world.id = `borrow-inputs-${++sequence}`;
  const scene = world.scenes[0], token = scene.tokens[0];
  scene.sceneEvents = []; scene.featureStates = {};
  token.elevationMeters = 0;
  const validate = createCanonicalWorldValidator(); validate(state);
  return { state, world, scene, token, ruleset, canonicalMovementRuleset: ruleset,
    isCanonicalData: validate.isImmutableData, validate,
    origin: { x: token.x, y: token.y }, waypoints: [{ x: token.x + 1, y: token.y }] };
}

function countCopies(callback, transform = value => value) {
  const original = globalThis.structuredClone, cloned = [];
  globalThis.structuredClone = (...args) => {
    const value = transform(original(...args)); cloned.push(value); return value;
  };
  try { return { result: callback(), cloned }; }
  finally { globalThis.structuredClone = original; }
}

function assertDeepFrozen(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

const detachedAuthority = createMovementAuthority(() => copyMap, { prepareActorInputs: prepareCanonicalMovementInputs });

test('the package store built-in instance borrows deeply frozen inputs and removes exactly two warm copies', async () => {
  // The actual store re-prepares its built-in, so object identity differs but
  // all fixed hook function identities remain the same as the server bundle.
  const store = new RulesetPackageStore({ root: 'unused-borrow-test', builtins: [copyRuleset] });
  const ruleset = await store.get({ id: copyRuleset.id, version: copyRuleset.version });
  assert.notEqual(ruleset, copyRuleset);
  const input = fixture(ruleset), before = JSON.stringify(input.state);
  detachedAuthority(input);
  const first = countCopies(() => validateAuthoritativeTokenMovePath(input));
  assert.equal(first.result.valid, true);
  const actorCopy = first.cloned.find(value => value?.id === input.world.actors[0].id);
  const statusCopy = first.cloned.find(value => value?.capabilities && value?.statusVersion);
  assert.ok(actorCopy); assert.ok(statusCopy);
  assertDeepFrozen(actorCopy); assertDeepFrozen(statusCopy);
  const detached = countCopies(() => detachedAuthority(input));
  const warm = countCopies(() => validateAuthoritativeTokenMovePath(input));
  assert.deepEqual(warm.result, detached.result);
  assert.equal(detached.cloned.length - warm.cloned.length, 2);
  assert.equal(JSON.stringify(input.state), before);
});

test('public preparation remains detached and mutable after an internal loan', () => {
  const input = fixture();
  const expected = detachedAuthority(input);
  validateAuthoritativeTokenMovePath(input);
  const first = prepareCanonicalMovementInputs(input), second = prepareCanonicalMovementInputs(input);
  assert.notEqual(first.actor, second.actor); assert.notEqual(first.status, second.status);
  assert.equal(Object.isFrozen(first.actor), false); assert.equal(Object.isFrozen(first.status), false);
  first.actor.system.runtime.movementCapabilities = { walk: false };
  first.status.capabilities.canMove = false;
  assert.deepEqual(prepareCanonicalMovementInputs(input), second);
  assert.deepEqual(validateAuthoritativeTokenMovePath(input), expected);
});

test('Actor, Token effects and definition replacements invalidate the frozen snapshot', () => {
  for (const change of [
    world => { world.actors[0].system.runtime.movementCapabilities = { walk: false }; },
    world => { world.scenes[0].tokens[0].effects = [{ id: 'stop', definitionId: 'stop', enabled: true }]; },
    world => { world.statusDefinitions[0].capabilities.canMove = false; },
  ]) {
    const input = fixture();
    // Keep an enabled Actor effect so replacing only its definition changes
    // the effective movement permission in the third case.
    const raw = structuredClone(input.state), world = raw.preferences.worldV2;
    world.statusDefinitions = [{ id: 'stop', name: 'Stop', scopes: ['actor', 'token'], maxStacks: 1,
      changes: [], capabilities: { canMove: true } }];
    world.actors[0].effects = [{ id: 'actor-stop', definitionId: 'stop', enabled: true }];
    input.validate(raw);
    const args = { ...input, state: raw, world, scene: world.scenes[0], token: world.scenes[0].tokens[0] };
    assert.equal(validateAuthoritativeTokenMovePath(args).valid, true);
    const next = structuredClone(raw); change(next.preferences.worldV2);
    // The Token-effect case gets its own blocking definition as well.
    if (next.preferences.worldV2.scenes[0].tokens[0].effects.length) {
      next.preferences.worldV2.statusDefinitions[0].capabilities.canMove = false;
    }
    input.validate(next);
    const nextWorld = next.preferences.worldV2;
    const nextArgs = { ...input, state: next, world: nextWorld,
      scene: nextWorld.scenes[0], token: nextWorld.scenes[0].tokens[0] };
    const actual = validateAuthoritativeTokenMovePath(nextArgs);
    assert.deepEqual(actual, detachedAuthority(nextArgs));
    assert.equal(actual.valid, false);
  }
});

test('custom derivers retaining returned references keep fresh copies instead of a stale loan', () => {
  let retained;
  const ruleset = prepareRuleset({ ...copyRuleset, statuses: { ...copyRuleset.statuses,
    derive() {
      retained = { id: 'retained', definitionId: 'retained', enabled: true, capabilities: { canMove: true } };
      return [retained];
    } } });
  const input = fixture(ruleset);
  assert.equal(validateAuthoritativeTokenMovePath(input).valid, true);
  retained.capabilities.canMove = false;
  assert.equal(prepareCanonicalMovementInputs(input).status.capabilities.canMove, true,
    'the capability summary retains its original resolver semantics');
  assert.equal(prepareCanonicalMovementInputs(input).status.derivedStatuses[0].capabilities.canMove, false);
  const warm = countCopies(() => validateAuthoritativeTokenMovePath(input));
  const detached = countCopies(() => detachedAuthority(input));
  assert.deepEqual(warm.result, detached.result);
  assert.equal(warm.cloned.length, detached.cloned.length, 'custom output aliases cannot be hidden by a retained frozen copy');
});

test('every custom normalization, derivation and movement hook retains detached input delivery', () => {
  for (const [section, key] of [['actor', 'migrateLegacy'], ['actor', 'normalizeSystem'], ['actor', 'derive'],
    ['statuses', 'derive'], ['movement', 'describe'], ['movement', 'calculateCost']]) {
    const ruleset = prepareRuleset({ ...copyRuleset, [section]: { ...copyRuleset[section],
      [key](...args) { return copyRuleset[section][key](...args); } } });
    const input = fixture(ruleset);
    validateAuthoritativeTokenMovePath(input); detachedAuthority(input);
    const warm = countCopies(() => validateAuthoritativeTokenMovePath(input));
    const detached = countCopies(() => detachedAuthority(input));
    assert.deepEqual(warm.result, detached.result, `${section}.${key}`);
    assert.equal(warm.cloned.length, detached.cloned.length, `${section}.${key}`);
  }
});

test('a custom mutating movement hook cannot edit the canonical input cache', () => {
  let observed = [];
  const ruleset = prepareRuleset({ ...copyRuleset, movement: { ...copyRuleset.movement,
    describe(actor, context) {
      observed.push([Object.isFrozen(actor), Object.isFrozen(context.status), actor.system.loanMutation,
        context.status.capabilities.canMove]);
      actor.system.loanMutation = true;
      context.status.capabilities.canMove = false;
      return copyRuleset.movement.describe(actor, context);
    } } });
  const input = fixture(ruleset);
  validateAuthoritativeTokenMovePath(input); validateAuthoritativeTokenMovePath(input);
  assert.deepEqual(observed, [[false, false, undefined, true], [false, false, undefined, true]]);
  assert.equal(prepareCanonicalMovementInputs(input).actor.system.loanMutation, undefined);
  assert.equal(prepareCanonicalMovementInputs(input).status.capabilities.canMove, true);
});

test('mutable and getter hook containers preserve hook replacement and cannot borrow', () => {
  for (const kind of ['mutable-container', 'getter-section', 'getter-hook']) {
    let describe = copyRuleset.movement.describe;
    const movement = { ...copyRuleset.movement };
    let ruleset;
    if (kind === 'getter-section') ruleset = Object.freeze({ ...copyRuleset, get movement() { return movement; } });
    else if (kind === 'getter-hook') {
      Object.defineProperty(movement, 'describe', { enumerable: true, get: () => describe });
      ruleset = Object.freeze({ ...copyRuleset, movement: Object.freeze(movement) });
    } else ruleset = Object.freeze({ ...copyRuleset, movement });
    const input = fixture(ruleset);
    assert.equal(validateAuthoritativeTokenMovePath(input).valid, true);
    const blocked = () => ({ walk: false });
    if (kind === 'getter-hook') describe = blocked;
    else movement.describe = blocked;
    assert.equal(validateAuthoritativeTokenMovePath(input).code, 'movement_walk_forbidden');
    assert.deepEqual(validateAuthoritativeTokenMovePath(input), detachedAuthority(input));
  }
});

test('unsupported or cyclic cloned snapshots are never published as reusable loans', () => {
  for (const kind of ['cycle', 'non-json']) {
    const input = fixture(); prepareCanonicalMovementInputs(input);
    let changed = false;
    countCopies(() => validateAuthoritativeTokenMovePath(input), value => {
      if (!changed && value?.id === input.world.actors[0].id) {
        changed = true;
        value.extension.loanProbe = kind === 'cycle' ? value : new Date(0);
      }
      return value;
    });
    assert.equal(changed, true);
    const first = countCopies(() => validateAuthoritativeTokenMovePath(input));
    const second = countCopies(() => validateAuthoritativeTokenMovePath(input));
    assert.equal(first.cloned.length - second.cloned.length, 2, 'only the subsequent valid snapshot becomes reusable');
    assert.deepEqual(first.result, second.result);
  }
});
