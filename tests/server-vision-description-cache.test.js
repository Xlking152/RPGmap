import test from 'node:test';
import assert from 'node:assert/strict';
import { configureServerRuleset, describeServerVision } from '../src/server/authority.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { RulesetPackageStore } from '../deployment/local-server/ruleset-store.mjs';
import { worldCopyInput } from './fixtures/world-copy-inputs.js';

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen);
  return Object.freeze(value);
}

function actor() {
  const document = worldCopyInput().world.actors[0];
  document.system.forms = [{ id: 'form', name: 'Default' }];
  document.system.currentFormId = 'form';
  document.system.runtime.detectionOverrides = { preciseRangeMeters: 10, vagueRangeMeters: 20 };
  return document;
}

test('the actual package-store built-in preserves the Actor-only normal-light cache', async t => {
  t.after(() => configureServerRuleset(infiniteHorrorRuleset));
  const store = new RulesetPackageStore({ root: 'unused-vision-cache-test', builtins: [infiniteHorrorRuleset] });
  const ruleset = await store.get({ id: infiniteHorrorRuleset.id, version: infiniteHorrorRuleset.version });
  assert.notEqual(ruleset, infiniteHorrorRuleset);
  assert.equal(ruleset.vision.describe, infiniteHorrorRuleset.vision.describe);
  configureServerRuleset(ruleset);
  const document = frozen(actor());
  const firstContext = { lighting: 'normal', token: { id: 'a' }, scene: { settings: { lighting: 'dark' } }, user: { id: 'gm' } };
  const first = describeServerVision(document, firstContext);
  assert.deepEqual(first, ruleset.vision.describe(document, firstContext));
  assert.equal(describeServerVision(document, { lighting: 'normal', token: { id: 'b' }, user: { id: 'player' } }), first);
  configureServerRuleset(ruleset);
  assert.notEqual(describeServerVision(document, firstContext), first, 'changing the configured ruleset discards old descriptions');
});

test('shallow freezing an Actor cannot cache mutable nested detection data', t => {
  t.after(() => configureServerRuleset(infiniteHorrorRuleset));
  configureServerRuleset(infiniteHorrorRuleset);
  const document = Object.freeze(actor());
  const first = describeServerVision(document, { lighting: 'normal' });
  assert.equal(first.preciseRangeMeters, 10);
  document.system.runtime.detectionOverrides.preciseRangeMeters = 30;
  document.system.runtime.detectionOverrides.vagueRangeMeters = 40;
  const second = describeServerVision(document, { lighting: 'normal' });
  assert.notEqual(second, first);
  assert.equal(second.preciseRangeMeters, 30);
  assert.equal(second.vagueRangeMeters, 40);
});

test('custom vision hooks receive Token, Scene, user and the exact context on every call', t => {
  t.after(() => configureServerRuleset(infiniteHorrorRuleset));
  const document = frozen(actor());
  for (const id of ['minimal-test', infiniteHorrorRuleset.id]) {
    const calls = [];
    const ruleset = prepareRuleset({ ...infiniteHorrorRuleset, id, vision: {
      describe(receivedActor, context) {
        calls.push({ actor: receivedActor, context });
        return { rangeMeters: context.token.range + context.scene.bonus + context.user.bonus };
      },
    } });
    configureServerRuleset(ruleset);
    const context = { lighting: 'normal', token: { range: 10 }, scene: { bonus: 2 }, user: { bonus: 3 } };
    assert.equal(describeServerVision(document, context).rangeMeters, 15);
    context.token.range = 30;
    assert.equal(describeServerVision(document, context).rangeMeters, 35);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.actor, document);
      assert.equal(call.context, context);
    }
  }
});

test('another rule identity cannot claim the bundled Actor-only cache by reusing its hook', t => {
  t.after(() => configureServerRuleset(infiniteHorrorRuleset));
  const document = frozen(actor());
  for (const change of [{ id: 'second-rule' }, { version: '2.0.0' }]) {
    const ruleset = prepareRuleset({ ...infiniteHorrorRuleset, ...change });
    assert.equal(ruleset.vision.describe, infiniteHorrorRuleset.vision.describe);
    configureServerRuleset(ruleset);
    const context = { lighting: 'normal' };
    assert.notEqual(describeServerVision(document, context), describeServerVision(document, context));
  }
});

test('bundled effects overrides, non-normal lighting and mutable rule containers remain uncached', t => {
  t.after(() => configureServerRuleset(infiniteHorrorRuleset));
  const document = frozen(actor());
  configureServerRuleset(infiniteHorrorRuleset);
  for (const context of [{ lighting: 'normal', effects: [] }, { lighting: 'dark' }]) {
    const first = describeServerVision(document, context);
    assert.deepEqual(first, infiniteHorrorRuleset.vision.describe(document, context));
    assert.notEqual(describeServerVision(document, context), first);
  }
  for (const ruleset of [
    { ...infiniteHorrorRuleset },
    Object.freeze({ ...infiniteHorrorRuleset, vision: { ...infiniteHorrorRuleset.vision } }),
    Object.freeze({ ...infiniteHorrorRuleset, vision: Object.freeze({
      get describe() { return infiniteHorrorRuleset.vision.describe; },
    }) }),
  ]) {
    configureServerRuleset(ruleset);
    assert.notEqual(describeServerVision(document, { lighting: 'normal' }), describeServerVision(document, { lighting: 'normal' }));
  }
});
