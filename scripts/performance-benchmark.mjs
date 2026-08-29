import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const rootArgument = process.argv.find(value => value.startsWith('--repo='));
const root = path.resolve(rootArgument ? rootArgument.slice('--repo='.length) : '.');
const { applyWorldOperations, projectWorldOperationState } = await import(
  pathToFileURL(path.join(root, 'src', 'world', 'operations.js')).href
);

const ACTOR_COUNT = 100;
const TOKEN_COUNT = 500;
const FEATURE_STATE_COUNT = 1000;
const WARMUP_COUNT = 20;
const OPERATIONS_PER_ROUND = 100;
const ROUND_COUNT = 5;
const NOW = '2026-01-01T00:00:00.000Z';

function actor(index) {
  return { id: `actor-${index}`, name: `Actor ${index}`, system: {}, effects: [], notes: '' };
}

function token(index) {
  return {
    id: `token-${index}`,
    actorId: `actor-${index % ACTOR_COUNT}`,
    actorLink: true,
    actorDelta: null,
    placement: 'map',
    x: index % 100,
    y: Math.floor(index / 100),
    featureId: null,
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    hidden: false,
    locked: false,
    showName: true,
    effects: [],
  };
}

function scene(id, tokens, offset) {
  return {
    id,
    name: id,
    mapPackage: { id: 'benchmark-map', version: '1.0.0' },
    tokens,
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    featureStates: Object.fromEntries(Array.from({ length: FEATURE_STATE_COUNT / 2 }, (_, index) => [
      `feature-${offset + index}`,
      { open: index % 2 === 0, custom: { blockingHeightFt: index % 40, extension: { index } } },
    ])),
    settings: { gridVisible: true },
  };
}

function fixture() {
  const actors = Array.from({ length: ACTOR_COUNT }, (_, index) => actor(index));
  const tokens = Array.from({ length: TOKEN_COUNT }, (_, index) => token(index));
  const scenes = [
    scene('scene-a', tokens.slice(0, TOKEN_COUNT / 2), 0),
    scene('scene-b', tokens.slice(TOKEN_COUNT / 2), FEATURE_STATE_COUNT / 2),
  ];
  return projectWorldOperationState({
    saveVersion: 2,
    mapId: 'benchmark-map',
    mapVersion: '1.0.0',
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    preferences: {
      worldV2: {
        schemaVersion: 2,
        id: 'benchmark-world',
        name: 'Benchmark World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-a',
        actors,
        statusDefinitions: [],
        scenes,
        createdAt: NOW,
        updatedAt: NOW,
      },
      entitySystem: { schemaVersion: 3, actors, tokens: scenes[0].tokens, statusDefinitions: [] },
      combatSystem: { schemaVersion: 1, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  });
}

const operations = {
  tokenMove(index, state) {
    const sceneId = state.preferences.worldV2.activeSceneId;
    const tokenId = state.preferences.worldV2.scenes.find(item => item.id === sceneId).tokens[index % 250].id;
    return [{ type: 'token.move', payload: { sceneId, tokenId, placement: 'map', x: index + 1, y: index + 2 } }];
  },
  featurePatch(index, state) {
    const sceneId = state.preferences.worldV2.activeSceneId;
    const featureId = sceneId === 'scene-a' ? `feature-${index % 500}` : `feature-${500 + (index % 500)}`;
    return [{ type: 'scene.featureState.patch', payload: { sceneId, featureId, patch: { open: index % 2 === 0 } } }];
  },
  sceneSwitch(_index, state) {
    const sceneId = state.preferences.worldV2.activeSceneId === 'scene-a' ? 'scene-b' : 'scene-a';
    return [{ type: 'scene.activate', payload: { sceneId } }];
  },
};

function execute(state, operationFactory, index) {
  return applyWorldOperations(state, operationFactory(index, state), { now: NOW }).state;
}

function round(operationFactory, count) {
  let state = fixture();
  const started = performance.now();
  for (let index = 0; index < count; index += 1) state = execute(state, operationFactory, index);
  return (performance.now() - started) / count;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

const results = {};
for (const [name, operationFactory] of Object.entries(operations)) {
  round(operationFactory, WARMUP_COUNT);
  const rounds = Array.from({ length: ROUND_COUNT }, () => round(operationFactory, OPERATIONS_PER_ROUND));
  results[name] = { medianMs: median(rounds), roundsMs: rounds };
}

console.log(JSON.stringify({
  node: process.version,
  root,
  fixture: {
    scenes: 2,
    actors: ACTOR_COUNT,
    tokens: TOKEN_COUNT,
    featureStates: FEATURE_STATE_COUNT,
    warmup: WARMUP_COUNT,
    operationsPerRound: OPERATIONS_PER_ROUND,
    rounds: ROUND_COUNT,
  },
  results,
}, null, 2));
