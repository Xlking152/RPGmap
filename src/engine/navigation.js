import EasyStar from 'easystarjs';
import { deriveFloodRegions } from './state.js';
import { runtimeFeatureInteractionEffects } from '../interaction/effects.js';
import { getFeatureState } from '../interaction/feature-state.js';
import { featureBlocksMover } from '../elevation/model.js';
import {
  elevationNavigationAppState,
  getActiveMoverContext,
} from '../elevation/runtime-context.js';

const TILE_BLOCKED = 0;
const TILE_ROAD = 1;
const TILE_OPEN = 2;

function pointTuple(point) {
  return Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point.x), Number(point.y)];
}

function pointInPolygon(point, polygon) {
  const [x, y] = pointTuple(point);
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
    const [cx, cy] = pointTuple(polygon[current]);
    const [px, py] = pointTuple(polygon[previous]);
    const crosses = cy > y !== py > y;
    if (crosses && x < ((px - cx) * (y - cy)) / (py - cy) + cx) inside = !inside;
  }
  return inside;
}

function polygonBounds(polygon) {
  const points = polygon.map(pointTuple);
  return points.reduce((bounds, [x, y]) => ({
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function featurePolygon(feature) {
  return feature?.geometry?.points || feature?.polygon || [];
}

function rasterizePolygon(grid, polygon, cellSize, tile, predicate = null) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  const bounds = polygonBounds(polygon);
  const rows = grid.length;
  const columns = grid[0]?.length || 0;
  const minColumn = Math.max(0, Math.floor(bounds.minX / cellSize));
  const maxColumn = Math.min(columns - 1, Math.floor(bounds.maxX / cellSize));
  const minRow = Math.max(0, Math.floor(bounds.minY / cellSize));
  const maxRow = Math.min(rows - 1, Math.floor(bounds.maxY / cellSize));
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const point = [(column + 0.5) * cellSize, (row + 0.5) * cellSize];
      if (pointInPolygon(point, polygon) && (!predicate || predicate(point))) {
        grid[row][column] = typeof tile === 'function' ? tile(point, column, row) : tile;
      }
    }
  }
}

function clipDamageForFeature(scene, featureId) {
  return (scene?.clipHits || [])
    .filter((hit) => String(hit.featureId) === String(featureId))
    .map((hit) => hit.polygon);
}

function navigationCapability(feature) {
  const declared = feature?.capabilities?.navigation || feature?.navigation;
  if (!declared || typeof declared !== 'object') return null;
  let passageTile = null;
  if (declared.passageTile === 'road') passageTile = TILE_ROAD;
  if (declared.passageTile === 'open') passageTile = TILE_OPEN;
  const height = Number(declared.blockingHeightFt);
  return Object.freeze({
    blocks: declared.blocks === true,
    passableWhenOpen: declared.passableWhenOpen === true,
    passableWhenDestroyed: declared.passableWhenDestroyed === true,
    damageCreatesPassage: declared.damageCreatesPassage === true,
    blockingHeightFt: Number.isFinite(height) && height >= 0 ? height : null,
    passageTile,
    passagePolygon: Array.isArray(declared.passagePolygon) ? declared.passagePolygon : null,
  });
}

function featureRuntimeState(feature, appState) {
  if (appState) {
    try {
      return getFeatureState(appState, feature);
    } catch (_error) {
      // Fall through to the lightweight runtime effects adapter for legacy callers.
    }
  }
  return runtimeFeatureInteractionEffects(feature);
}

function restorePassage(grid, baseGrid, polygon, cellSize, passageTile) {
  rasterizePolygon(
    grid,
    polygon,
    cellSize,
    (_point, column, row) => passageTile ?? baseGrid[row][column],
  );
}

export function createNavigationBase(mapPackage) {
  const cellSize = Number(mapPackage.navigation?.cellSizeMeters ?? 10);
  const columns = Math.ceil(mapPackage.width / cellSize);
  const rows = Math.ceil(mapPackage.height / cellSize);
  const grid = Array.from({ length: rows }, () => Array(columns).fill(TILE_OPEN));

  for (const buffer of mapPackage.roadBuffers || []) {
    rasterizePolygon(grid, featurePolygon(buffer), cellSize, TILE_ROAD);
  }
  for (const body of mapPackage.liquidBodies || []) {
    rasterizePolygon(grid, body.polygon, cellSize, TILE_BLOCKED);
  }

  return Object.freeze({
    cellSize,
    width: mapPackage.width,
    height: mapPackage.height,
    columns,
    rows,
    grid,
  });
}

/**
 * Build a mover-aware navigation grid.
 *
 * Existing callers may keep using the first three arguments. The Elevation
 * Runtime Adapter supplies app state + mover context for the current Token.
 * Tests/new callers may pass them explicitly in options.
 */
export function createNavigationGrid(mapPackage, scene = {}, staticBase = null, options = {}) {
  const base = staticBase || createNavigationBase(mapPackage);
  const { cellSize, columns, rows } = base;
  if (base.width !== mapPackage.width || base.height !== mapPackage.height) {
    throw new Error('navigation base does not match map dimensions');
  }
  const grid = base.grid.map((row) => row.slice());
  const destroyed = new Set((scene.destroyedObjectIds || []).map(String));
  const appState = options.appState ?? elevationNavigationAppState();
  const moverContext = options.moverContext ?? getActiveMoverContext();

  for (const feature of mapPackage.features || []) {
    const navigation = navigationCapability(feature);
    if (!navigation?.blocks) continue;
    const featureState = featureRuntimeState(feature, appState);
    const isDestroyed = Boolean(featureState?.destroyed) || destroyed.has(String(feature.id));
    if (navigation.passableWhenDestroyed && isDestroyed) continue;
    if (navigation.passableWhenOpen && featureState?.open) continue;
    if (!featureBlocksMover(feature, featureState, moverContext)) continue;
    rasterizePolygon(grid, featurePolygon(feature), cellSize, TILE_BLOCKED);
  }

  for (const feature of mapPackage.features || []) {
    const navigation = navigationCapability(feature);
    if (!navigation) continue;
    const featureState = featureRuntimeState(feature, appState);
    const passagePolygon = navigation.passagePolygon || featurePolygon(feature);
    const openPassage = navigation.passableWhenOpen && Boolean(featureState?.open);
    const destroyedPassage = navigation.passableWhenDestroyed && (
      Boolean(featureState?.destroyed) || destroyed.has(String(feature.id))
    );
    if (openPassage || destroyedPassage) {
      restorePassage(grid, base.grid, passagePolygon, cellSize, navigation.passageTile);
    }

    if (navigation.damageCreatesPassage) {
      const obstaclePolygon = featurePolygon(feature);
      for (const damagedPolygon of clipDamageForFeature(scene, feature.id)) {
        rasterizePolygon(
          grid,
          damagedPolygon,
          cellSize,
          (_point, column, row) => base.grid[row][column],
          (point) => pointInPolygon(point, obstaclePolygon),
        );
      }
    }
  }

  for (const bridgeId of mapPackage.navigation?.bridgeFeatureIds || []) {
    const bridge = (mapPackage.features || []).find((feature) => feature.id === bridgeId);
    if (!bridge || destroyed.has(String(bridgeId))) continue;
    const bridgePolygon = featurePolygon(bridge);
    const damagedPolygons = clipDamageForFeature(scene, bridgeId);
    rasterizePolygon(grid, bridgePolygon, cellSize, TILE_ROAD, (point) => (
      !damagedPolygons.some((polygon) => pointInPolygon(point, polygon))
    ));
  }

  // V1.5 height bypass applies to Feature navigation obstacles only. Liquid,
  // crater and flood vertical semantics remain explicit future 2.5D work.
  for (const crater of scene.craterRegions || []) {
    rasterizePolygon(grid, crater.polygon, cellSize, TILE_BLOCKED);
  }
  for (const region of deriveFloodRegions(
    scene,
    mapPackage.liquidBodies || [],
    mapPackage.features || [],
    mapPackage.floodRules || {},
  )) {
    rasterizePolygon(grid, region.polygon, cellSize, TILE_BLOCKED);
  }

  return Object.freeze({
    cellSize,
    width: base.width,
    height: base.height,
    columns,
    rows,
    grid,
    moverContext: Object.freeze({
      characterId: moverContext?.characterId == null ? null : String(moverContext.characterId),
      elevationFt: Number(moverContext?.elevationFt) || 0,
    }),
  });
}

function worldToCell(point, navigation) {
  return {
    x: Math.max(0, Math.min(navigation.columns - 1, Math.floor(Number(point.x) / navigation.cellSize))),
    y: Math.max(0, Math.min(navigation.rows - 1, Math.floor(Number(point.y) / navigation.cellSize))),
  };
}

function cellToWorld(cell, navigation) {
  return {
    x: Math.min(navigation.width, (cell.x + 0.5) * navigation.cellSize),
    y: Math.min(navigation.height, (cell.y + 0.5) * navigation.cellSize),
  };
}

export function nearestWalkablePoint(navigation, point, maximumDistance = 30) {
  const origin = worldToCell(point, navigation);
  const maximumCells = Math.ceil(maximumDistance / navigation.cellSize);
  let best = null;
  for (let radius = 0; radius <= maximumCells; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = origin.x + dx;
        const y = origin.y + dy;
        if (x < 0 || y < 0 || x >= navigation.columns || y >= navigation.rows) continue;
        if (navigation.grid[y][x] === TILE_BLOCKED) continue;
        const world = cellToWorld({ x, y }, navigation);
        const distance = Math.hypot(world.x - Number(point.x), world.y - Number(point.y));
        if (distance <= maximumDistance + navigation.cellSize / 2 && (!best || distance < best.distance)) {
          best = { ...world, cell: { x, y }, distance };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

function compressPath(points) {
  if (points.length <= 2) return points;
  const compressed = [points[0]];
  let previousDirection = null;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const direction = [Math.sign(current.x - previous.x), Math.sign(current.y - previous.y)];
    if (previousDirection && (direction[0] !== previousDirection[0] || direction[1] !== previousDirection[1])) {
      compressed.push(previous);
    }
    previousDirection = direction;
  }
  compressed.push(points.at(-1));
  return compressed;
}

function pathDistance(points) {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) {
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return distance;
}

export function findNavigationPath(navigation, startPoint, destinationPoint) {
  const start = nearestWalkablePoint(navigation, startPoint, 30);
  const destination = nearestWalkablePoint(navigation, destinationPoint, 30);
  if (!start || !destination) return Promise.resolve(null);

  const easystar = new EasyStar.js();
  easystar.setGrid(navigation.grid);
  easystar.setAcceptableTiles([TILE_ROAD, TILE_OPEN]);
  easystar.setTileCost(TILE_ROAD, 1);
  easystar.setTileCost(TILE_OPEN, 1.7);
  easystar.enableDiagonals();
  easystar.disableCornerCutting();
  easystar.setIterationsPerCalculation(5000);

  return new Promise((resolve) => {
    let finished = false;
    easystar.findPath(start.cell.x, start.cell.y, destination.cell.x, destination.cell.y, (path) => {
      finished = true;
      if (!path) {
        resolve(null);
        return;
      }
      const points = compressPath(path.map((cell) => cellToWorld(cell, navigation)));
      points[0] = { x: Number(startPoint.x), y: Number(startPoint.y) };
      points[points.length - 1] = { x: destination.x, y: destination.y };
      resolve({
        points,
        distance: pathDistance(points),
        destination: { x: destination.x, y: destination.y },
        snappedDestination: destination.distance > 1,
      });
    });
    const calculate = () => {
      if (finished) return;
      easystar.calculate();
      if (!finished) (globalThis.requestAnimationFrame || globalThis.setTimeout)(calculate);
    };
    calculate();
  });
}

export const NAVIGATION_TILES = Object.freeze({
  blocked: TILE_BLOCKED,
  road: TILE_ROAD,
  open: TILE_OPEN,
});
