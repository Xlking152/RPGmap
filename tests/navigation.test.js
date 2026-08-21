import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NAVIGATION_TILES,
  createNavigationBase,
  createNavigationGrid,
  findNavigationPath,
  nearestWalkablePoint,
} from '../src/engine/navigation.js';
import { deriveSceneState } from '../src/engine/state.js';
import { lanzhouMapPackage } from '../src/maps/lanzhou.js';

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

test('Lanzhou navigation exposes gates and blocks damaged pontoon cells', () => {
  const staticBase = createNavigationBase(lanzhouMapPackage);
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
  assert.equal(intact.grid[northGateCell.y][northGateCell.x], NAVIGATION_TILES.road);

  const wallCell = { x: Math.floor(2500 / 10), y: Math.floor(1570 / 10) };
  assert.equal(intact.grid[wallCell.y][wallCell.x], NAVIGATION_TILES.blocked);
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
