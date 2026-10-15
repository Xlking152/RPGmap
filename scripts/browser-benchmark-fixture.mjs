import { normalizeWorldV2, projectWorldV2ToRuntimeState } from '../src/world/model.js';

export const BROWSER_BENCHMARK_ACTOR_COUNT = 100;
export const BROWSER_BENCHMARK_TIMESTAMP = '2026-01-01T00:00:00.000Z';

// The original benchmark input remains available verbatim for regression.
// In particular system:{} and omitted Actor document defaults reproduce its
// pre-canonical import shape; do not hide that shape in the readiness reader.
export function createRawBrowserBenchmarkFixture(definitions, tokenCount = 500) {
  const actors = Array.from({ length: BROWSER_BENCHMARK_ACTOR_COUNT }, (_, index) => ({
    id: `browser-actor-${index}`, name: `Browser Actor ${index}`, type: 'pc', partyId: 'browser-party',
    system: {}, effects: [], notes: '', ownership: {},
  }));
  const tokens = Array.from({ length: tokenCount }, (_, index) => ({
    id: `browser-token-${index}`, actorId: `browser-actor-${index % BROWSER_BENCHMARK_ACTOR_COUNT}`,
    actorLink: true, actorDelta: null, placement: 'map',
    x: 2900 + (index % 25) * 2, y: 2500 + Math.floor(index / 25) * 2,
    featureId: null, diameterMeters: 1, rotation: 0, elevationMeters: 0,
    locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: 80, vagueRangeOverrideMeters: 120, overrideUserIds: [] },
    movement: { mode: 'walk', budgetMetersPerTurn: null, spentMeters: 0, adjudicationRequired: false },
  }));
  const scene = {
    id: 'scene-northern-song-lanzhou-1104', name: 'Browser Performance Scene',
    mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.1.0' },
    tokens, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
    settings: { gridVisible: true, lineOfSightEnabled: false },
  };
  const world = {
    schemaVersion: 4, id: 'browser-performance-world', name: 'Browser Performance World',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: scene.id,
    actors, statusDefinitions: definitions, scenes: [scene], journals: [], templateLibrary: {},
    createdAt: BROWSER_BENCHMARK_TIMESTAMP, updatedAt: BROWSER_BENCHMARK_TIMESTAMP,
  };
  return {
    version: 2, mapId: scene.mapPackage.id, mapVersion: scene.mapPackage.version,
    markers: [], attackAreas: [], sceneEvents: [], preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 4, actors: structuredClone(actors), tokens: structuredClone(tokens), statusDefinitions: structuredClone(definitions) },
      combatSystem: { schemaVersion: 2, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  };
}

export function createBrowserBenchmarkFixture({ mapPackage, ruleset, definitions, tokenCount = 500 } = {}) {
  if (mapPackage?.id !== 'northern-song-lanzhou-1104' || mapPackage?.version !== '1.1.0'
    || ruleset?.id !== 'infinite-horror' || ruleset?.version !== '1.1.0') {
    throw new Error('Browser benchmark fixture requires the actual Lanzhou 1.1.0 map and Infinite Horror 1.1.0 Ruleset');
  }
  if (!Number.isInteger(tokenCount) || tokenCount < 1 || tokenCount > 500) throw new Error('Invalid browser benchmark Token count');
  const state = createRawBrowserBenchmarkFixture(definitions, tokenCount), rawWorld = state.preferences.worldV2;
  // Actor normalization supplies these document timestamps. Pin them before
  // normalizing so separate browser reads cannot invent different defaults.
  rawWorld.actors = rawWorld.actors.map(actor => ({ ...actor,
    createdAt: rawWorld.createdAt, updatedAt: rawWorld.updatedAt }));
  const world = normalizeWorldV2(rawWorld, { mapPackage, ruleset });
  return projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
}
