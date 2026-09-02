import test from 'node:test';
import assert from 'node:assert/strict';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

function importedActor(detection) {
  return {
    id: 'actor-detection',
    effects: [],
    ...infiniteHorrorRuleset.actor.createFromImport({
      formName: '侦测形态',
      identity: { name: '侦查员' },
      description: {}, resources: {}, attributes: [], checks: {}, badStatuses: [], combat: {},
      tokenAppearance: {}, source: { type: 'xlsx' }, detection,
    }, { variantId: 'form-detection' }),
  };
}

test('form detection is derived with light-level downgrades and runtime overrides', () => {
  const actor = importedActor({
    configured: true,
    preciseRangeMeters: 30,
    vagueRangeMeters: 300,
    senses: { lowLightVision: false, darkvision: false },
  });
  assert.deepEqual(
    (({ preciseRangeMeters, vagueRangeMeters }) => ({ preciseRangeMeters, vagueRangeMeters }))(
      infiniteHorrorRuleset.vision.describe(actor, { lighting: 'normal' }),
    ),
    { preciseRangeMeters: 30, vagueRangeMeters: 300 },
  );
  assert.equal(infiniteHorrorRuleset.vision.describe(actor, { lighting: 'dim' }).preciseRangeMeters, 0);
  assert.deepEqual(
    (({ preciseRangeMeters, vagueRangeMeters }) => ({ preciseRangeMeters, vagueRangeMeters }))(
      infiniteHorrorRuleset.vision.describe(actor, { lighting: 'dark' }),
    ),
    { preciseRangeMeters: 0, vagueRangeMeters: 300 },
  );

  let result = infiniteHorrorRuleset.actor.applyRuntimeOperation(actor, {
    type: 'detection.set-override', field: 'sense', sense: 'lowLightVision', value: true,
  });
  assert.equal(result.changed, true);
  result = infiniteHorrorRuleset.actor.applyRuntimeOperation(actor, {
    type: 'detection.set-override', field: 'preciseRangeMeters', value: 75,
  });
  assert.equal(result.changed, true);
  const dim = infiniteHorrorRuleset.vision.describe(actor, { lighting: 'dim' });
  assert.equal(dim.preciseRangeMeters, 75);
  assert.equal(dim.source, 'system.runtime.detectionOverrides');
});

test('runtime normalizes vague range without losing imported raw diagnostics', () => {
  const actor = importedActor({
    configured: true,
    preciseRangeMeters: 50,
    vagueRangeMeters: 20,
    senses: {},
    diagnostics: { vague: { address: 'X63', raw: '20m', meters: 20 } },
  });
  const derived = infiniteHorrorRuleset.actor.derive(actor);
  assert.equal(derived.detection.vagueRangeMeters, 50);
  assert.equal(derived.form.detection.diagnostics.vague.raw, '20m');
});

test('unlinked instance delta preserves independent detection overrides', () => {
  const actor = importedActor({ configured: true, preciseRangeMeters: 30, vagueRangeMeters: 300, senses: {} });
  infiniteHorrorRuleset.actor.applyRuntimeOperation(actor, {
    type: 'detection.set-override', field: 'preciseRangeMeters', value: 90,
  });
  const delta = infiniteHorrorRuleset.actor.instances.createDelta(actor);
  assert.equal(delta.system.runtime.detectionOverrides.preciseRangeMeters, 90);
  assert.equal(delta.system.forms, undefined);
});
