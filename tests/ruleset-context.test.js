import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listActorAttributePaths,
  normalizeActorDocument,
  performActorOperation,
  resolveActorAttribute,
} from '../src/actor/index.js';
import { parseActorSheets } from '../src/entities/xlsx-importer.js';
import { describeHealth } from '../src/health/model.js';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { setActiveRuleset } from '../src/ruleset/index.js';
import { resolveActorEffects, resolveStatuses } from '../src/status/model.js';

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
      derive: (actor, context = {}) => ({
        id: actor.id,
        name: actor.name,
        health: { current: Number(actor.system.value) || 0, max: 10, status: id },
        effects: context.effects || [],
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
  assert.deepEqual(parseActorSheets({}, { ruleset: first }), { parsedBy: 'context-first' });
  assert.deepEqual(parseActorSheets({}, { ruleset: second }), { parsedBy: 'context-second' });
});

test('Ruleset Contract keeps private data behind operations and StatusDefinition effects stay external to Actor instances', () => {
  const ruleset = contextualRuleset('contract-errors');
  assert.equal(Object.hasOwn(ruleset.actor, 'badStatusDefinitions'), false);
  const actor = normalizeActorDocument({ id: 'actor-a', name: 'A', system: { value: 4 } }, { ruleset });
  const before = structuredClone(actor.system);
  const result = performActorOperation(actor, { type: 'private.write', path: 'system.value', value: 99 }, { ruleset });
  assert.deepEqual(result, { changed: false, blocked: 'unknown_actor_operation' });
  assert.deepEqual(actor.system, before);

  actor.effects = [{
    id: 'effect-value',
    definitionId: 'status-value',
    stacks: 1,
    enabled: true,
  }];
  const effects = resolveActorEffects(actor, [{
    id: 'status-value',
    name: 'Value Bonus',
    scopes: ['actor'],
    maxStacks: 1,
    changes: [{ target: 'system.value', mode: 'add', value: 2 }],
    capabilities: {},
  }]);
  assert.equal('changes' in actor.effects[0], false);
  assert.deepEqual(effects[0].changes, [{ target: 'system.value', mode: 'add', value: 2 }]);
  assert.deepEqual(listActorAttributePaths(actor, { ruleset }).map(item => item.path), ['system.value']);
  assert.equal(resolveActorAttribute(actor, 'system.value', { ruleset }), 4);
  assert.equal(resolveActorAttribute(actor, 'system.secret', { ruleset }), null);

  const noImporter = prepareRuleset({
    apiVersion: 1,
    id: 'no-importer',
    title: 'No Importer',
    version: '1.0.0',
  });
  assert.throws(() => parseActorSheets({}, { ruleset: noImporter }), error => error.code === 'ruleset_capability_missing');
});
