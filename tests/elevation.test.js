import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenForActor, normalizeEntityState } from '../src/entities/model.js';
import {
  featureBlockingHeightFt,
  featureBlocksMover,
  normalizeElevationFt,
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

function midpoint(a, b) {
  return { x: (Number(a[0]) + Number(b[0])) / 2, y: (Number(a[1]) + Number(b[1])) / 2 };
}

function gatewayCrossing(gateway, distance = 140) {
  const polygon = gateway?.polygon || [];
  assert.ok(polygon.length >= 4, `gateway ${gateway?.featureId || ''} needs a passage polygon`);
  const near = midpoint(polygon[0], polygon[1]);
  const far = midpoint(polygon[3], polygon[2]);
  const cx = (near.x + far.x) / 2;
  const cy = (near.y + far.y) / 2;
  const dx = far.x - near.x;
  const dy = far.y - near.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  return {
    center: { x: cx, y: cy },
    start: { x: cx - ux * distance, y: cy - uy * distance },
    end: { x: cx + ux * distance, y: cy + uy * distance },
  };
}

function gridCell(navigation, point) {
  return {
    x: Math.max(0, Math.min(navigation.columns - 1, Math.floor(Number(point.x) / navigation.cellSize))),
    y: Math.max(0, Math.min(navigation.rows - 1, Math.floor(Number(point.y) / navigation.cellSize))),
  };
}

function hasLocalGridPath(navigation, startPoint, endPoint, centerPoint, radiusMeters = 240) {
  const grid = navigation.grid;
  const start = gridCell(navigation, startPoint);
  const end = gridCell(navigation, endPoint);
  const center = gridCell(navigation, centerPoint);
  const radius = Math.ceil(radiusMeters / navigation.cellSize);
  const minX = Math.max(0, center.x - radius);
  const maxX = Math.min(navigation.columns - 1, center.x + radius);
  const minY = Math.max(0, center.y - radius);
  const maxY = Math.min(navigation.rows - 1, center.y + radius);
  const key = (x, y) => `${x},${y}`;
  const queue = [start];
  const visited = new Set([key(start.x, start.y)]);
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  while (queue.length) {
    const current = queue.shift();
    if (current.x === end.x && current.y === end.y) return true;
    for (const [dx, dy] of directions) {
      const x = current.x + dx;
      const y = current.y + dy;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (grid[y]?.[x] === NAVIGATION_TILES.blocked) continue;
      if (dx && dy) {
        if (grid[current.y]?.[x] === NAVIGATION_TILES.blocked || grid[y]?.[current.x] === NAVIGATION_TILES.blocked) continue;
      }
      const cellKey = key(x, y);
      if (visited.has(cellKey)) continue;
      visited.add(cellKey);
      queue.push({ x, y });
    }
  }
  return false;
}

function lanzhouWithCapabilities() {
  const source = createLanzhouMapPackage();
  return {
    ...source,
    features: applyLanzhouCapabilities(source.features, source.navigation),
  };
}

test('Token elevationFt defaults to zero and normalizes as a non-negative value', () => {
  const token = createTokenForActor('actor-a', 'character-a');
  assert.equal(token.elevationFt, 0);
  assert.equal(tokenElevationFt(token), 0);
  assert.equal(normalizeElevationFt(35), 35);
  assert.equal(normalizeElevationFt(-10), 0);

  const normalized = normalizeEntityState({
    actors: [{ id: 'actor-a', forms: [], runtime: {} }],
    tokens: [{ id: 'character-a', actorId: 'actor-a', characterId: 'character-a', elevationFt: 45 }],
  });
  assert.equal(normalized.tokens[0].elevationFt, 45);
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

test('Navigation grid ignores a height-aware Feature only when mover elevation is greater', () => {
  const map = simpleMap();
  const appState = { sceneEvents: [], preferences: { featureStates: {} } };
  const atHeight = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { characterId: 'character-a', elevationFt: 20 },
  });
  const aboveHeight = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { characterId: 'character-a', elevationFt: 21 },
  });
  assert.equal(atHeight.grid[2][2], NAVIGATION_TILES.blocked);
  assert.equal(aboveHeight.grid[2][2], NAVIGATION_TILES.open);
});

test('Navigation uses blockingPolygon instead of visible Feature geometry when declared', () => {
  const feature = simpleFeature(20);
  feature.geometry.points = [[40, 40], [60, 40], [60, 60], [40, 60]];
  feature.capabilities.navigation.blockingPolygon = [[10, 40], [90, 40], [90, 60], [10, 60]];
  const navigation = createNavigationGrid(simpleMap(feature), {}, null, {
    appState: { sceneEvents: [], preferences: { featureStates: {} } },
    moverContext: { elevationFt: 0 },
  });
  assert.equal(navigation.grid[4][2], NAVIGATION_TILES.blocked, 'declared blocker must extend beyond visible geometry');
});

test('Feature State blockingHeightFt override participates in mover-aware Navigation', () => {
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
    moverContext: { elevationFt: 30 },
  });
  const aboveOverride = createNavigationGrid(map, {}, null, {
    appState,
    moverContext: { elevationFt: 41 },
  });
  assert.equal(belowOverride.grid[2][2], NAVIGATION_TILES.blocked);
  assert.equal(aboveOverride.grid[2][2], NAVIGATION_TILES.open);
});

test('legacy callers may cache the Navigation facade while active mover and Feature height change', () => {
  const map = simpleMap();
  const appState = { sceneEvents: [], preferences: { featureStates: {} } };
  configureElevationNavigationRuntime({ getState: () => appState });
  try {
    setActiveMoverContext({ characterId: 'ground', elevationFt: 0 });
    const cachedNavigation = createNavigationGrid(map, {});
    assert.equal(cachedNavigation.grid[2][2], NAVIGATION_TILES.blocked);

    setActiveMoverContext({ characterId: 'flyer', elevationFt: 30 });
    assert.equal(cachedNavigation.grid[2][2], NAVIGATION_TILES.open, 'cached facade must refresh for another mover');

    appState.preferences.featureStates['obstacle-a'] = { custom: { blockingHeightFt: 40 } };
    assert.equal(cachedNavigation.grid[2][2], NAVIGATION_TILES.blocked, 'cached facade must refresh for Feature State override');
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

test('Lanzhou city gates seal their wall openings when closed and restore the passage when opened', () => {
  const map = lanzhouWithCapabilities();
  const cityGateIds = ['gate-north', 'gate-east', 'gate-south', 'gate-west'];
  const gateways = new Map((map.navigation.gateways || []).map((gateway) => [String(gateway.featureId), gateway]));

  for (const featureId of cityGateIds) {
    const gateway = gateways.get(featureId);
    assert.ok(gateway, `missing navigation gateway for ${featureId}`);
    const crossing = gatewayCrossing(gateway);
    const closedState = { sceneEvents: [], preferences: { featureStates: { [featureId]: { open: false } } } };
    const openState = { sceneEvents: [], preferences: { featureStates: { [featureId]: { open: true } } } };
    const closedNavigation = createNavigationGrid(map, {}, null, {
      appState: closedState,
      moverContext: { characterId: 'ground-token', elevationFt: 0 },
    });
    const openNavigation = createNavigationGrid(map, {}, null, {
      appState: openState,
      moverContext: { characterId: 'ground-token', elevationFt: 0 },
    });

    assert.equal(
      hasLocalGridPath(closedNavigation, crossing.start, crossing.end, crossing.center),
      false,
      `${featureId} closed must not allow side-slip through the wall opening`,
    );
    assert.equal(
      hasLocalGridPath(openNavigation, crossing.start, crossing.end, crossing.center),
      true,
      `${featureId} open must restore a local passage through the wall`,
    );
  }
});
