import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeActorDocument, resolveActorAttribute } from '../src/actor/index.js';

function actorFixture() {
  return normalizeActorDocument({
    id: 'actor-health-paths',
    name: 'Health Path Fixture',
    effects: [{
      id: 'legacy-max-buff',
      enabled: true,
      stacks: 1,
      changes: [{ target: 'resources.hp.max', mode: 'add', value: 2 }],
    }],
    system: {
      schemaVersion: 3,
      currentFormId: 'form-health-paths',
      forms: [{
        id: 'form-health-paths',
        name: '默认形态',
        healthBase: { baseMax: 10 },
        resourceBases: {},
        attributes: [],
        checks: { skills: [], saves: [] },
        badStatuses: [],
        combat: { attacks: [], defenses: [] },
        tokenAppearance: { color: '#3d9b63', scale: 1 },
        source: { type: 'manual' },
      }],
      runtime: {
        resources: {},
        customResources: [],
        attributeAdjustments: {},
        badStatuses: {},
        health: { mode: 'simple', current: 6, maxOverride: null },
      },
    },
  });
}

test('legacy HP path compatibility is max-only and never exposes current HP as a Resource', () => {
  const actor = actorFixture();

  assert.equal(resolveActorAttribute(actor, 'system.health.current'), 6);
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.current'), null);
  assert.equal(resolveActorAttribute(actor, 'resources.hp.current'), null);

  assert.equal(resolveActorAttribute(actor, 'system.health.max'), 12);
  assert.equal(resolveActorAttribute(actor, 'system.resources.hp.max'), 12);
  assert.equal(resolveActorAttribute(actor, 'resources.hp.max'), 12);
});
