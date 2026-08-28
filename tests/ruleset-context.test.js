import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeActorDocument,
  performActorOperation,
} from '../src/actor/index.js';
import { addEffect } from '../src/entities/resolver.js';
import { parseCharacterSheets } from '../src/entities/xlsx-importer.js';
import { describeHealth } from '../src/health/model.js';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { setActiveRuleset } from '../src/ruleset/index.js';
import { resolveStatuses } from '../src/status/model.js';

function contextualRuleset(id) {
  return prepareRuleset({
    apiVersion: 1,
    id,
    title: `Ruleset ${id}`,
    version: '1.0.0',
    actor: {
      migrateLegacy: actor => ({
        name: actor?.name || id,
        system: actor?.system || { value: 0 },
      }),
      normalizeSystem: system => ({ ...structuredClone(system || {}), normalizedBy: id }),
      derive: actor => ({
        id: actor.id,
        name: actor.name,
        health: { current: Number(actor.system.value) || 0, max: 10, status: id },
      }),
      attributePaths: () => [{ path: 'system.value', label: id, kind: 'number' }],
      resolveAttribute: (actor, path) => path === 'system.value' ? actor.system.value : null,
    },
    health: {
      presentation: {
        describe: state => ({
          summary: `${id}:${state.current}`,
          status: id,
          segments: [],
          fields: [],
        }),
      },
    },
    statuses: {
      definitions: [],
      derive: actor => actor ? [{
        id: `${id}:derived`,
        definitionId: `${id}:derived`,
        label: id,
        enabled: true,
        derived: true,
        readOnly: true,
        capabilities: {},
        changes: [],
      }] : [],
    },
    importers: {
      xlsx: {
        parse: () => ({ parsedBy: id }),
      },
    },
  });
}

test('explicit Ruleset contexts stay isolated when two runtimes interleave', () => {
  const first = contextualRuleset('context-first');
  const second = contextualRuleset('context-second');
  setActiveRuleset('infinite-horror');

  const firstActor = normalizeActorDocument({ id: 'actor-a', name: 'A', system: { value: 3 } }, { ruleset: first });
  const secondActor = normalizeActorDocument({ id: 'actor-b', name: 'B', system: { value: 7 } }, { ruleset: second });
  assert.equal(firstActor.system.normalizedBy, 'context-first');
  assert.equal(secondActor.system.normalizedBy, 'context-second');

  const firstStatuses = resolveStatuses({ actors: [firstActor], tokens: [], statusDefinitions: [] }, {
    actorId: firstActor.id,
    ruleset: first,
  });
  const secondStatuses = resolveStatuses({ actors: [secondActor], tokens: [], statusDefinitions: [] }, {
    actorId: secondActor.id,
    ruleset: second,
  });
  assert.deepEqual(firstStatuses.derivedStatuses.map(status => status.label), ['context-first']);
  assert.deepEqual(secondStatuses.derivedStatuses.map(status => status.label), ['context-second']);
  assert.equal(describeHealth({ current: 3 }, { ruleset: first }).summary, 'context-first:3');
  assert.equal(describeHealth({ current: 7 }, { ruleset: second }).summary, 'context-second:7');
  assert.deepEqual(parseCharacterSheets({}, { ruleset: first }), { parsedBy: 'context-first' });
  assert.deepEqual(parseCharacterSheets({}, { ruleset: second }), { parsedBy: 'context-second' });
});

test('Ruleset Contract keeps private data behind operations and reports unknown boundaries', () => {
  const ruleset = contextualRuleset('contract-errors');
  assert.equal(Object.hasOwn(ruleset.actor, 'badStatusDefinitions'), false);
  const actor = normalizeActorDocument({ id: 'actor-a', name: 'A', system: { value: 4 } }, { ruleset });
  const before = structuredClone(actor.system);
  const result = performActorOperation(actor, { type: 'private.write', path: 'system.value', value: 99 }, { ruleset });
  assert.deepEqual(result, { changed: false, blocked: 'unknown_actor_operation' });
  assert.deepEqual(actor.system, before);

  const effect = addEffect(actor, {
    changes: [{ target: 'value', mode: 'add', value: 2 }],
  }, { ruleset });
  assert.equal(effect.changes[0].target, 'system.value');
  assert.throws(() => addEffect(actor, {
    changes: [{ target: 'system.secret', mode: 'add', value: 1 }],
  }, { ruleset }), error => error.code === 'unknown_actor_attribute_path');

  const noImporter = prepareRuleset({
    apiVersion: 1,
    id: 'no-importer',
    title: 'No Importer',
    version: '1.0.0',
  });
  assert.throws(() => parseCharacterSheets({}, { ruleset: noImporter }), error => error.code === 'ruleset_capability_missing');
});
