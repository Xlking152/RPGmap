import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performActorHealthOperation, resolveActorHealth } from '../src/health/actor.js';
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
        resourceDefinitions: [{ id: 'hp', name: 'Counter', kind: 'hp' }],
        badStatusDefinitions: [],
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
      currentFormId: 'form-test',
      forms: [{ id: 'form-test', source: { type: 'test' }, resourceBases: { hp: { id: 'hp', baseMax: 10 } } }],
      runtime: { resources: { hp: { current: 4, maxOverride: null } }, health: { value: 4 } },
      effects: [],
    };
    const result = performActorHealthOperation(actor, { type: 'increment', amount: 3 });
    assert.equal(result.changed, true);
    assert.equal(resolveActorHealth(actor).current, 7);
    assert.equal(actor.runtime.resources.hp.current, 7);

    assert.deepEqual(getStatusDefinitions({ statusDefinitions: [] }), []);
    const resolved = resolveStatuses({ schemaVersion: 3, statusDefinitions: [], actors: [actor], tokens: [] }, { actorId: actor.id });
    assert.deepEqual(resolved.derivedStatuses.map(status => status.definitionId), ['custom-derived']);
  } finally {
    setActiveRuleset(originalId);
  }
});
