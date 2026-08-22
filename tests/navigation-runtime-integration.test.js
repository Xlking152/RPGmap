import test from 'node:test';
import assert from 'node:assert/strict';

import { createNavigationGrid, findNavigationPath } from '../src/engine/navigation.js';
import { calculateWaypointRoute } from '../src/movement/path.js';
import { MovementSession } from '../src/movement/session.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';

const CITY_GATE_IDS = Object.freeze(['gate-north', 'gate-east', 'gate-south', 'gate-west']);

function genericBarrierMap() {
  return {
    width: 100,
    height: 100,
    navigation: { cellSizeMeters: 10, bridgeFeatureIds: [] },
    roadBuffers: [],
    liquidBodies: [],
    floodRules: {},
    features: [{
      id: 'generic-height-barrier',
      category: 'mechanism',
      geometry: { type: 'polygon', points: [[35, 40], [65, 40], [65, 60], [35, 60]] },
      interaction: { initialOpen: false },
      capabilities: {
        openable: true,
        navigation: {
          blocks: true,
          blockingHeightFt: 20,
          passableWhenOpen: true,
          blockingPolygon: [[0, 40], [100, 40], [100, 60], [0, 60]],
          passagePolygon: [[0, 40], [100, 40], [100, 60], [0, 60]],
          passageTile: 'open',
        },
      },
    }],
  };
}

function appState(open = false) {
  return {
    sceneEvents: [],
    preferences: {
      featureStates: {
        'generic-height-barrier': { open },
      },
    },
  };
}

function cityGateState(openGateId = null) {
  return {
    sceneEvents: [],
    preferences: {
      featureStates: Object.fromEntries(CITY_GATE_IDS.map((featureId) => [
        featureId,
        { open: featureId === openGateId },
      ])),
    },
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
  return {
    center: { x: cx, y: cy },
    start: { x: cx - (dx / length) * distance, y: cy - (dy / length) * distance },
    end: { x: cx + (dx / length) * distance, y: cy + (dy / length) * distance },
  };
}

function cropNavigation(navigation, center, radiusMeters = 240) {
  const cellSize = navigation.cellSize;
  const minColumn = Math.max(0, Math.floor((center.x - radiusMeters) / cellSize));
  const maxColumn = Math.min(navigation.columns - 1, Math.floor((center.x + radiusMeters) / cellSize));
  const minRow = Math.max(0, Math.floor((center.y - radiusMeters) / cellSize));
  const maxRow = Math.min(navigation.rows - 1, Math.floor((center.y + radiusMeters) / cellSize));
  const columns = maxColumn - minColumn + 1;
  const rows = maxRow - minRow + 1;
  const grid = navigation.grid
    .slice(minRow, maxRow + 1)
    .map((row) => row.slice(minColumn, maxColumn + 1));
  const origin = { x: minColumn * cellSize, y: minRow * cellSize };
  return {
    navigation: {
      cellSize,
      width: columns * cellSize,
      height: rows * cellSize,
      columns,
      rows,
      grid,
    },
    point(point) {
      return { x: point.x - origin.x, y: point.y - origin.y };
    },
  };
}

function lanzhouWithCapabilities() {
  const source = createLanzhouMapPackage();
  return {
    ...source,
    features: applyLanzhouCapabilities(source.features, source.navigation),
  };
}

test('Movement path planning is actually blocked by a closed generic Feature and restored by open/elevation state', async () => {
  const map = genericBarrierMap();
  const start = { x: 50, y: 20 };
  const destination = { x: 50, y: 80 };

  const closedGround = createNavigationGrid(map, {}, null, {
    appState: appState(false),
    moverContext: { characterId: 'ground', elevationFt: 0 },
  });
  assert.equal(await findNavigationPath(closedGround, start, destination), null, 'closed barrier must stop A*');

  const session = new MovementSession({ characterId: 'ground', start });
  const blockedWaypointRoute = await calculateWaypointRoute({
    session,
    destination,
    findPath: (from, to) => findNavigationPath(closedGround, from, to),
  });
  assert.equal(blockedWaypointRoute.valid, false, 'movement planner must surface the blocked A* segment');
  assert.equal(blockedWaypointRoute.failedSegmentIndex, 0);

  const openedGround = createNavigationGrid(map, {}, null, {
    appState: appState(true),
    moverContext: { characterId: 'ground', elevationFt: 0 },
  });
  assert.ok(await findNavigationPath(openedGround, start, destination), 'opening the same Feature must restore A* passage');

  const closedAbove = createNavigationGrid(map, {}, null, {
    appState: appState(false),
    moverContext: { characterId: 'flyer', elevationFt: 21 },
  });
  assert.ok(await findNavigationPath(closedAbove, start, destination), 'strictly higher mover must clear a 20 ft blocker');
});

test('real Lanzhou city-gate grids block EasyStar routes when closed and restore them when opened', async () => {
  const map = lanzhouWithCapabilities();
  const gateways = new Map((map.navigation.gateways || []).map((gateway) => [String(gateway.featureId), gateway]));

  for (const featureId of CITY_GATE_IDS) {
    const gateway = gateways.get(featureId);
    const crossing = gatewayCrossing(gateway);
    const closedState = cityGateState();
    const openState = cityGateState(featureId);

    const closedFull = createNavigationGrid(map, {}, null, {
      appState: closedState,
      moverContext: { characterId: 'ground', elevationFt: 0 },
    });
    const openedFull = createNavigationGrid(map, {}, null, {
      appState: openState,
      moverContext: { characterId: 'ground', elevationFt: 0 },
    });
    const closed = cropNavigation(closedFull, crossing.center);
    const opened = cropNavigation(openedFull, crossing.center);

    assert.equal(
      await findNavigationPath(closed.navigation, closed.point(crossing.start), closed.point(crossing.end)),
      null,
      `${featureId}: closed gate must block the real EasyStar path`,
    );
    assert.ok(
      await findNavigationPath(opened.navigation, opened.point(crossing.start), opened.point(crossing.end)),
      `${featureId}: opened gate must restore the real EasyStar path`,
    );
  }
});

test('Lanzhou city perimeter is globally sealed with all city gates closed and becomes enterable through an opened north gate', async () => {
  const map = lanzhouWithCapabilities();
  const outsideNorth = { x: 3364, y: 1332 };
  const cityCenter = { x: 3268, y: 2195 };

  const sealed = createNavigationGrid(map, {}, null, {
    appState: cityGateState(),
    moverContext: { characterId: 'ground', elevationFt: 0 },
  });
  assert.equal(
    await findNavigationPath(sealed, outsideNorth, cityCenter),
    null,
    'all four closed city gates must seal the city perimeter for a ground mover',
  );

  const northOpen = createNavigationGrid(map, {}, null, {
    appState: cityGateState('gate-north'),
    moverContext: { characterId: 'ground', elevationFt: 0 },
  });
  assert.ok(
    await findNavigationPath(northOpen, outsideNorth, cityCenter),
    'opening the north gate must create an actual outside-to-city-center route',
  );
});
