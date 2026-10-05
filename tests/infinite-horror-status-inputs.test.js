import test from 'node:test';
import assert from 'node:assert/strict';
import { createInfiniteHorrorActorFromImport, deriveInfiniteHorrorActor,
  deriveInfiniteHorrorStatusInputs } from '../src/rulesets/infinite-horror/actor.js';
import { deriveInfiniteHorrorStatuses } from '../src/rulesets/infinite-horror/statuses.js';
import { INFINITE_HORROR_BAD_STATUS_DEFS } from '../src/rulesets/infinite-horror/definitions.js';
import { deriveFullActorStatusReference } from './fixtures/infinite-horror-full-status-reference.js';

function actor({ hp = 5, sourceType = 'manual', mode = 'simple', current = hp,
  wounds = { bashing: 0, lethal: 0, aggravated: 0 }, thresholds = true } = {}) {
  const result = { id: 'status-input-actor', ...createInfiniteHorrorActorFromImport({
    identity: { name: 'Status Input Actor' }, formName: 'Primary', resources: {
      hp: { max: hp }, stamina: { max: 20 }, willpower: { max: 10 },
    }, attributes: [{ id: 'strength', name: 'Strength', base: 2 },
      { id: 'perception', name: 'Perception', base: 6 }],
    checks: { skills: [{ name: 'Skill', checkValue: 10 }], saves: [{ name: 'Save', checkValue: 5 }] },
    badStatuses: thresholds ? INFINITE_HORROR_BAD_STATUS_DEFS.map(definition => ({
      id: definition.id, name: definition.name, light: 2, severe: 4, destruction: 7,
    })) : [],
    combat: { attacks: [{ name: 'Attack' }], defenses: [{ name: 'Defense' }] }, source: { type: sourceType },
  }, { variantId: 'primary', variantName: 'Primary' }) };
  result.effects = [];
  result.system.runtime.health = { mode, maxOverride: null, current, wounds };
  return result;
}

function compare(input, statuses = []) {
  const before = structuredClone(input);
  const full = deriveInfiniteHorrorActor(input, { effects: statuses });
  const expectedInputs = full ? { health: full.health, badStatuses: full.badStatuses } : null;
  assert.deepEqual(deriveInfiniteHorrorStatusInputs(input, { effects: statuses }), expectedInputs);
  const actual = deriveInfiniteHorrorStatuses(input, { statuses });
  assert.deepEqual(actual, deriveFullActorStatusReference(input, { statuses }));
  assert.deepEqual(input, before);
  return actual;
}

const ids = values => values.map(status => status.definitionId);
const disabled = { canMove: false, canInteract: false, canActInCombat: false };

test('status-only derivation retains independent simple HP and B/L/A death and unconscious goldens', () => {
  const cases = [
    [{ hp: 5, current: 5 }, []],
    [{ hp: 5, current: 1 }, []],
    [{ hp: 5, current: 0 }, ['derived-dead']],
    [{ hp: 0, current: 0 }, []],
    [{ mode: 'wound-track', wounds: { bashing: 1, lethal: 1, aggravated: 1 } },
      ['derived-wound-b', 'derived-wound-l', 'derived-wound-a']],
    [{ mode: 'wound-track', wounds: { bashing: 2, lethal: 3, aggravated: 0 } },
      ['derived-unconscious', 'derived-wound-b', 'derived-wound-l']],
    [{ mode: 'wound-track', wounds: { bashing: 0, lethal: 4, aggravated: 1 } },
      ['derived-unconscious', 'derived-wound-l', 'derived-wound-a']],
    [{ mode: 'wound-track', wounds: { bashing: 0, lethal: 0, aggravated: 5 } },
      ['derived-dead', 'derived-wound-a']],
    [{ hp: 0, mode: 'wound-track', wounds: { bashing: 2, lethal: 3, aggravated: 5 } }, []],
  ];
  for (const [settings, expected] of cases) {
    const result = compare(actor(settings));
    assert.deepEqual(ids(result), expected, JSON.stringify(settings));
    assert.equal(result.every(status => status.derived && status.readOnly && status.readonly && status.enabled), true);
    const incapacitated = result.find(status => ['derived-dead', 'derived-unconscious'].includes(status.definitionId));
    if (incapacitated) assert.deepEqual(incapacitated.capabilities, disabled);
  }
});

test('all 21 bad status definitions preserve exact, highest-threshold and zero-disabled threshold goldens', () => {
  for (const definition of INFINITE_HORROR_BAD_STATUS_DEFS) {
    for (const [current, level] of [[0, null], [1, null], [2, 'light'], [3, 'light'],
      [4, 'severe'], [6, 'severe'], [7, 'destruction'], [101, 'destruction']]) {
      const input = actor(); input.system.runtime.badStatuses[definition.id] = current;
      const result = compare(input);
      assert.deepEqual(ids(result), level ? [`derived-bad-${definition.id}-${level}`] : []);
      if (level) {
        assert.equal(result[0].targetId, input.id);
        assert.equal(result[0].stacks, Math.min(99, current));
      }
    }
  }
  const unordered = actor();
  unordered.system.forms[0].badStatuses = [{ id: 'edge', name: 'Edge', light: 9, severe: 3, destruction: 2 }];
  unordered.system.runtime.badStatuses = { edge: 3 };
  assert.deepEqual(ids(compare(unordered)), ['derived-bad-edge-destruction']);
  unordered.system.forms[0].badStatuses[0] = { id: 'edge', name: 'Edge', light: 0, severe: -1, destruction: 0 };
  assert.deepEqual(ids(compare(unordered)), []);
});

test('effect-aware Health keeps all change modes, stack order, disabled effects and legacy HP aliases', () => {
  const input = actor({ hp: 5, mode: 'wound-track', wounds: { bashing: 0, lethal: 0, aggravated: 5 } });
  const effects = [
    { id: 'health-a', stacks: 2, changes: [{ target: 'resources.hp.max', mode: 'add', value: 2 }] },
    { id: 'health-b', changes: [{ target: 'system.health.max', mode: 'multiply', value: 2, priority: 1 }] },
    { id: 'health-disabled', enabled: false, changes: [{ target: 'health.max', mode: 'set', value: 0 }] },
    { id: 'other-field', changes: [{ target: 'attributes.strength', mode: 'add', value: 999 }] },
  ];
  const alive = compare(input, effects);
  assert.deepEqual(ids(alive), ['derived-wound-a']);
  assert.equal(deriveInfiniteHorrorStatusInputs(input, { effects }).health.max, 18);
  for (const [mode, value, expectedMax] of [['set', 3, 3], ['min', 3, 3], ['max', 8, 8], ['multiply', 2, 10]]) {
    const statuses = [{ id: `health-${mode}`, changes: [{ target: 'health.max', mode, value }] }];
    compare(input, statuses);
    assert.equal(deriveInfiniteHorrorStatusInputs(input, { effects: statuses }).health.max, expectedMax);
  }
  input.system.runtime.health.maxOverride = 10;
  const override = [{ id: 'health-boost', changes: [{ target: 'health.max', mode: 'add', value: 2 }] }];
  compare(input, override);
  assert.equal(deriveInfiniteHorrorStatusInputs(input, { effects: override }).health.max, 12);
  input.system.runtime.health.maxOverride = null;
  input.effects = effects;
  assert.deepEqual(ids(compare(input)), ['derived-dead', 'derived-wound-a'],
    'explicit empty status resolution must still override inline Actor effects');
  assert.equal(deriveInfiniteHorrorStatusInputs(input).health.max, 18);
});

test('morphs preserve health runtime and use only the selected form thresholds with first-form fallback', () => {
  const input = actor({ hp: 5, current: 0 });
  const secondary = structuredClone(input.system.forms[0]); secondary.id = 'secondary'; secondary.name = 'Secondary';
  secondary.healthBase.baseMax = 9;
  secondary.badStatuses[0] = { ...secondary.badStatuses[0], light: 5, severe: 8, destruction: 10 };
  input.system.forms.push(secondary);
  input.system.runtime.badStatuses['bad-status-32'] = 4;
  assert.deepEqual(ids(compare(input)), ['derived-dead', 'derived-bad-bad-status-32-severe']);
  input.system.currentFormId = 'secondary';
  assert.deepEqual(ids(compare(input)), ['derived-dead']);
  input.system.runtime.health.current = 7;
  assert.deepEqual(ids(compare(input)), []);
  input.system.currentFormId = 'missing-form';
  assert.deepEqual(ids(compare(input)), ['derived-bad-bad-status-32-severe']);
  assert.equal(deriveInfiniteHorrorStatusInputs(input).health.current, 5);
});

test('legacy HP, resistance threshold saves and top-level Actor forms keep full migration semantics', () => {
  const input = actor({ sourceType: 'xlsx' });
  const form = input.system.forms[0];
  form.resourceBases.hp = { baseMax: 6 }; delete form.healthBase; delete form.badStatuses;
  form.checks.saves = Array.from({ length: 6 }, (_, index) => ({
    name: `Legacy ${index}`, light: index + 1, severe: index + 3, devastating: index + 5,
  }));
  delete input.system.runtime.health;
  input.system.runtime.resources.hp = { current: 0, maxOverride: 8 };
  input.system.runtime.badStatuses = { 'bad-status-32': 3, 'bad-status-52': 7 };
  assert.deepEqual(ids(compare(input)), ['derived-unconscious', 'derived-wound-b',
    'derived-bad-bad-status-32-severe', 'derived-bad-bad-status-52-light']);
  const legacy = { id: input.id, name: input.name, forms: input.system.forms,
    currentFormId: 'primary', runtime: input.system.runtime, effects: [] };
  assert.deepEqual(compare(legacy), compare(input));
  const malformed = actor();
  malformed.system.forms[0].resourceBases.hp = { max: 4 };
  malformed.system.forms[0].healthBase = { max: 3 };
  malformed.system.runtime.health = { mode: 'simple', current: 0, maxOverride: '4.8' };
  assert.deepEqual(ids(compare(malformed)), ['derived-dead']);
});

test('null, absent and filtered-out forms never invent Health or status output', () => {
  for (const input of [null, {}, { id: 'empty', system: { forms: [], runtime: {} } },
    { id: 'empty', system: { forms: [null, false], runtime: {} } }]) {
    assert.deepEqual(compare(input), []);
    const result = deriveInfiniteHorrorStatusInputs(input);
    assert.deepEqual(result, input ? { health: null, badStatuses: [] } : null);
  }
});

test('specialized status inputs omit unrelated resolved sheet clones and never share private output', () => {
  const input = actor();
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  globalThis.structuredClone = value => { clones += 1; return originalClone(value); };
  let fullClones, fastClones;
  try {
    deriveInfiniteHorrorActor(input); fullClones = clones;
    clones = 0; deriveInfiniteHorrorStatusInputs(input); fastClones = clones;
  } finally { globalThis.structuredClone = originalClone; }
  assert.ok(fullClones > fastClones, `full ${fullClones}, specialized ${fastClones}`);
  const first = deriveInfiniteHorrorStatusInputs(input);
  first.health.current = 0; first.badStatuses[0].current = 999;
  assert.equal(deriveInfiniteHorrorStatusInputs(input).health.current, 5);
  assert.equal(deriveInfiniteHorrorStatusInputs(input).badStatuses[0].current, 0);
  input.system.runtime.health.current = 0;
  assert.deepEqual(ids(compare(input)), ['derived-dead']);
  const other = actor({ current: 4 }); other.id = 'other-private-actor';
  assert.deepEqual(compare(other), []);
});
