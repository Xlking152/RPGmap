import test from 'node:test';
import assert from 'node:assert/strict';

import { createNavigationGrid, findDirectNavigationPath } from '../src/engine/navigation.js';
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

function lanzhouWithCapabilities() {
  const source = createLanzhouMapPackage();
  return {
    ...source,
    features: applyLanzhouCapabilities(source.features, source.navigation),
  };
}

test('direct movement is blocked by a closed generic Feature and restored by open/elevation state', async () => {
  const map = genericBarrierMap();
  const start = { x: 50, y: 20 };
  const destination = { x: 50, y: 80 };

  const closedGround = createNavigationGrid(map, {}, null, {
    appState: appState(false),
    moverContext: { tokenId: 'ground', elevationFt: 0 },
  });
  assert.equal(findDirectNavigationPath(closedGround, start, destination), null, 'closed barrier must stop direct movement');

  const atBarrierHeight = createNavigationGrid(map, {}, null, {
    appState: appState(false),
    moverContext: { tokenId: 'at-height', elevationFt: 20 },
  });
  assert.equal(findDirectNavigationPath(atBarrierHeight, start, destination), null,
    'a Token at exactly the blocking height must still be stopped');

  const session = new MovementSession({ tokenId: 'ground', start });
  const blockedWaypointRoute = await calculateWaypointRoute({
    session,
    destination,
    findPath: (from, to) => findDirectNavigationPath(closedGround, from, to),
  });
  assert.equal(blockedWaypointRoute.valid, false, 'movement planner must surface the blocked direct segment');
  assert.equal(blockedWaypointRoute.failedSegmentIndex, 0);

  const openedGround = createNavigationGrid(map, {}, null, {
    appState: appState(true),
    moverContext: { tokenId: 'ground', elevationFt: 0 },
  });
  assert.ok(findDirectNavigationPath(openedGround, start, destination), 'opening the same Feature must restore direct passage');

  const closedAbove = createNavigationGrid(map, {}, null, {
    appState: appState(false),
    moverContext: { tokenId: 'flyer', elevationFt: 21 },
  });
  const aboveRoute = findDirectNavigationPath(closedAbove, start, destination);
  assert.deepEqual(aboveRoute.points, [start, destination], 'strictly higher mover must use the restored direct route');
  assert.equal(aboveRoute.routeType, 'direct');
});

test('real Lanzhou city gates block direct lines when closed and restore them when opened', async () => {
  const map = lanzhouWithCapabilities();
  const gateways = new Map((map.navigation.gateways || []).map((gateway) => [String(gateway.featureId), gateway]));

  for (const featureId of CITY_GATE_IDS) {
    const gateway = gateways.get(featureId);
    const crossing = gatewayCrossing(gateway);
    const closedState = cityGateState();
    const openState = cityGateState(featureId);

    const closedFull = createNavigationGrid(map, {}, null, {
      appState: closedState,
      moverContext: { tokenId: 'ground', elevationFt: 0 },
    });
    const openedFull = createNavigationGrid(map, {}, null, {
      appState: openState,
      moverContext: { tokenId: 'ground', elevationFt: 0 },
    });
    assert.equal(
      findDirectNavigationPath(closedFull, crossing.start, crossing.end),
      null,
      `${featureId}: closed gate must block the direct path`,
    );
    assert.ok(
      findDirectNavigationPath(openedFull, crossing.start, crossing.end),
      `${featureId}: opened gate must restore the direct path`,
    );
  }
});

test('opening a gate restores only the exact two-point direct crossing through the city perimeter', async () => {
  const map = lanzhouWithCapabilities();
  const outsideNorth = { x: 3364, y: 1332 };
  const cityCenter = { x: 3268, y: 2195 };

  const sealed = createNavigationGrid(map, {}, null, {
    appState: cityGateState(),
    moverContext: { tokenId: 'ground', elevationFt: 0 },
  });
  assert.equal(
    findDirectNavigationPath(sealed, outsideNorth, cityCenter),
    null,
    'all four closed city gates must seal the city perimeter for a ground mover',
  );

  const northOpen = createNavigationGrid(map, {}, null, {
    appState: cityGateState('gate-north'),
    moverContext: { tokenId: 'ground', elevationFt: 0 },
  });
  const direct = findDirectNavigationPath(northOpen, outsideNorth, cityCenter);
  assert.deepEqual(
    direct?.points,
    [outsideNorth, cityCenter],
    'the opened north gate permits this exact straight crossing without adding automatic detour points',
  );
});
