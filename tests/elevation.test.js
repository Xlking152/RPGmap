import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenForActor, normalizeEntityState } from '../src/entities/model.js';
import {
  featureBlockingHeightFt,
  featureBlocksMover,
  normalizeElevationFt,
  normalizeTokenDiameterMeters,
  tokenDiameterMeters,
  tokenElevationFt,
} from '../src/elevation/model.js';
import {
  configureElevationNavigationRuntime,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
} from '../src/elevation/runtime-context.js';
import { createNavigationGrid, NAVIGATION_TILES } from '../src/engine/navigation.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import {
  LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT,
  LANZHOU_OPENABLE_FEATURE_IDS,
  applyLanzhouCapabilities,
} from '../reference/maps/lanzhou/capabilities.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';

function simpleFeature(height = 20) {
  return {
    id: 'obstacle-a',
    name: 'Obstacle A',
    category: 'generic',
    geometry: { type: 'polygon', points: [[20, 20], [50, 20], [50, 50], [20, 50]] },
    capabilities: {
      navigation: { blocks: true, blockingHeightFt: height },
    },
  };
}

function simpleMap(feature = simpleFeature()) {
  return {
    width: 100,
    height: 100,
    navigation: { cellSizeMeters: 10, bridgeFeatureIds: [] },
    roadBuffers: [],
    liquidBodies: [],
    floodRules: {},
    features: [feature],
  };
}

test('Token elevationFt defaults to zero and normalizes as a non-negative value', () => {
  const token = createTokenForActor('actor-a', 'token-a');
  assert.equal(token.elevationFt, 0);
  assert.equal(tokenElevationFt(token), 0);
  assert.equal(normalizeElevationFt(35), 35);
  assert.equal(normalizeElevationFt(-10), 0);

  const normalized = normalizeEntityState({
    actors: [{ id: 'actor-a', forms: [], runtime: {} }],
    tokens: [{ id: 'token-a', actorId: 'actor-a', elevationFt: 45 }],
  });
  assert.equal(normalized.tokens[0].elevationFt, 45);
});

test('Token diameter is constrained and legacy size only migrates at supported values', () => {
  assert.equal(createTokenForActor('actor-a', 'token-a').diameterMeters, 1);
  assert.equal(createTokenForActor('actor-a', 'token-a', { diameterMeters: 10 }).diameterMeters, 10);
  assert.equal(normalizeTokenDiameterMeters(7), 1);
  const normalized = normalizeEntityState({
    actors: [{ id: 'actor-a', forms: [], runtime: {} }],
    tokens: [
      { id: 'valid', actorId: 'actor-a', size: 5 },
      { id: 'invalid', actorId: 'actor-a', size: 9 },
    ],
  });
  assert.equal(normalized.tokens[0].diameterMeters, 5);
  assert.equal(normalized.tokens[0].size, undefined);
  assert.equal(normalized.tokens[1].diameterMeters, 1);
  assert.equal(tokenDiameterMeters(normalized.tokens[0]), 5);
});

test('Feature height blocking uses strict greater-than clearance and supports World override', () => {
  const feature = simpleFeature(20);
  assert.equal(featureBlockingHeightFt(feature), 20);
  assert.equal(featureBlocksMover(feature, null, { elevationFt: 20 }), true, 'equal height must still block');
  assert.equal(featureBlocksMover(feature, null, { elevationFt: 21 }), false, 'strictly higher mover clears obstacle');

  const featureState = { custom: { blockingHeightFt: 40 } };
  assert.equal(featureBlockingHeightFt(feature, featureState), 40);
  assert.equal(featureBlocksMover(feature, featureState, { elevationFt: 30 }), true);
  assert.equal(featureBlocksMover(feature, featureState, { elevationFt: 41 }), false);
});

test('Feature without blockingHeightFt preserves legacy infinite-height blocking', () => {
  const feature = simpleFeature();
  feature.capabilities.navigation = { blocks: true };
  assert.equal(featureBlockingHeightFt(feature), null);
  assert.equal(featureBlocksMover(feature, null, { elevationFt: 10000 }), true);
});

test('MapPackage contract normalizes height and separate blocking/passage polygons', () => {
  const makePackage = (blockingHeightFt) => ({
    id: 'height-contract-test',
    version: '1.0.0',
    width: 100,
    height: 100,
    layers: ['base'],
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    features: [{
      id: 'wall-a',
      category: 'generic',
      capabilities: {
        navigation: {
          blocks: true,
          blockingHeightFt,
          blockingPolygon: [[10, 40], [90, 40], [90, 60], [10, 60]],
          passagePolygon: [[45, 30], [55, 30], [55, 70], [45, 70]],
        },
      },
    }],
  });
  const prepared = prepareMapPackage(makePackage(25));
  assert.equal(prepared.features[0].capabilities.navigation.blockingHeightFt, 25);
  assert.deepEqual(prepared.features[0].capabilities.navigation.blockingPolygon[0], [10, 40]);
  assert.deepEqual(prepared.features[0].capabilities.navigation.passagePolygon[0], [45, 30]);
  assert.throws(() => prepareMapPackage(makePackage(-1)), /blockingHeightFt/);
});

test('Navigation grid ignores a height-aware Feature only when Token elevation is greater', () => {
  const map = simpleMap();
  const appState = { sceneEvents: [], preferences: { featureStates: {} } };
  const atHeight = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { tokenId: 'token-a', elevationFt: 20 },
  });
  const aboveHeight = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { tokenId: 'token-a', elevationFt: 21 },
  });
  assert.equal(atHeight.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.blocked);
  assert.equal(aboveHeight.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.open);
});

test('Navigation uses blockingPolygon instead of visible Feature geometry when declared', () => {
  const feature = simpleFeature(20);
  feature.geometry.points = [[40, 40], [60, 40], [60, 60], [40, 60]];
  feature.capabilities.navigation.blockingPolygon = [[10, 40], [90, 40], [90, 60], [10, 60]];
  const navigation = createNavigationGrid(simpleMap(feature), {}, null, {
    appState: { sceneEvents: [], preferences: { featureStates: {} } },
    moverContext: { tokenId: 'token-a', elevationFt: 0 },
  });
  assert.equal(navigation.tileAt({ x: 25, y: 45 }), NAVIGATION_TILES.blocked, 'declared blocker must extend beyond visible geometry');
});

test('Feature State blockingHeightFt override participates in Token-aware Navigation', () => {
  const map = simpleMap();
  const appState = {
    sceneEvents: [],
    preferences: {
      featureStates: {
        'obstacle-a': { custom: { blockingHeightFt: 40 } },
      },
    },
  };
  const belowOverride = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { tokenId: 'token-a', elevationFt: 30 },
  });
  const aboveOverride = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { tokenId: 'token-a', elevationFt: 41 },
  });
  assert.equal(belowOverride.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.blocked);
  assert.equal(aboveOverride.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.open);
});

test('cached Navigation facade refreshes when active Token elevation and Feature height change', () => {
  const map = simpleMap();
  const appState = { sceneEvents: [], preferences: { featureStates: {} } };
  configureElevationNavigationRuntime({ getState: () => appState });
  try {
    setActiveMoverContext({ tokenId: 'token-ground', elevationFt: 0 });
    const cachedNavigation = createNavigationGrid(map, {});
    assert.equal(cachedNavigation.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.blocked);

    setActiveMoverContext({ tokenId: 'token-flyer', elevationFt: 30 });
    assert.equal(cachedNavigation.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.open, 'cached facade must refresh for another Token');

    appState.preferences.featureStates['obstacle-a'] = { custom: { blockingHeightFt: 40 } };
    assert.equal(cachedNavigation.tileAt({ x: 25, y: 25 }), NAVIGATION_TILES.blocked, 'cached facade must refresh for Feature State override');
  } finally {
    resetElevationNavigationRuntime();
  }
});

test('Minimal Reference and Lanzhou Reference provide explicit height-aware obstacles', () => {
  const minimal = createMinimalReferencePackage();
  assert.equal(minimal.features.find((feature) => feature.id === 'demo-house').capabilities.navigation.blockingHeightFt, 15);
  assert.equal(minimal.features.find((feature) => feature.id === 'demo-door').capabilities.navigation.blockingHeightFt, 8);
  assert.equal(minimal.features.find((feature) => feature.id === 'demo-wall').capabilities.navigation.blockingHeightFt, 12);

  const source = createLanzhouMapPackage();
  const features = applyLanzhouCapabilities(source.features, source.navigation);
  for (const feature of features.filter((item) => item.category === 'building' || item.category === 'wall')) {
    assert.ok(Number.isFinite(feature.capabilities?.navigation?.blockingHeightFt), `missing Lanzhou height for ${feature.id}`);
  }
  for (const featureId of LANZHOU_OPENABLE_FEATURE_IDS) {
    const feature = features.find((item) => item.id === featureId);
    assert.ok(feature, `missing Lanzhou openable ${featureId}`);
    assert.equal(feature.capabilities.navigation.blockingHeightFt, LANZHOU_DEFAULT_BLOCKING_HEIGHT_FT.openable);
    assert.ok(feature.capabilities.navigation.blockingPolygon?.length >= 4, `missing closed blocker for ${featureId}`);
    assert.ok(feature.capabilities.navigation.passagePolygon?.length >= 4, `missing open passage for ${featureId}`);
  }
});
