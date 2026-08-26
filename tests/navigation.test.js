import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import {
  NAVIGATION_TILES,
  createNavigationBase,
  createNavigationGrid,
  findDirectNavigationPath,
  inspectDirectNavigationPath,
  isNavigationSegmentWalkable,
  nearestWalkablePoint,
} from '../src/engine/navigation.js';
import { createInitialState, deriveSceneState } from '../src/engine/state.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { getFeatureInteractionState, setFeatureOpenState } from '../src/interaction/model.js';
import { recordFeatureInteractionEffects } from '../src/interaction/effects.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

test('straight movement stays exact even when a nearby road would previously pull A* away', () => {
  const navigation = {
    cellSize: 10, width: 70, height: 50, columns: 7, rows: 5,
    grid: [
      [2, 2, 2, 2, 2, 2, 2],
      [1, 1, 1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2, 2, 2],
    ],
  };
  const start = { x: 5, y: 25 };
  const destination = { x: 65, y: 25 };
  const route = findDirectNavigationPath(navigation, start, destination);
  assert.deepEqual(route.points, [start, destination]);
  assert.equal(route.distance, 60);
  assert.equal(route.routeType, 'direct');
});

test('blocked straight movement stays invalid and never snaps to another endpoint', () => {
  const navigation = {
    cellSize: 10, width: 70, height: 50, columns: 7, rows: 5,
    grid: [
      [2, 2, 2, 2, 2, 2, 2],
      [1, 1, 1, 1, 1, 1, 1],
      [2, 2, 0, 0, 0, 2, 2],
      [2, 2, 2, 2, 2, 2, 2],
      [2, 2, 2, 2, 2, 2, 2],
    ],
  };
  const route = findDirectNavigationPath(navigation, { x: 5, y: 25 }, { x: 65, y: 25 });
  assert.equal(route, null, 'a blocked line must not route around the barrier');
  assert.deepEqual(nearestWalkablePoint(navigation, { x: 25, y: 25 }, 30).cell, { x: 2, y: 1 });

  const sealed = structuredClone(navigation);
  sealed.grid.forEach((row) => { row[3] = NAVIGATION_TILES.blocked; });
  assert.equal(findDirectNavigationPath(sealed, { x: 5, y: 45 }, { x: 65, y: 45 }), null);

  const blockedTarget = {
    cellSize: 10, width: 50, height: 10, columns: 5, rows: 1,
    grid: [[2, 2, 0, 2, 2]],
  };
  assert.equal(
    findDirectNavigationPath(blockedTarget, { x: 5, y: 5 }, { x: 25, y: 5 }),
    null,
    'a blocked target must remain blocked instead of moving to a nearby cell',
  );
});

test('strict straight-line checks include blocked cells touched at a corner', () => {
  const navigation = {
    cellSize: 10, width: 20, height: 20, columns: 2, rows: 2,
    grid: [[2, 0], [2, 2]],
  };
  assert.equal(isNavigationSegmentWalkable(navigation, { x: 2, y: 2 }, { x: 18, y: 18 }), false);
  assert.equal(findDirectNavigationPath(navigation, { x: 2, y: 2 }, { x: 18, y: 18 }), null);
});

function inspectInWorker(start, destination, { timeout = 400, map = null } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./navigation-probe-worker.mjs', import.meta.url), { workerData: { start, destination, map } });
    const timer = setTimeout(async () => {
      await worker.terminate();
      reject(new Error('navigation probe exceeded its hard timeout'));
    }, timeout);
    worker.once('message', result => { clearTimeout(timer); worker.terminate(); resolve(result); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

test('former floating-DDA hang inputs terminate inside a worker hard limit', { timeout: 1500 }, async () => {
  const probes = await Promise.all([
    inspectInWorker({ x: 3364.123456, y: 1332.123456 }, { x: 5910, y: 800 }),
    inspectInWorker({ x: 0, y: 0 }, { x: 40, y: 5000 }),
    inspectInWorker({ x: 0, y: 0 }, { x: 5999.99999999, y: 10 }),
  ]);
  for (const result of probes) {
    assert.ok(result.visitedCellCount <= 11001, 'integer trace must stay bounded by map Manhattan span');
    assert.notEqual(result.reason, 'iteration-limit');
  }
});

test('a long drag that reaches a blocking Feature returns from the Worker without freezing', { timeout: 1500 }, async () => {
  const map = {
    width: 6000,
    height: 5000,
    navigation: { bridgeFeatureIds: [] },
    roadBuffers: [], liquidBodies: [], floodRules: {},
    features: [{
      id: 'wall',
      geometry: { points: [[3000, 0], [3010, 0], [3010, 5000], [3000, 5000]] },
      capabilities: { navigation: { blocks: true } },
    }],
  };
  const result = await inspectInWorker({ x: 100.5, y: 2500.5 }, { x: 5900.5, y: 2500.5 }, { map });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'blocked');
  assert.ok(result.visitedCellCount <= 5901);
  assert.deepEqual(result.blockingCell, { x: 3000, y: 2500 });
});

test('direct inspection returns the first blocking tag cell and honours Token diameter', () => {
  const grid = Array.from({ length: 24 }, () => Array(24).fill(NAVIGATION_TILES.open));
  grid[12][12] = NAVIGATION_TILES.blocked;
  const navigation = { cellSize: 1, width: 24, height: 24, columns: 24, rows: 24, grid };
  const direct = inspectDirectNavigationPath(navigation, { x: 2.5, y: 12.5 }, { x: 20.5, y: 12.5 });
  assert.equal(direct.valid, false);
  assert.deepEqual(direct.blockingCell, { x: 12, y: 12 });
  assert.ok(direct.visitedCellCount < 24);

  const narrow = inspectDirectNavigationPath(navigation, { x: 2.5, y: 8.5 }, { x: 20.5, y: 8.5 }, { diameterMeters: 1 });
  const wide = inspectDirectNavigationPath(navigation, { x: 2.5, y: 8.5 }, { x: 20.5, y: 8.5 }, { diameterMeters: 10 });
  assert.equal(narrow.valid, true);
  assert.equal(wide.valid, false, 'wide Token must be stopped even when its centre line clears the blocker');
});

test('generic openable Feature changes collision and direct movement without gate/building category rules', () => {
  const barrier = {
    id: 'generic-barrier',
    category: 'mechanism',
    geometry: { points: [[40, 0], [60, 0], [60, 50], [40, 50]] },
    capabilities: { navigation: { blocks: true } },
  };
  const door = {
    id: 'generic-door',
    category: 'door',
    geometry: { points: [[40, 20], [60, 20], [60, 30], [40, 30]] },
    interaction: { initialOpen: false },
    capabilities: {
      openable: true,
      navigation: { blocks: true, passableWhenOpen: true, passageTile: 'open' },
    },
  };
  const mapPackage = {
    width: 100,
    height: 50,
    navigation: { cellSizeMeters: 10, bridgeFeatureIds: [] },
    roadBuffers: [],
    liquidBodies: [],
    floodRules: {},
    features: [barrier, door],
  };
  const base = createNavigationBase(mapPackage);

  recordFeatureInteractionEffects(door, { open: false });
  const closed = createNavigationGrid(mapPackage, deriveSceneState([]), base);
  assert.equal(closed.tileAt({ x: 45, y: 25 }), NAVIGATION_TILES.blocked);
  assert.equal(findDirectNavigationPath(closed, { x: 5, y: 25 }, { x: 95, y: 25 }), null);

  recordFeatureInteractionEffects(door, { open: true });
  const opened = createNavigationGrid(mapPackage, deriveSceneState([]), base);
  assert.equal(opened.tileAt({ x: 45, y: 25 }), NAVIGATION_TILES.open);
  assert.ok(findDirectNavigationPath(opened, { x: 5, y: 25 }, { x: 95, y: 25 }));
});

test('structure bypass ignores only structure Features and still respects water', () => {
  const structure = {
    id: 'structure-wall',
    geometry: { points: [[30, 0], [40, 0], [40, 50], [30, 50]] },
    capabilities: { navigation: { blocks: true, collisionGroup: 'structure' } },
  };
  const mapPackage = {
    width: 100,
    height: 50,
    navigation: { bridgeFeatureIds: [] },
    roadBuffers: [],
    liquidBodies: [{ polygon: [[70, 0], [80, 0], [80, 50], [70, 50]] }],
    floodRules: {},
    features: [structure],
  };
  const base = createNavigationBase(mapPackage);
  const appState = { preferences: { featureStates: {} }, characters: [], sceneEvents: [] };
  const ordinary = createNavigationGrid(mapPackage, deriveSceneState([]), base, {
    appState,
    moverContext: { diameterMeters: 1, collisionBypassGroups: [] },
  });
  assert.equal(findDirectNavigationPath(ordinary, { x: 5.5, y: 25.5 }, { x: 60.5, y: 25.5 }), null);

  const spirit = createNavigationGrid(mapPackage, deriveSceneState([]), base, {
    appState,
    moverContext: { diameterMeters: 1, collisionBypassGroups: ['structure'], statusVersion: 'spirit-on' },
  });
  assert.ok(findDirectNavigationPath(spirit, { x: 5.5, y: 25.5 }, { x: 60.5, y: 25.5 }));
  assert.equal(
    findDirectNavigationPath(spirit, { x: 5.5, y: 25.5 }, { x: 95.5, y: 25.5 }),
    null,
    'structure bypass must not bypass the water field',
  );
});

test('Minimal Reference door open/close state is projected into navigation', () => {
  const mapPackage = prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal' });
  const door = mapPackage.features.find((feature) => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);
  const base = createNavigationBase(mapPackage);
  const doorCell = { x: 500, y: 465 };

  getFeatureInteractionState(state, door);
  const closed = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(closed.tileAt(doorCell), NAVIGATION_TILES.blocked);

  state = setFeatureOpenState(state, door.id, true);
  getFeatureInteractionState(state, door);
  const opened = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(opened.tileAt(doorCell), NAVIGATION_TILES.open);

  state = setFeatureOpenState(state, door.id, false);
  getFeatureInteractionState(state, door);
  const reclosed = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(reclosed.tileAt(doorCell), NAVIGATION_TILES.blocked);
});

test('Lanzhou navigation closes gates by default, opens them by Interaction state and preserves wall breaches', () => {
  const source = createLanzhouMapPackage();
  const lanzhouMapPackage = prepareMapPackage({
    ...source,
    features: applyLanzhouCapabilities(source.features, source.navigation),
  }, { source: 'test:lanzhou-no-art' });
  const staticBase = createNavigationBase(lanzhouMapPackage);
  const initialState = createInitialState(lanzhouMapPackage);
  const northGate = lanzhouMapPackage.features.find((feature) => feature.id === 'gate-north');
  getFeatureInteractionState(initialState, northGate);

  const intact = createNavigationGrid(lanzhouMapPackage, deriveSceneState([]), staticBase);
  const bridgeCell = { x: 3508, y: 1086 };
  assert.equal(staticBase.tileAt(bridgeCell), NAVIGATION_TILES.blocked);
  assert.equal(intact.tileAt(bridgeCell), NAVIGATION_TILES.road);

  const damagedScene = deriveSceneState([{
    id: 'scene-bridge', type: 'damage',
    areaSnapshot: {
      id: 'area', type: 'circle', center: { x: 3508, y: 1086 }, radius: 50,
      destructionTargets: ['bridge'],
    },
    objectIds: [],
    clipHits: [{
      featureId: 'yellow-river-pontoon-bridge',
      polygon: [[3450, 1030], [3570, 1030], [3570, 1140], [3450, 1140]],
    }],
  }]);
  const damaged = createNavigationGrid(lanzhouMapPackage, damagedScene, staticBase);
  assert.equal(damaged.tileAt(bridgeCell), NAVIGATION_TILES.blocked);
  assert.equal(staticBase.tileAt(bridgeCell), NAVIGATION_TILES.blocked);

  const northGateCell = { x: 3364, y: 1546 };
  assert.equal(intact.tileAt(northGateCell), NAVIGATION_TILES.blocked);

  const openedState = setFeatureOpenState(initialState, northGate.id, true);
  getFeatureInteractionState(openedState, northGate);
  const gateOpened = createNavigationGrid(lanzhouMapPackage, deriveSceneState([]), staticBase);
  assert.equal(gateOpened.tileAt(northGateCell), NAVIGATION_TILES.road);

  const wallCell = { x: 2500, y: 1570 };
  assert.equal(gateOpened.tileAt(wallCell), NAVIGATION_TILES.blocked);
  const breachedScene = deriveSceneState([{
    id: 'scene-wall', type: 'damage',
    areaSnapshot: {
      id: 'wall-area', type: 'rectangle', center: { x: 2460, y: 1520 },
      length: 100, width: 100, headingDeg: 90, destructionTargets: ['wall'],
    },
    objectIds: [],
    clipHits: [{
      featureId: 'city-wall-northwest',
      polygon: [[2460, 1520], [2540, 1520], [2540, 1620], [2460, 1620]],
    }],
  }]);
  const breached = createNavigationGrid(lanzhouMapPackage, breachedScene, staticBase);
  assert.notEqual(breached.tileAt(wallCell), NAVIGATION_TILES.blocked);
});
