import { deriveFloodRegions } from './state.js';
import { runtimeFeatureInteractionEffects } from '../interaction/effects.js';
import { getFeatureState } from '../interaction/feature-state.js';
import { featureBlocksMover } from '../elevation/model.js';
import {
  elevationNavigationAppState,
  getActiveMoverContext,
} from '../elevation/runtime-context.js';

// Collision is always evaluated on a 1 m logical grid.  This is deliberately
// independent of map rendering metadata, which may still use a coarser scale.
export const NAVIGATION_CELL_SIZE_METERS = 1;
export const NAVIGATION_CHUNK_SIZE_METERS = 64;

const TILE_BLOCKED = 0;
const TILE_ROAD = 1;
const TILE_OPEN = 2;

export const NAVIGATION_CELL_FLAGS = Object.freeze({
  blocked: 1,
  destructible: 2,
  water: 4,
  crater: 8,
  road: 16,
  boundary: 32,
});

const { blocked: CELL_BLOCKED, destructible: CELL_DESTRUCTIBLE, water: CELL_WATER,
  crater: CELL_CRATER, road: CELL_ROAD, boundary: CELL_BOUNDARY } = NAVIGATION_CELL_FLAGS;
const CHUNK_CELLS = NAVIGATION_CHUNK_SIZE_METERS * NAVIGATION_CHUNK_SIZE_METERS;
const EMPTY_CHUNK = new Uint8Array(CHUNK_CELLS);
const FOOTPRINT_OFFSETS = new Map();

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
    minX: Math.min(bounds.minX, x), minY: Math.min(bounds.minY, y),
    maxX: Math.max(bounds.maxX, x), maxY: Math.max(bounds.maxY, y),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function featurePolygon(feature) { return feature?.geometry?.points || feature?.polygon || []; }

function clipDamageForFeature(scene, featureId) {
  return (scene?.clipHits || [])
    .filter(hit => String(hit.featureId) === String(featureId))
    .map(hit => hit.polygon)
    .filter(polygon => Array.isArray(polygon) && polygon.length >= 3);
}

function navigationCapability(feature) {
  const declared = feature?.capabilities?.navigation || feature?.navigation;
  if (!declared || typeof declared !== 'object') return null;
  return Object.freeze({
    blocks: declared.blocks === true,
    collisionGroup: typeof declared.collisionGroup === 'string'
      ? declared.collisionGroup.trim().slice(0, 64) || null
      : null,
    passableWhenOpen: declared.passableWhenOpen === true,
    passableWhenDestroyed: declared.passableWhenDestroyed === true,
    damageCreatesPassage: declared.damageCreatesPassage === true,
    blockingPolygon: Array.isArray(declared.blockingPolygon) ? declared.blockingPolygon : null,
    passagePolygon: Array.isArray(declared.passagePolygon) ? declared.passagePolygon : null,
  });
}

function featureRuntimeState(feature, appState) {
  if (appState) {
    try { return getFeatureState(appState, feature); }
    catch (_error) { /* Fall through to the legacy effects adapter. */ }
  }
  return runtimeFeatureInteractionEffects(feature);
}

function resolvedMoverContext(explicit) {
  const source = explicit ?? getActiveMoverContext();
  const elevationFt = Number(source?.elevationFt);
  const requestedDiameter = Number(source?.diameterMeters);
  const collisionBypassGroups = [...new Set(
    (Array.isArray(source?.collisionBypassGroups) ? source.collisionBypassGroups : [])
      .map(value => String(value || '').trim().slice(0, 64))
      .filter(Boolean),
  )].sort();
  return Object.freeze({
    tokenId: source?.tokenId == null ? null : String(source.tokenId),
    elevationFt: Number.isFinite(elevationFt) && elevationFt >= 0 ? elevationFt : 0,
    diameterMeters: [1, 5, 10, 20].includes(requestedDiameter) ? requestedDiameter : 1,
    collisionBypassGroups: Object.freeze(collisionBypassGroups),
    statusVersion: String(source?.statusVersion || ''),
  });
}

function chunkKey(column, row) { return `${column}:${row}`; }

function chunkBounds(chunkColumn, chunkRow) {
  const minX = chunkColumn * NAVIGATION_CHUNK_SIZE_METERS;
  const minY = chunkRow * NAVIGATION_CHUNK_SIZE_METERS;
  return { minX, minY, maxX: minX + NAVIGATION_CHUNK_SIZE_METERS, maxY: minY + NAVIGATION_CHUNK_SIZE_METERS };
}

function boundsIntersect(left, right) {
  return left.minX < right.maxX && left.maxX > right.minX && left.minY < right.maxY && left.maxY > right.minY;
}

function addDescriptorToIndex(index, descriptor, columns, rows) {
  if (!descriptor.polygon?.length) return;
  const polygons = [descriptor.polygon, descriptor.navigation?.blockingPolygon, descriptor.navigation?.passagePolygon]
    .filter(polygon => Array.isArray(polygon) && polygon.length >= 3);
  const bounds = polygons.reduce((result, polygon) => {
    const next = polygonBounds(polygon);
    return {
      minX: Math.min(result.minX, next.minX), minY: Math.min(result.minY, next.minY),
      maxX: Math.max(result.maxX, next.maxX), maxY: Math.max(result.maxY, next.maxY),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  if (!Number.isFinite(bounds.minX)) return;
  descriptor.bounds = bounds;
  const minColumn = Math.max(0, Math.floor(bounds.minX / NAVIGATION_CHUNK_SIZE_METERS));
  const maxColumn = Math.min(columns - 1, Math.floor(Math.max(bounds.minX, bounds.maxX - Number.EPSILON) / NAVIGATION_CHUNK_SIZE_METERS));
  const minRow = Math.max(0, Math.floor(bounds.minY / NAVIGATION_CHUNK_SIZE_METERS));
  const maxRow = Math.min(rows - 1, Math.floor(Math.max(bounds.minY, bounds.maxY - Number.EPSILON) / NAVIGATION_CHUNK_SIZE_METERS));
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const key = chunkKey(column, row);
      const entries = index.get(key) || [];
      entries.push(descriptor);
      index.set(key, entries);
    }
  }
}

function paintPolygon(chunk, polygon, apply, predicate = null) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  const bounds = polygonBounds(polygon);
  if (!boundsIntersect(bounds, chunk.bounds)) return;
  const minColumn = Math.max(0, Math.floor(bounds.minX - chunk.bounds.minX));
  const maxColumn = Math.min(NAVIGATION_CHUNK_SIZE_METERS - 1, Math.floor(Math.max(bounds.minX, bounds.maxX - Number.EPSILON) - chunk.bounds.minX));
  const minRow = Math.max(0, Math.floor(bounds.minY - chunk.bounds.minY));
  const maxRow = Math.min(NAVIGATION_CHUNK_SIZE_METERS - 1, Math.floor(Math.max(bounds.minY, bounds.maxY - Number.EPSILON) - chunk.bounds.minY));
  for (let row = minRow; row <= maxRow; row += 1) {
    const worldY = chunk.bounds.minY + row + 0.5;
    if (worldY < 0 || worldY >= chunk.height) continue;
    for (let column = minColumn; column <= maxColumn; column += 1) {
      const worldX = chunk.bounds.minX + column + 0.5;
      if (worldX < 0 || worldX >= chunk.width) continue;
      const point = [worldX, worldY];
      if (pointInPolygon(point, polygon) && (!predicate || predicate(point))) apply(row * NAVIGATION_CHUNK_SIZE_METERS + column);
    }
  }
}

function featureIsDestroyed(feature, scene, state) {
  return Boolean(state?.destroyed) || (scene?.destroyedObjectIds || []).some(id => String(id) === String(feature.id));
}

function makeChunk(base, scene, appState, moverContext, chunkColumn, chunkRow, floodRegions = null) {
  const key = chunkKey(chunkColumn, chunkRow);
  const descriptors = base.descriptorIndex.get(key) || [];
  const chunk = { bounds: chunkBounds(chunkColumn, chunkRow), width: base.width, height: base.height };
  const flags = new Uint8Array(CHUNK_CELLS);

  // Terrain starts with roads and then water, retaining the existing priority.
  for (const descriptor of descriptors) if (descriptor.kind === 'road') {
    paintPolygon(chunk, descriptor.polygon, index => { flags[index] |= CELL_ROAD; });
  }
  for (const descriptor of descriptors) if (descriptor.kind === 'water') {
    paintPolygon(chunk, descriptor.polygon, index => { flags[index] |= CELL_BLOCKED | CELL_WATER; });
  }
  const terrainFlags = flags.slice();
  if (moverContext?.baseOnly) return flags.some(Boolean) ? flags : EMPTY_CHUNK;

  // Feature blockers and passages are separate passes. A passage restores the
  // terrain state, exactly as the prior grid implementation did.
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'feature') continue;
    const { feature, navigation } = descriptor;
    const state = featureRuntimeState(feature, appState);
    const destroyed = featureIsDestroyed(feature, scene, state);
    if (!navigation.blocks
      || (navigation.collisionGroup && moverContext?.collisionBypassGroups?.includes(navigation.collisionGroup))
      || (navigation.passableWhenDestroyed && destroyed)
      || (navigation.passableWhenOpen && state?.open)
      || !featureBlocksMover(feature, state, moverContext)) continue;
    const blockFlags = CELL_BLOCKED
      | ((navigation.passableWhenDestroyed || navigation.damageCreatesPassage) ? CELL_DESTRUCTIBLE : 0);
    paintPolygon(chunk, navigation.blockingPolygon || descriptor.polygon, index => { flags[index] |= blockFlags; });
  }
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'feature') continue;
    const { feature, navigation } = descriptor;
    const state = featureRuntimeState(feature, appState);
    const destroyed = featureIsDestroyed(feature, scene, state);
    if ((navigation.passableWhenDestroyed && destroyed) || (navigation.passableWhenOpen && state?.open)) {
      paintPolygon(chunk, navigation.passagePolygon || descriptor.polygon, index => { flags[index] = terrainFlags[index]; });
    }
    if (navigation.damageCreatesPassage) {
      for (const damage of clipDamageForFeature(scene, feature.id)) {
        paintPolygon(chunk, damage, index => { flags[index] = terrainFlags[index]; }, point => pointInPolygon(point, descriptor.polygon));
      }
    }
  }
  for (const descriptor of descriptors) {
    if (descriptor.kind !== 'bridge') continue;
    const state = featureRuntimeState(descriptor.feature, appState);
    if (featureIsDestroyed(descriptor.feature, scene, state)) continue;
    const damages = clipDamageForFeature(scene, descriptor.feature.id);
    paintPolygon(chunk, descriptor.polygon, index => { flags[index] = CELL_ROAD; }, point => !damages.some(polygon => pointInPolygon(point, polygon)));
  }
  for (const crater of scene?.craterRegions || []) paintPolygon(chunk, crater.polygon, index => { flags[index] |= CELL_BLOCKED | CELL_CRATER; });
  for (const region of floodRegions || deriveFloodRegions(scene || {}, base.mapPackage.liquidBodies || [], base.mapPackage.features || [], base.mapPackage.floodRules || {})) {
    paintPolygon(chunk, region.polygon, index => { flags[index] |= CELL_BLOCKED | CELL_WATER; });
  }
  return flags.some(Boolean) ? flags : EMPTY_CHUNK;
}

function tileForFlags(flags) {
  if (flags & CELL_BLOCKED) return TILE_BLOCKED;
  return flags & CELL_ROAD ? TILE_ROAD : TILE_OPEN;
}

function makeGridFacade(navigation) {
  return new Proxy([], {
    get(_target, rowProperty) {
      if (rowProperty === 'length') return navigation.rows;
      if (typeof rowProperty !== 'string' && typeof rowProperty !== 'number') return undefined;
      const row = Number(rowProperty);
      if (!Number.isInteger(row) || row < 0 || row >= navigation.rows) return undefined;
      return new Proxy([], {
        get(_rowTarget, columnProperty) {
          if (columnProperty === 'length') return navigation.columns;
          if (typeof columnProperty !== 'string' && typeof columnProperty !== 'number') return undefined;
          const column = Number(columnProperty);
          if (!Number.isInteger(column) || column < 0 || column >= navigation.columns) return undefined;
          return navigation.tileAt({ x: column, y: row });
        },
      });
    },
  });
}

function runtimeGridRevision(appState, moverContext, scene) {
  const featureStates = appState?.preferences?.featureStates || {};
  return `${moverContext.tokenId ?? ''}|${moverContext.elevationFt}|${moverContext.diameterMeters}|${moverContext.statusVersion || ''}|${(moverContext.collisionBypassGroups || []).join(',')}|${JSON.stringify(featureStates)}|${JSON.stringify(scene || {})}`;
}

export function createNavigationBase(mapPackage) {
  const width = Number(mapPackage.width);
  const height = Number(mapPackage.height);
  const columns = Math.ceil(width / NAVIGATION_CELL_SIZE_METERS);
  const rows = Math.ceil(height / NAVIGATION_CELL_SIZE_METERS);
  const chunkColumns = Math.ceil(columns / NAVIGATION_CHUNK_SIZE_METERS);
  const chunkRows = Math.ceil(rows / NAVIGATION_CHUNK_SIZE_METERS);
  const descriptorIndex = new Map();
  const add = descriptor => addDescriptorToIndex(descriptorIndex, descriptor, chunkColumns, chunkRows);
  for (const buffer of mapPackage.roadBuffers || []) add({ kind: 'road', polygon: featurePolygon(buffer) });
  for (const body of mapPackage.liquidBodies || []) add({ kind: 'water', polygon: body.polygon });
  for (const feature of mapPackage.features || []) {
    const navigation = navigationCapability(feature);
    if (navigation) add({ kind: 'feature', feature, navigation, polygon: featurePolygon(feature) });
  }
  for (const bridgeId of mapPackage.navigation?.bridgeFeatureIds || []) {
    const feature = (mapPackage.features || []).find(item => item.id === bridgeId);
    if (feature) add({ kind: 'bridge', feature, polygon: featurePolygon(feature) });
  }
  const baseChunks = new Map();
  const base = {
    mapPackage, cellSize: NAVIGATION_CELL_SIZE_METERS, width, height, columns, rows,
    chunkColumns, chunkRows, descriptorIndex,
    cellFlags(cell) {
      const column = Number(cell?.x); const row = Number(cell?.y);
      if (!Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= columns || row >= rows) return CELL_BLOCKED | CELL_BOUNDARY;
      const chunkColumn = Math.floor(column / NAVIGATION_CHUNK_SIZE_METERS);
      const chunkRow = Math.floor(row / NAVIGATION_CHUNK_SIZE_METERS);
      const key = chunkKey(chunkColumn, chunkRow);
      let chunk = baseChunks.get(key);
      if (!chunk) {
        chunk = makeChunk(base, {}, null, { elevationFt: 0, diameterMeters: 1, baseOnly: true }, chunkColumn, chunkRow, []);
        baseChunks.set(key, chunk);
      }
      return chunk[(row % NAVIGATION_CHUNK_SIZE_METERS) * NAVIGATION_CHUNK_SIZE_METERS + (column % NAVIGATION_CHUNK_SIZE_METERS)];
    },
    tileAt(cell) { return tileForFlags(this.cellFlags(cell)); },
  };
  Object.defineProperty(base, 'grid', { get: () => makeGridFacade(base) });
  return Object.freeze(base);
}

/** Build a lazy mover-aware field; no world-sized JavaScript array is made. */
export function createNavigationGrid(mapPackage, scene = {}, staticBase = null, options = {}) {
  const base = staticBase || createNavigationBase(mapPackage);
  if (base.width !== Number(mapPackage.width) || base.height !== Number(mapPackage.height)) throw new Error('navigation base does not match map dimensions');
  const dynamicAppState = options.appState === undefined;
  const dynamicMover = options.moverContext === undefined;
  let snapshot = null;
  let revision = null;
  let cachedMover = resolvedMoverContext(options.moverContext);
  const resolveSnapshot = () => {
    const appState = dynamicAppState ? elevationNavigationAppState() : options.appState;
    const moverContext = dynamicMover ? resolvedMoverContext() : resolvedMoverContext(options.moverContext);
    const nextRevision = runtimeGridRevision(appState, moverContext, scene);
    if (!snapshot || revision !== nextRevision) {
      const chunks = new Map();
      // Flood geometry is a scene-level derivation.  Compute it once for this
      // immutable navigation snapshot, never once per visited cell/chunk.
      const floodRegions = deriveFloodRegions(
        scene || {}, base.mapPackage.liquidBodies || [], base.mapPackage.features || [], base.mapPackage.floodRules || {}
      );
      snapshot = {
        occupancyByDiameter: new Map(),
        cellFlags(column, row) {
          if (column < 0 || row < 0 || column >= base.columns || row >= base.rows) return CELL_BLOCKED | CELL_BOUNDARY;
          const chunkColumn = Math.floor(column / NAVIGATION_CHUNK_SIZE_METERS);
          const chunkRow = Math.floor(row / NAVIGATION_CHUNK_SIZE_METERS);
          const key = chunkKey(chunkColumn, chunkRow);
          let chunk = chunks.get(key);
          if (!chunk) { chunk = makeChunk(base, scene, appState, moverContext, chunkColumn, chunkRow, floodRegions); chunks.set(key, chunk); }
          return chunk[(row % NAVIGATION_CHUNK_SIZE_METERS) * NAVIGATION_CHUNK_SIZE_METERS + (column % NAVIGATION_CHUNK_SIZE_METERS)];
        },
        get chunkCount() { return chunks.size; },
      };
      revision = nextRevision;
      cachedMover = moverContext;
    }
    return snapshot;
  };
  const navigation = {
    cellSize: base.cellSize, width: base.width, height: base.height, columns: base.columns, rows: base.rows,
    cellFlags(cell) { return resolveSnapshot().cellFlags(Number(cell?.x), Number(cell?.y)); },
    // A route obtains one immutable snapshot before it begins.  Re-checking
    // JSON state revision for every 1 m cell made a long direct drag costly.
    queryCellFlags() {
      const current = resolveSnapshot();
      return cell => current.cellFlags(Number(cell?.x), Number(cell?.y));
    },
    // A sparse capacity mask is kept for each Token diameter.  A cell is
    // evaluated once per snapshot and then direct-drag previews simply read a
    // byte from its 64 x 64 m chunk instead of rechecking the whole footprint.
    queryOccupation(diameterMeters) {
      const current = resolveSnapshot();
      return cell => inspectSnapshotOccupation(current, base, cell, diameterMeters);
    },
    tileAt(cell) { return tileForFlags(this.cellFlags(cell)); },
    get grid() { return makeGridFacade(this); },
    get moverContext() { resolveSnapshot(); return cachedMover; },
    get loadedChunkCount() { return resolveSnapshot().chunkCount; },
  };
  if (!dynamicAppState && !dynamicMover) resolveSnapshot();
  return Object.freeze(navigation);
}

function worldToCell(point, navigation) {
  return {
    x: Math.max(0, Math.min(navigation.columns - 1, Math.floor(Number(point.x) / navigation.cellSize))),
    y: Math.max(0, Math.min(navigation.rows - 1, Math.floor(Number(point.y) / navigation.cellSize))),
  };
}

function copyPoint(point) { return { x: Number(point.x), y: Number(point.y) }; }

function pointInsideNavigation(point, navigation) {
  const x = Number(point?.x); const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x <= navigation.width && y <= navigation.height;
}

export function snapNavigationPoint(point, navigation) {
  const cell = worldToCell(point, navigation);
  return { x: cell.x + 0.5, y: cell.y + 0.5 };
}

function cellToWorld(cell, navigation) {
  const cellSize = Number(navigation?.cellSize) || NAVIGATION_CELL_SIZE_METERS;
  return { x: (cell.x + 0.5) * cellSize, y: (cell.y + 0.5) * cellSize };
}

function navigationCellFlags(navigation, cell, readCellFlags = null) {
  if (readCellFlags) return readCellFlags(cell);
  if (typeof navigation?.cellFlags === 'function') return navigation.cellFlags(cell);
  const row = navigation?.grid?.[cell?.y];
  const tile = row?.[cell?.x];
  if (tile === TILE_BLOCKED || tile === undefined) return CELL_BLOCKED;
  return tile === TILE_ROAD ? CELL_ROAD : 0;
}

function cellIsWalkable(navigation, cell, readCellFlags = null) { return !(navigationCellFlags(navigation, cell, readCellFlags) & CELL_BLOCKED); }

function footprintOffsets(diameterMeters, cellSize = NAVIGATION_CELL_SIZE_METERS) {
  const diameter = [1, 5, 10, 20].includes(Number(diameterMeters)) ? Number(diameterMeters) : 1;
  const cacheKey = `${diameter}:${cellSize}`;
  const cached = FOOTPRINT_OFFSETS.get(cacheKey);
  if (cached) return cached;
  const radius = diameter / 2 / cellSize;
  const limit = Math.ceil(radius + 0.5);
  const offsets = [];
  for (let y = -limit; y <= limit; y += 1) {
    for (let x = -limit; x <= limit; x += 1) {
      if (Math.hypot(x, y) <= radius + 0.5 + 1e-9) offsets.push({ x, y });
    }
  }
  FOOTPRINT_OFFSETS.set(cacheKey, Object.freeze(offsets));
  return FOOTPRINT_OFFSETS.get(cacheKey);
}

function inspectSnapshotOccupation(snapshot, base, cell, diameterMeters) {
  const diameter = [1, 5, 10, 20].includes(Number(diameterMeters)) ? Number(diameterMeters) : 1;
  const column = Number(cell?.x); const row = Number(cell?.y);
  if (!Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0 || column >= base.columns || row >= base.rows) {
    return { blockedCell: { x: column, y: row }, blockingCell: { x: column, y: row }, blockingFlags: CELL_BLOCKED | CELL_BOUNDARY };
  }
  let diameterCache = snapshot.occupancyByDiameter.get(diameter);
  if (!diameterCache) {
    diameterCache = { masks: new Map(), blockingDetails: new Map() };
    snapshot.occupancyByDiameter.set(diameter, diameterCache);
  }
  const chunkColumn = Math.floor(column / NAVIGATION_CHUNK_SIZE_METERS);
  const chunkRow = Math.floor(row / NAVIGATION_CHUNK_SIZE_METERS);
  const chunk = chunkKey(chunkColumn, chunkRow);
  let mask = diameterCache.masks.get(chunk);
  if (!mask) { mask = new Uint8Array(CHUNK_CELLS); diameterCache.masks.set(chunk, mask); }
  const index = (row % NAVIGATION_CHUNK_SIZE_METERS) * NAVIGATION_CHUNK_SIZE_METERS + (column % NAVIGATION_CHUNK_SIZE_METERS);
  const cached = mask[index];
  const detailKey = `${chunk}:${index}`;
  if (cached === 1) return null;
  if (cached === 2) return diameterCache.blockingDetails.get(detailKey) || {
    blockedCell: { x: column, y: row }, blockingCell: { x: column, y: row }, blockingFlags: CELL_BLOCKED,
  };

  for (const offset of footprintOffsets(diameter, base.cellSize)) {
    const blockingCell = { x: column + offset.x, y: row + offset.y };
    const flags = snapshot.cellFlags(blockingCell.x, blockingCell.y);
    if (flags & CELL_BLOCKED) {
      const detail = { blockedCell: { x: column, y: row }, blockingCell, blockingFlags: flags };
      mask[index] = 2;
      diameterCache.blockingDetails.set(detailKey, detail);
      return detail;
    }
  }
  mask[index] = 1;
  return null;
}

function inspectOccupation(navigation, cell, diameterMeters, readCellFlags = null, inspectCachedOccupation = null) {
  if (inspectCachedOccupation) return inspectCachedOccupation(cell);
  for (const offset of footprintOffsets(diameterMeters, Number(navigation.cellSize) || NAVIGATION_CELL_SIZE_METERS)) {
    const blockingCell = { x: cell.x + offset.x, y: cell.y + offset.y };
    const flags = navigationCellFlags(navigation, blockingCell, readCellFlags);
    if (flags & CELL_BLOCKED) return { blockedCell: { ...cell }, blockingCell, blockingFlags: flags };
  }
  return null;
}

/**
 * Integer supercover traversal.  Its guard is the Manhattan cell distance;
 * it can never run past the destination forever as the former floating DDA
 * did.  Diagonal corner crossings visit both side cells.
 */
function traverseSupercover(startCell, endCell, visit) {
  let x = startCell.x; let y = startCell.y;
  const deltaX = endCell.x - x; const deltaY = endCell.y - y;
  const stepX = Math.sign(deltaX); const stepY = Math.sign(deltaY);
  const countX = Math.abs(deltaX); const countY = Math.abs(deltaY);
  let crossedX = 0; let crossedY = 0;
  const limit = countX + countY + 1;
  if (visit({ x, y }) === false) return { completed: false, iterationCount: 1 };
  for (let iteration = 0; iteration < limit; iteration += 1) {
    if (crossedX === countX && crossedY === countY) return { completed: true, iterationCount: iteration + 1 };
    const compareX = (1 + 2 * crossedX) * countY;
    const compareY = (1 + 2 * crossedY) * countX;
    if (compareX === compareY) {
      if (stepX && visit({ x: x + stepX, y }) === false) return { completed: false, iterationCount: iteration + 1 };
      if (stepY && visit({ x, y: y + stepY }) === false) return { completed: false, iterationCount: iteration + 1 };
      x += stepX; y += stepY; crossedX += 1; crossedY += 1;
    } else if (compareX < compareY) { x += stepX; crossedX += 1; }
    else { y += stepY; crossedY += 1; }
    if (visit({ x, y }) === false) return { completed: false, iterationCount: iteration + 1 };
  }
  return { completed: false, iterationCount: limit };
}

/** Inspect a direct path without allocating every crossed cell. */
export function inspectDirectNavigationPath(navigation, startPoint, destinationPoint, options = {}) {
  if (!pointInsideNavigation(startPoint, navigation) || !pointInsideNavigation(destinationPoint, navigation)) {
    return { valid: false, reason: 'outside-map', visitedCellCount: 0, blockedCell: null, blockingCell: null, blockingFlags: CELL_BOUNDARY };
  }
  const diameterMeters = options.diameterMeters ?? navigation.moverContext?.diameterMeters ?? 1;
  const startCell = worldToCell(startPoint, navigation);
  const endCell = worldToCell(destinationPoint, navigation);
  const readCellFlags = typeof navigation?.queryCellFlags === 'function'
    ? navigation.queryCellFlags()
    : null;
  const inspectCachedOccupation = typeof navigation?.queryOccupation === 'function'
    ? navigation.queryOccupation(diameterMeters)
    : null;
  let failure = null;
  let visitedCellCount = 0;
  const traversal = traverseSupercover(startCell, endCell, cell => {
    visitedCellCount += 1;
    failure = inspectOccupation(navigation, cell, diameterMeters, readCellFlags, inspectCachedOccupation);
    return !failure;
  });
  if (failure) return { valid: false, reason: 'blocked', visitedCellCount, ...failure };
  if (!traversal.completed) return { valid: false, reason: 'iteration-limit', visitedCellCount, blockedCell: null, blockingCell: null, blockingFlags: CELL_BOUNDARY };
  return { valid: true, visitedCellCount, blockedCell: null, blockingCell: null, blockingFlags: 0 };
}

export function isNavigationSegmentWalkable(navigation, startPoint, endPoint, options = {}) {
  return inspectDirectNavigationPath(navigation, startPoint, endPoint, options).valid;
}

export function nearestWalkablePoint(navigation, point, maximumDistance = 30, options = {}) {
  if (!pointInsideNavigation(point, navigation)) return null;
  const origin = worldToCell(point, navigation);
  const maximumCells = Math.ceil(maximumDistance / navigation.cellSize);
  const diameterMeters = options.diameterMeters ?? navigation.moverContext?.diameterMeters ?? 1;
  const readCellFlags = typeof navigation?.queryCellFlags === 'function'
    ? navigation.queryCellFlags()
    : null;
  const inspectCachedOccupation = typeof navigation?.queryOccupation === 'function'
    ? navigation.queryOccupation(diameterMeters)
    : null;
  for (let radius = 0; radius <= maximumCells; radius += 1) {
    let best = null;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cell = { x: origin.x + dx, y: origin.y + dy };
        if (!cellIsWalkable(navigation, cell, readCellFlags) || inspectOccupation(navigation, cell, diameterMeters, readCellFlags, inspectCachedOccupation)) continue;
        const world = cellToWorld(cell, navigation);
        const distance = Math.hypot(world.x - Number(point.x), world.y - Number(point.y));
        if (distance <= maximumDistance + navigation.cellSize / 2 && (!best || distance < best.distance)) best = { ...world, cell, distance };
      }
    }
    if (best) return best;
  }
  return null;
}

function pathDistance(points) {
  let distance = 0;
  for (let index = 1; index < points.length; index += 1) distance += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  return distance;
}

export function findDirectNavigationPath(navigation, startPoint, destinationPoint, options = {}) {
  const inspection = inspectDirectNavigationPath(navigation, startPoint, destinationPoint, options);
  if (!inspection.valid) return null;
  const start = copyPoint(startPoint); const destination = copyPoint(destinationPoint);
  return {
    points: [start, destination], distance: pathDistance([start, destination]),
    destination: copyPoint(destination), routeType: 'direct', inspection,
  };
}

export const NAVIGATION_TILES = Object.freeze({ blocked: TILE_BLOCKED, road: TILE_ROAD, open: TILE_OPEN });
