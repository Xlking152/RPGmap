import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performActorHealthOperation, resolveActorHealth } from '../src/health/actor.js';
import {
  describeActorSheet,
  listActorAttributePaths,
  normalizeActorDocument,
  performActorOperation,
  resolveActorAttribute,
  validateActorDocument,
} from '../src/actor/index.js';
import { getActiveRuleset, rulesetRegistry, setActiveRuleset } from '../src/ruleset/index.js';
import { getStatusDefinitions, resolveStatuses } from '../src/status/model.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

async function sourceFiles(root, { skip = () => false } = {}) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (skip(target)) continue;
      if (entry.isDirectory()) await visit(target);
      else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
    }
  }
  await visit(root);
  return files;
}

test('Core and local server sources do not embed Infinite Horror health or status vocabulary', async () => {
  const roots = [path.join(repositoryRoot, 'src'), path.join(repositoryRoot, 'deployment', 'local-server')];
  const files = (await Promise.all(roots.map(root => sourceFiles(root, {
    skip: target => target.includes(`${path.sep}src${path.sep}rulesets${path.sep}`),
  })))).flat();
  const forbidden = [
    /status-(?:spirit|rooted|incapacitated)/,
    /\b(?:bashing|lethal|aggravated)\b/,
    /wound-track/,
    /derived-wound/,
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, path.relative(repositoryRoot, file));
  }
});

test('minimal ruleset controls runtime operations, presentation, and derived statuses without Core defaults', () => {
  const originalId = getActiveRuleset().id;
  const fakeId = 'contract-boundary-test';
  if (!rulesetRegistry.has(fakeId)) {
    rulesetRegistry.register({
      apiVersion: 1,
      id: fakeId,
      title: 'Contract Boundary Test',
      version: '1.0.0',
      actor: {
        resourceDefinitions: [],
        badStatusDefinitions: [],
        createDefault: () => ({ name: 'Counter Actor', system: { value: 0, limit: 10 } }),
        createFromImport: imported => ({ name: imported?.name || 'Counter Actor', system: { value: Number(imported?.value) || 0, limit: 10 } }),
        migrateLegacy: actor => ({ name: actor?.name || 'Counter Actor', system: actor?.system || { value: Number(actor?.legacyValue) || 0, limit: 10 } }),
        normalizeSystem: system => ({ value: Number(system?.value) || 0, limit: Number(system?.limit) || 10 }),
        validateSystem: system => Number.isFinite(system?.value) ? [] : ['system.value must be finite'],
        derive: actor => ({
          id: actor.id,
          name: actor.name,
          health: { mode: 'counter', max: actor.system.limit, current: actor.system.value },
        }),
        attributePaths: () => [{ path: 'system.value', label: 'Counter', kind: 'number' }],
        resolveAttribute: (actor, path) => path === 'system.value' ? actor.system.value : null,
        applyRuntimeOperation(actor, operation) {
          if (operation?.type === 'counter.increment') {
            actor.system.value += Number(operation.amount) || 0;
            return { changed: true, value: actor.system.value };
          }
          if (operation?.type === 'health.runtime' && operation.operation?.type === 'increment') {
            actor.system.value += Number(operation.operation.amount) || 0;
            return { changed: true, value: { mode: 'counter', max: actor.system.limit, current: actor.system.value } };
          }
          return { changed: false, blocked: 'unsupported' };
        },
        presentation: {
          describe: actor => ({ name: actor.name, avatarDataUrl: null, color: '#225588', variantLabel: 'Counter' }),
          describeSheet: actor => ({
            actorId: actor.id,
            currentVariantId: null,
            variants: [],
            tabs: [{ id: 'counter', label: 'Counter', sections: [{ type: 'text', blocks: [String(actor.system.value)] }] }],
          }),
        },
      },
      health: {
        supportedModes: ['counter'],
        defaultModeForSource: () => 'counter',
        createRuntime: ({ simpleCurrent = 0 } = {}) => ({ value: Number(simpleCurrent) || 0 }),
        normalizeRuntime: (runtime, { simpleCurrent = 0 } = {}) => ({ value: Number(runtime?.value ?? simpleCurrent) || 0 }),
        resolve: (runtime, { max = 0 } = {}) => ({ mode: 'counter', max, current: Number(runtime?.value) || 0 }),
        switchMode: (runtime, _mode, { simpleCurrent = 0 } = {}) => ({ runtime, simpleCurrent }),
        applyRuntimeOperation(runtime, operation) {
          if (operation?.type !== 'increment') return { runtime, current: runtime.value, changed: false, blocked: 'unsupported' };
          const next = { value: runtime.value + Number(operation.amount || 0) };
          return { runtime: next, current: next.value, state: { mode: 'counter', current: next.value }, changed: true };
        },
        applyDamage: ({ runtime, current }) => ({ runtime, current, applied: 0, overflow: 0 }),
        applyHealing: ({ runtime, current }) => ({ runtime, current, applied: 0, overflow: 0 }),
        presentation: {
          modes: [{ id: 'counter', label: 'Counter' }],
          operations: {},
          describe: state => ({ summary: `Counter ${state.current}`, status: 'custom', segments: [], fields: [] }),
        },
      },
      statuses: {
        definitions: [{
          id: 'custom-built-in', name: 'Custom Built-in', icon: 'star', color: '#225588', category: 'trait',
          scopes: ['actor'], maxStacks: 1, changes: [], capabilities: {}, builtIn: true,
        }],
        derive: actor => actor ? [{
          id: 'custom-derived:derived', definitionId: 'custom-derived', label: 'Custom Derived', name: 'Custom Derived',
          enabled: true, derived: true, readOnly: true, capabilities: {}, changes: [],
        }] : [],
      },
      importers: {},
    });
  }

  setActiveRuleset(fakeId);
  try {
    const actor = {
      id: 'actor-test',
      name: 'Counter Actor',
      system: { value: 4, limit: 10 },
      effects: [],
    };
    const result = performActorHealthOperation(actor, { type: 'increment', amount: 3 });
    assert.equal(result.changed, true);
    assert.equal(resolveActorHealth(actor).current, 7);
    assert.equal(actor.system.value, 7);
    assert.deepEqual(listActorAttributePaths(actor).map(item => item.path), ['system.value']);
    assert.equal(resolveActorAttribute(actor, 'system.value'), 7);
    assert.equal(performActorOperation(actor, { type: 'counter.increment', amount: 2 }).value, 9);
    assert.deepEqual(validateActorDocument(normalizeActorDocument({ id: 'legacy', name: 'Legacy', legacyValue: 5 })), []);
    assert.deepEqual(describeActorSheet(actor).tabs.map(tab => tab.id), ['counter']);
    assert.equal(Object.hasOwn(actor.system, 'health'), false);
    assert.equal(Object.hasOwn(actor.system, 'forms'), false);

    assert.deepEqual(getStatusDefinitions({ statusDefinitions: [] }), []);
    const resolved = resolveStatuses({ schemaVersion: 3, statusDefinitions: [], actors: [actor], tokens: [] }, { actorId: actor.id });
    assert.deepEqual(resolved.derivedStatuses.map(status => status.definitionId), ['custom-derived']);
  } finally {
    setActiveRuleset(originalId);
  }
});
