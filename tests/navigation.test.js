import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAVIGATION_TILES,
  createNavigationBase,
  createNavigationGrid,
  findNavigationPath,
  nearestWalkablePoint,
} from '../src/engine/navigation.js';
import { createInitialState, deriveSceneState } from '../src/engine/state.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { getFeatureInteractionState, setFeatureOpenState } from '../src/interaction/model.js';
import { recordFeatureInteractionEffects } from '../src/interaction/effects.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

test('A* prefers road tiles, avoids blocked cells and snaps within 30 metres', async () => {
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
  const route = await findNavigationPath(navigation, { x: 5, y: 25 }, { x: 65, y: 25 });
  assert.ok(route);
  assert.ok(route.points.some((point) => point.y === 15), 'the lower-cost road row should be used');
  assert.deepEqual(nearestWalkablePoint(navigation, { x: 25, y: 25 }, 30).cell, { x: 2, y: 1 });

  const sealed = structuredClone(navigation);
  sealed.grid.forEach((row) => { row[3] = NAVIGATION_TILES.blocked; });
  assert.equal(await findNavigationPath(sealed, { x: 5, y: 45 }, { x: 65, y: 45 }), null);
});

test('generic openable Feature changes collision and route without gate/building category rules', async () => {
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
  assert.equal(closed.grid[2][4], NAVIGATION_TILES.blocked);
  assert.equal(await findNavigationPath(closed, { x: 5, y: 25 }, { x: 95, y: 25 }), null);

  recordFeatureInteractionEffects(door, { open: true });
  const opened = createNavigationGrid(mapPackage, deriveSceneState([]), base);
  assert.equal(opened.grid[2][4], NAVIGATION_TILES.open);
  assert.ok(await findNavigationPath(opened, { x: 5, y: 25 }, { x: 95, y: 25 }));
});

test('Minimal Reference door open/close state is projected into navigation', () => {
  const mapPackage = prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal' });
  const door = mapPackage.features.find((feature) => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);
  const base = createNavigationBase(mapPackage);
  const doorCell = { x: Math.floor(500 / 10), y: Math.floor(465 / 10) };

  getFeatureInteractionState(state, door);
  const closed = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(closed.grid[doorCell.y][doorCell.x], NAVIGATION_TILES.blocked);

  state = setFeatureOpenState(state, door.id, true);
  getFeatureInteractionState(state, door);
  const opened = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(opened.grid[doorCell.y][doorCell.x], NAVIGATION_TILES.open);

  state = setFeatureOpenState(state, door.id, false);
  getFeatureInteractionState(state, door);
  const reclosed = createNavigationGrid(mapPackage, deriveSceneState(state.sceneEvents), base);
  assert.equal(reclosed.grid[doorCell.y][doorCell.x], NAVIGATION_TILES.blocked);
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
  const bridgeCell = { x: Math.floor(3508 / 10), y: Math.floor(1086 / 10) };
  assert.equal(staticBase.grid[bridgeCell.y][bridgeCell.x], NAVIGATION_TILES.blocked);
  assert.equal(intact.grid[bridgeCell.y][bridgeCell.x], NAVIGATION_TILES.road);

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
  assert.equal(damaged.grid[bridgeCell.y][bridgeCell.x], NAVIGATION_TILES.blocked);
  assert.equal(staticBase.grid[bridgeCell.y][bridgeCell.x], NAVIGATION_TILES.blocked);

  const northGateCell = { x: Math.floor(3364 / 10), y: Math.floor(1546 / 10) };
  assert.equal(intact.grid[northGateCell.y][northGateCell.x], NAVIGATION_TILES.blocked);

  const openedState = setFeatureOpenState(initialState, northGate.id, true);
  getFeatureInteractionState(openedState, northGate);
  const gateOpened = createNavigationGrid(lanzhouMapPackage, deriveSceneState([]), staticBase);
  assert.equal(gateOpened.grid[northGateCell.y][northGateCell.x], NAVIGATION_TILES.road);

  const wallCell = { x: Math.floor(2500 / 10), y: Math.floor(1570 / 10) };
  assert.equal(gateOpened.grid[wallCell.y][wallCell.x], NAVIGATION_TILES.blocked);
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
  assert.notEqual(breached.grid[wallCell.y][wallCell.x], NAVIGATION_TILES.blocked);
});
