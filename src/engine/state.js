import {
  attackAreaToPolygon,
  featureToPolygon,
  hitTestFeatures,
  intersectionArea,
  polygonDifference,
  polygonArea,
} from './geometry.js';

export const SAVE_VERSION = 2;

// `reset` and `undo` are retained as legacy import/replay types. New saves use
// a linear history containing only damage and restore records.
const ACTION_EVENT_TYPES = new Set(['damage', 'restore', 'reset']);
const DANGEROUS_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_MARKER_COLOR = '#3498db';
const DEFAULT_ATTACK_COLOR = '#c00000';
const MAX_NAME_LENGTH = 80;
const MAX_MARKERS = 5000;
const MAX_CHARACTERS = 250;
const MAX_ATTACK_AREAS = 1000;
const MAX_SCENE_EVENTS = 5000;
const MAX_REFERENCES = 10000;
const MAX_POLYGON_POINTS = 512;
const MAX_CATEGORIES = 64;
const SAFE_HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WHOLE_OBJECT_COVERAGE = 0.95;
const WALL_LIKE_CATEGORIES = new Set(['wall', 'gate', 'pass-wall', 'pass-gate']);
const MAX_AVATAR_BYTES = 96 * 1024;
const MAX_AVATAR_TOTAL_BYTES = 3 * 1024 * 1024;
const SAFE_AVATAR_DATA_URL = /^data:image\/webp;base64,([a-zA-Z0-9+/]+={0,2})$/;

function validationError(message) {
    return new TypeError(`Invalid RPG map state: ${message}`);
}

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function asObject(value, label) {
    if (!isPlainObject(value)) throw validationError(`${label} must be an object`);
    return value;
}

function assertArrayLimit(value, maximum, label) {
    if (!Array.isArray(value)) throw validationError(`${label} must be an array`);
    if (value.length > maximum) {
        throw validationError(`${label} exceeds maximum item count ${maximum}`);
    }
    return value;
}

function asFiniteNumber(value, label) {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) throw validationError(`${label} must be finite`);
    return number;
}

function asPositiveNumber(value, label) {
    const number = asFiniteNumber(value, label);
    if (number <= 0) throw validationError(`${label} must be greater than zero`);
    return number;
}

function asId(value, label) {
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw validationError(`${label} must be a string or number`);
    }
    const id = String(value).trim();
    if (!id || DANGEROUS_IDS.has(id)) throw validationError(`${label} is invalid`);
    return id;
}

function optionalString(value, fallback = '') {
    return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeName(value, fallback) {
    const name = optionalString(value, fallback) || fallback;
    // Names remain plain text. Rendering code must continue to use textContent;
    // retaining characters such as < and > is safe and avoids corrupting names.
    return name.slice(0, MAX_NAME_LENGTH);
}

function normalizeColor(value, fallback, label) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value !== 'string' || !SAFE_HEX_COLOR.test(value)) {
        throw validationError(`${label} must be a safe six-digit hex color`);
    }
    return value;
}

function normalizeCreatedAt(value, label) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
        throw validationError(`${label} must be a valid ISO timestamp`);
    }
    return value;
}

function createdAtNow() {
    return new Date().toISOString();
}

function normalizeHeading(value) {
    const heading = asFiniteNumber(value ?? 0, 'headingDeg');
    return ((heading % 360) + 360) % 360;
}

function normalizePoint(value, label = 'point') {
    const point = asObject(value, label);
    const x = point.x ?? point.lng ?? point.longitude;
    const y = point.y ?? point.lat ?? point.latitude;
    return {
        x: asFiniteNumber(x, `${label}.x`),
        y: asFiniteNumber(y, `${label}.y`),
    };
}

function pointSource(raw, label) {
    const source = raw.position ?? raw.center ?? raw.origin ?? raw.latlng;
    if (source !== undefined) return normalizePoint(source, label);
    return normalizePoint(raw, label);
}

function sanitizeJsonValue(value, label = 'value', depth = 0) {
    if (depth > 20) throw validationError(`${label} is nested too deeply`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw validationError(`${label} contains a non-finite number`);
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) => sanitizeJsonValue(entry, `${label}[${index}]`, depth + 1));
    }
    if (!isPlainObject(value)) throw validationError(`${label} is not JSON-safe`);
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (DANGEROUS_IDS.has(key)) throw validationError(`${label} contains a forbidden key`);
        result[key] = sanitizeJsonValue(entry, `${label}.${key}`, depth + 1);
    }
    return result;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
}

function uniqueIds(values, label) {
    assertArrayLimit(values, MAX_REFERENCES, label);
    const seen = new Set();
    const result = [];
    for (let index = 0; index < values.length; index += 1) {
        const id = asId(values[index], `${label}[${index}]`);
        if (!seen.has(id)) {
            seen.add(id);
            result.push(id);
        }
    }
    return result;
}

function assertUnique(items, label) {
    const seen = new Set();
    for (const item of items) {
        if (seen.has(item.id)) throw validationError(`duplicate ${label} id "${item.id}"`);
        seen.add(item.id);
    }
}

function getMapMetadata(mapPackage) {
    const pkg = asObject(mapPackage, 'mapPackage');
    const manifest = isPlainObject(pkg.manifest) ? pkg.manifest : {};
    const mapId = asId(pkg.mapId ?? pkg.id ?? manifest.mapId ?? manifest.id, 'mapPackage.mapId');
    const versionValue = pkg.mapVersion ?? pkg.version ?? manifest.mapVersion ?? manifest.version;
    if (versionValue === undefined || versionValue === null || String(versionValue).trim() === '') {
        throw validationError('mapPackage.mapVersion is required');
    }
    return { mapId, mapVersion: String(versionValue) };
}

function getCompatibleMapVersions(mapPackage, currentVersion) {
    const manifest = isPlainObject(mapPackage.manifest) ? mapPackage.manifest : {};
    const configured = mapPackage.compatibleMapVersions
        ?? mapPackage.compatibleVersions
        ?? manifest.compatibleMapVersions
        ?? [];
    assertArrayLimit(configured, 32, 'mapPackage.compatibleMapVersions');
    return new Set([
        currentVersion,
        ...configured.map((version, index) => {
            const normalized = String(version ?? '').trim();
            if (!normalized) {
                throw validationError(`mapPackage.compatibleMapVersions[${index}] is invalid`);
            }
            return normalized;
        }),
    ]);
}

function getMapDimensions(mapPackage) {
    const manifest = isPlainObject(mapPackage.manifest) ? mapPackage.manifest : {};
    const rawWidth = mapPackage.width ?? manifest.width;
    const rawHeight = mapPackage.height ?? manifest.height;
    if (rawWidth === undefined || rawHeight === undefined) return null;
    return {
        width: asPositiveNumber(rawWidth, 'mapPackage.width'),
        height: asPositiveNumber(rawHeight, 'mapPackage.height'),
    };
}

function mapFeatures(mapPackage) {
    const candidates = [
        mapPackage.features,
        mapPackage.scene?.features,
        mapPackage.manifest?.features,
    ];
    return candidates.find(Array.isArray) ?? [];
}

function getMapFeatureIds(mapPackage) {
    const features = mapFeatures(mapPackage);
    const ids = new Set();
    for (let index = 0; index < features.length; index += 1) {
        const feature = features[index];
        if (!isPlainObject(feature)) continue;
        const value = feature.id ?? feature.featureId;
        if (value !== undefined) ids.add(asId(value, `mapPackage.features[${index}].id`));
    }
    return ids;
}

export function normalizeMarker(raw, index = 0) {
    const marker = asObject(raw, `markers[${index}]`);
    const id = asId(marker.id ?? marker.markerId ?? `marker-${index + 1}`, `markers[${index}].id`);
    const position = pointSource(marker, `markers[${index}].position`);
    const name = normalizeName(marker.name, `标记 ${index + 1}`);
    const color = normalizeColor(marker.color, DEFAULT_MARKER_COLOR, `markers[${index}].color`);
    return {
        id,
        name,
        x: position.x,
        y: position.y,
        color,
        visible: marker.visible !== false,
    };
}

function normalizeAvatarDataUrl(value, label) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw validationError(`${label} must be a WebP data URL`);
    const match = SAFE_AVATAR_DATA_URL.exec(value);
    if (!match) throw validationError(`${label} must be a WebP data URL`);
    const padding = (match[1].match(/=*$/)?.[0].length ?? 0);
    const byteLength = Math.floor(match[1].length * 3 / 4) - padding;
    if (byteLength > MAX_AVATAR_BYTES) {
        throw validationError(`${label} exceeds maximum ${MAX_AVATAR_BYTES} bytes`);
    }
    return value;
}

export function normalizeCharacter(raw, index = 0, knownFeatureIds = null) {
    const character = asObject(raw, `characters[${index}]`);
    const id = asId(character.id ?? character.characterId ?? `character-${index + 1}`, `characters[${index}].id`);
    const locationSource = character.location ?? character.position ?? character;
    const locationValue = asObject(locationSource, `characters[${index}].location`);
    const inferredType = locationValue.featureId !== undefined || locationValue.buildingId !== undefined
        ? 'building'
        : 'map';
    const locationType = optionalString(locationValue.type, inferredType).toLowerCase();
    let location;
    if (locationType === 'map') {
        const point = pointSource(locationValue, `characters[${index}].location`);
        location = { type: 'map', x: point.x, y: point.y };
    } else if (locationType === 'building') {
        const featureId = asId(
            locationValue.featureId ?? locationValue.buildingId,
            `characters[${index}].location.featureId`,
        );
        if (knownFeatureIds?.size && !knownFeatureIds.has(featureId)) {
            throw validationError(`characters[${index}] references unknown feature "${featureId}"`);
        }
        location = { type: 'building', featureId };
    } else {
        throw validationError(`characters[${index}].location.type is unsupported`);
    }
    return {
        id,
        name: normalizeName(character.name, `角色 ${index + 1}`),
        color: normalizeColor(character.color, DEFAULT_MARKER_COLOR, `characters[${index}].color`),
        avatarDataUrl: normalizeAvatarDataUrl(character.avatarDataUrl ?? character.avatar, `characters[${index}].avatarDataUrl`),
        visible: character.visible !== false,
        location,
    };
}

function normalizeAnchor(raw, label) {
    const source = raw.anchor ?? raw.binding ?? (raw.markerId !== undefined
        ? { type: 'marker', markerId: raw.markerId }
        : null);
    if (source === null || source === undefined || source === false) {
        return { type: 'free', markerId: null };
    }
    const anchor = asObject(source, label);
    const inferredType = anchor.characterId !== undefined
        ? 'character'
        : anchor.markerId !== undefined || anchor.id !== undefined ? 'marker' : 'free';
    const type = optionalString(anchor.type, inferredType).toLowerCase();
    if (type === 'free' || type === 'none') return { type: 'free', markerId: null };
    if (type === 'character') {
        return {
            type: 'character',
            characterId: asId(anchor.characterId ?? anchor.id, `${label}.characterId`),
        };
    }
    if (type !== 'marker') throw validationError(`${label}.type is unsupported`);
    return {
        type: 'marker',
        markerId: asId(anchor.markerId ?? anchor.id, `${label}.markerId`),
    };
}

function normalizeCategories(value, label) {
    if (value === undefined || value === null) return [];
    assertArrayLimit(value, MAX_CATEGORIES, label);
    return [...new Set(value.map((entry, index) => asId(entry, `${label}[${index}]`)))].sort();
}

export function normalizeAttackArea(raw, index = 0) {
    const area = asObject(raw, `attackAreas[${index}]`);
    const aliases = { fan: 'sector', cone: 'sector', rect: 'rectangle', box: 'rectangle' };
    const sourceShape = optionalString(area.shape ?? area.type, '').toLowerCase();
    const shape = aliases[sourceShape] ?? sourceShape;
    if (!['circle', 'sector', 'rectangle'].includes(shape)) {
        throw validationError(`attackAreas[${index}].shape is unsupported`);
    }

    const id = asId(area.id ?? area.areaId ?? `area-${index + 1}`, `attackAreas[${index}].id`);
    const opacity = asFiniteNumber(area.opacity ?? 0.18, `attackAreas[${index}].opacity`);
    if (opacity < 0 || opacity > 1) {
        throw validationError(`attackAreas[${index}].opacity must be between 0 and 1`);
    }
    const normalized = {
        id,
        name: normalizeName(area.name, `攻击范围 ${index + 1}`),
        shape,
        origin: pointSource(area, `attackAreas[${index}].origin`),
        anchor: normalizeAnchor(area, `attackAreas[${index}].anchor`),
        radius: asPositiveNumber(area.radius ?? 100, `attackAreas[${index}].radius`),
        range: asPositiveNumber(area.range ?? area.distance ?? 200, `attackAreas[${index}].range`),
        angleDeg: asPositiveNumber(area.angleDeg ?? area.angle ?? 60, `attackAreas[${index}].angleDeg`),
        length: asPositiveNumber(area.length ?? area.height ?? area.distance ?? 300, `attackAreas[${index}].length`),
        width: asPositiveNumber(area.width ?? 80, `attackAreas[${index}].width`),
        headingDeg: normalizeHeading(area.headingDeg ?? area.heading ?? area.rotation ?? 0),
        color: normalizeColor(area.color, DEFAULT_ATTACK_COLOR, `attackAreas[${index}].color`),
        opacity,
        visible: area.visible !== false,
        destructionEnabled: area.destructionEnabled === true,
        severeDamage: area.severeDamage === true,
        craterEnabled: area.craterEnabled === true,
        destructionTargets: normalizeCategories(
            area.destructionTargets ?? area.targetCategories ?? area.categories,
            `attackAreas[${index}].destructionTargets`,
        ),
    };
    if (normalized.angleDeg > 359) {
        throw validationError(`attackAreas[${index}].angleDeg must not exceed 359`);
    }

    return normalized;
}

export function damagePreviewSignature(area, categories = null) {
    const normalized = normalizeAttackArea(area);
    const selectedCategories = categories === null || categories === undefined
        ? normalized.destructionTargets
        : normalizeCategories(categories instanceof Set ? [...categories] : categories, 'preview categories');
    const geometry = {
        areaId: normalized.id,
        shape: normalized.shape,
        origin: [normalized.origin.x, normalized.origin.y],
        severeDamage: normalized.severeDamage,
        craterEnabled: normalized.craterEnabled,
        categories: selectedCategories,
    };
    if (normalized.shape === 'circle') geometry.radius = normalized.radius;
    if (normalized.shape === 'sector') {
        geometry.range = normalized.range;
        geometry.angleDeg = normalized.angleDeg;
        geometry.headingDeg = normalized.headingDeg;
    }
    if (normalized.shape === 'rectangle') {
        geometry.length = normalized.length;
        geometry.width = normalized.width;
        geometry.headingDeg = normalized.headingDeg;
    }
    return JSON.stringify(geometry);
}

function snapshotAttackArea(area) {
    const snapshot = normalizeAttackArea(area);
    // The resolved center is authoritative for a historical attack. A live marker
    // binding must never move already-committed damage.
    snapshot.anchor = { type: 'free', markerId: null };
    return deepFreeze(snapshot);
}

function validateSaveSpatialBounds(markers, characters, attackAreas, mapPackage) {
    const dimensions = getMapDimensions(mapPackage);
    if (!dimensions) return;
    const { width, height } = dimensions;
    markers.forEach((marker, index) => {
        if (marker.x < 0 || marker.x > width || marker.y < 0 || marker.y > height) {
            throw validationError(
                `markers[${index}] lies outside map bounds 0..${width} × 0..${height}`,
            );
        }
    });
    characters.forEach((character, index) => {
        if (character.location.type !== 'map') return;
        const { x, y } = character.location;
        if (x < 0 || x > width || y < 0 || y > height) {
            throw validationError(
                `characters[${index}] lies outside map bounds 0..${width} × 0..${height}`,
            );
        }
    });

    const maxAttackSize = Math.max(width, height) * 4;
    attackAreas.forEach((area, index) => {
        for (const field of ['radius', 'range', 'length', 'width']) {
            if (area[field] > maxAttackSize) {
                throw validationError(
                    `attackAreas[${index}].${field} exceeds maximum ${maxAttackSize}`,
                );
            }
        }
    });
}

function coordinatePoint(coordinate, label) {
    if (Array.isArray(coordinate)) {
        if (coordinate.length < 2) throw validationError(`${label} must contain x and y`);
        return {
            x: asFiniteNumber(coordinate[0], `${label}[0]`),
            y: asFiniteNumber(coordinate[1], `${label}[1]`),
        };
    }
    return normalizePoint(coordinate, label);
}

function coordinateRing(ring, label) {
    if (!Array.isArray(ring) || ring.length < 3) return [];
    const points = ring.map((coordinate, index) => coordinatePoint(coordinate, `${label}[${index}]`));
    if (points.length > 3) {
        const first = points[0];
        const last = points[points.length - 1];
        if (first.x === last.x && first.y === last.y) points.pop();
    }
    return points;
}

function categorySet(categories) {
    if (categories === undefined || categories === null) return null;
    const list = categories instanceof Set ? [...categories] : categories;
    if (!Array.isArray(list)) throw validationError('categories must be an array or Set');
    return new Set(list.map((entry, index) => asId(entry, `categories[${index}]`)));
}

export function createDamagePreview(area, features, categories) {
    const areaSnapshot = normalizeAttackArea(area);
    if (!Array.isArray(features)) throw validationError('features must be an array');
    const allowedCategories = categorySet(categories);
    const eligibleFeatures = features.filter((feature) =>
        feature?.destructible !== false
        && feature?.hitTest !== false,
    );
    // Severe-only ground features are always eligible when severe damage is
    // enabled, regardless of the selected category chips.
    const severeOnlyFeatures = areaSnapshot.severeDamage === true
        ? eligibleFeatures.filter((feature) => feature.severeOnly === true)
        : [];
    const normalFeatures = eligibleFeatures.filter((feature) => feature.severeOnly !== true);
    const polygon = attackAreaToPolygon(areaSnapshot);
    const geometryHits = [
        ...hitTestFeatures(areaSnapshot, normalFeatures, allowedCategories),
        ...hitTestFeatures(areaSnapshot, severeOnlyFeatures),
    ];
    const objectIds = [];
    const clipHits = [];
    const counts = {};
    const hits = [];
    const seen = new Set();

    for (const hit of geometryHits) {
        const feature = asObject(hit.feature, 'damage hit feature');
        const featureId = asId(hit.featureId ?? feature.id ?? feature.featureId, 'damage hit feature id');
        if (seen.has(featureId)) throw validationError(`duplicate feature id "${featureId}"`);
        seen.add(featureId);
        const category = asId(hit.category ?? feature.category ?? 'uncategorized', 'damage hit category');
        const policy = optionalString(
            hit.mode ?? feature.mode ?? feature.damageMode ?? feature.destructionMode ?? feature.damagePolicy,
            'object',
        ).toLowerCase();
        if (policy === 'none' || policy === 'indestructible') continue;
        const localized = policy === 'clip' || policy === 'precise' || policy === 'exact'
            || category === 'terrain'
            || WALL_LIKE_CATEGORIES.has(category);
        const coverage = asFiniteNumber(hit.coverage ?? 0, `hit ${featureId} coverage`);
        if (localized || coverage + 1e-9 < WHOLE_OBJECT_COVERAGE) {
            clipHits.push({
                featureId,
                // Keeping the attack polygon, rather than a mutable SVG path, lets
                // the renderer recompute masks and unions after restore/undo.
                polygon: polygon.map((point) => coordinatePoint(point, 'attack polygon point')),
            });
        } else {
            objectIds.push(featureId);
        }
        counts[category] = (counts[category] ?? 0) + 1;
        hits.push({
            featureId,
            category,
            mode: policy,
            coverage,
            centerHit: hit.centerHit === true,
            intersectionArea: asFiniteNumber(hit.intersectionArea ?? 0, `hit ${featureId} intersectionArea`),
        });
    }

    objectIds.sort();
    clipHits.sort((left, right) => left.featureId.localeCompare(right.featureId));
    const featureIds = [...objectIds, ...clipHits.map((hit) => hit.featureId)].sort();
    return {
        areaId: areaSnapshot.id,
        areaSnapshot,
        categories: allowedCategories ? [...allowedCategories].sort() : null,
        signature: damagePreviewSignature(areaSnapshot, allowedCategories),
        objectIds,
        clipHits,
        featureIds,
        counts,
        hits,
        craterPolygon: areaSnapshot.craterEnabled
            ? polygon.map((point) => coordinatePoint(point, 'crater polygon point'))
            : null,
    };
}

function normalizePolygon(raw, label) {
    assertArrayLimit(raw, MAX_POLYGON_POINTS + 1, label);
    const polygon = coordinateRing(raw, label);
    if (polygon.length < 3) throw validationError(`${label} must contain at least three points`);
    return polygon;
}

function normalizeClipHits(raw, label, knownFeatureIds = null) {
    assertArrayLimit(raw, MAX_REFERENCES, label);
    const seen = new Set();
    const result = [];
    for (let index = 0; index < raw.length; index += 1) {
        const hit = asObject(raw[index], `${label}[${index}]`);
        const featureId = asId(hit.featureId ?? hit.id, `${label}[${index}].featureId`);
        if (knownFeatureIds?.size && !knownFeatureIds.has(featureId)) {
            throw validationError(`${label}[${index}] references unknown feature "${featureId}"`);
        }
        if (seen.has(featureId)) throw validationError(`${label} repeats feature "${featureId}"`);
        seen.add(featureId);
        result.push({
            featureId,
            polygon: normalizePolygon(hit.polygon ?? hit.geometry, `${label}[${index}].polygon`),
        });
    }
    return result;
}

function nextEventId(events) {
    const used = new Set(events.map((event) => event.id));
    let sequence = events.length + 1;
    let id = `scene-${String(sequence).padStart(6, '0')}`;
    while (used.has(id)) {
        sequence += 1;
        id = `scene-${String(sequence).padStart(6, '0')}`;
    }
    return id;
}

function stateEvents(state) {
    const value = asObject(state, 'state');
    if (!Array.isArray(value.sceneEvents)) throw validationError('state.sceneEvents must be an array');
    return value.sceneEvents;
}

function appendEvent(state, event) {
    const events = stateEvents(state);
    return {
        ...state,
        sceneEvents: [...events, deepFreeze(event)],
    };
}

/**
 * Append a damage event and return a new state. Both call orders are accepted:
 *   commitDamageEvent(state, area, preview)       (public specification)
 *   commitDamageEvent(state, preview, area?)      (UI convenience)
 */
export function commitDamageEvent(state, areaOrPreview, previewOrArea) {
    const events = stateEvents(state);
    const secondLooksLikePreview = isPlainObject(areaOrPreview)
        && (Array.isArray(areaOrPreview.objectIds) || Array.isArray(areaOrPreview.clipHits));
    const preview = secondLooksLikePreview ? areaOrPreview : previewOrArea;
    const area = secondLooksLikePreview
        ? (previewOrArea ?? areaOrPreview.areaSnapshot)
        : areaOrPreview;
    const value = asObject(preview, 'preview');
    if (!area) throw validationError('an attack area is required to commit damage');
    const hasLiveArea = !secondLooksLikePreview || previewOrArea !== undefined;
    const currentCategories = hasLiveArea
        ? (area.destructionTargets
            ?? area.targetCategories
            ?? area.categories
            ?? value.categories)
        : value.categories;
    const expectedSignature = damagePreviewSignature(area, currentCategories);
    if (value.signature !== expectedSignature) {
        throw validationError('damage preview is stale; preview the current area again');
    }
    const objectIds = uniqueIds(value.objectIds ?? [], 'preview.objectIds');
    const clipHits = normalizeClipHits(value.clipHits ?? [], 'preview.clipHits');
    const overlap = new Set(objectIds);
    for (const hit of clipHits) {
        if (overlap.has(hit.featureId)) {
            throw validationError(`preview contains both object and clip damage for "${hit.featureId}"`);
        }
    }
    const craterPolygon = value.craterPolygon
        ? normalizePolygon(value.craterPolygon, 'preview.craterPolygon')
        : null;
    if (objectIds.length === 0 && clipHits.length === 0 && !craterPolygon) return state;
    const event = {
        id: nextEventId(events),
        type: 'damage',
        createdAt: createdAtNow(),
        areaSnapshot: snapshotAttackArea(area),
        objectIds,
        clipHits,
        ...(craterPolygon ? { craterPolygon } : {}),
    };
    return appendEvent(state, event);
}

export function commitRestoreEvent(state, featureIds) {
    const events = stateEvents(state);
    const requested = uniqueIds(featureIds, 'featureIds');
    const currentlyDamaged = new Set(deriveSceneState(events).damagedFeatureIds);
    const effective = requested.filter((featureId) => currentlyDamaged.has(featureId)).sort();
    if (effective.length === 0) return state;
    return appendEvent(state, {
        id: nextEventId(events),
        type: 'restore',
        createdAt: createdAtNow(),
        featureIds: effective,
    });
}

export function commitResetSceneEvent(state) {
    const events = stateEvents(state);
    if (events.length === 0) return state;
    return {
        ...state,
        // Reset is a destructive format of scene history, not an undoable
        // action. No reset record is retained in the save.
        sceneEvents: [],
    };
}

function eventIdAndType(event, index) {
    const value = asObject(event, `sceneEvents[${index}]`);
    return {
        value,
        id: asId(value.id ?? value.eventId, `sceneEvents[${index}].id`),
        type: optionalString(value.type, '').toLowerCase(),
    };
}

export function deriveSceneState(events) {
    if (!Array.isArray(events)) throw validationError('events must be an array');
    const seen = new Map();
    const undoneEventIds = new Set();

    events.forEach((event, index) => {
        const { value, id, type } = eventIdAndType(event, index);
        if (seen.has(id)) throw validationError(`duplicate scene event id "${id}"`);
        if (type === 'undo') {
            const targetEventId = asId(value.targetEventId, `sceneEvents[${index}].targetEventId`);
            const target = seen.get(targetEventId);
            if (!target || !ACTION_EVENT_TYPES.has(target.type)) {
                throw validationError(`sceneEvents[${index}] has an invalid undo target`);
            }
            if (undoneEventIds.has(targetEventId)) {
                throw validationError(`sceneEvents[${index}] repeats an undo target`);
            }
            undoneEventIds.add(targetEventId);
        } else if (!ACTION_EVENT_TYPES.has(type)) {
            throw validationError(`sceneEvents[${index}].type is unsupported`);
        }
        seen.set(id, { type, value });
    });

    const objectSources = new Map();
    const clipSources = new Map();
    const craterSources = new Map();
    const activeSceneEventIds = [];

    for (let index = 0; index < events.length; index += 1) {
        const { value, id, type } = eventIdAndType(events[index], index);
        if (type === 'undo' || undoneEventIds.has(id)) continue;
        activeSceneEventIds.push(id);
        if (type === 'reset') {
            objectSources.clear();
            clipSources.clear();
            craterSources.clear();
            continue;
        }
        if (type === 'restore') {
            for (const featureId of uniqueIds(value.featureIds ?? [], `sceneEvents[${index}].featureIds`)) {
                objectSources.delete(featureId);
                clipSources.delete(featureId);
            }
            continue;
        }

        for (const featureId of uniqueIds(value.objectIds ?? [], `sceneEvents[${index}].objectIds`)) {
            if (!objectSources.has(featureId)) objectSources.set(featureId, new Set());
            objectSources.get(featureId).add(id);
        }
        const hits = normalizeClipHits(value.clipHits ?? [], `sceneEvents[${index}].clipHits`);
        for (const hit of hits) {
            if (!clipSources.has(hit.featureId)) clipSources.set(hit.featureId, []);
            clipSources.get(hit.featureId).push({
                eventId: id,
                featureId: hit.featureId,
                polygon: hit.polygon,
            });
        }
        if (value.craterPolygon) {
            craterSources.set(id, {
                eventId: id,
                polygon: normalizePolygon(value.craterPolygon, `sceneEvents[${index}].craterPolygon`),
            });
        }
    }

    const destroyedObjectIds = [...objectSources.keys()].sort();
    const clipHits = [...clipSources.values()]
        .flat()
        .sort((left, right) => left.featureId.localeCompare(right.featureId)
            || left.eventId.localeCompare(right.eventId));
    const damagedFeatureIds = [...new Set([
        ...destroyedObjectIds,
        ...clipHits.map((hit) => hit.featureId),
    ])].sort();
    const craterRegions = [...craterSources.values()].sort((left, right) => left.eventId.localeCompare(right.eventId));

    return {
        destroyedObjectIds,
        clipHits,
        damagedFeatureIds,
        craterRegions,
        activeSceneEventIds,
        undoneEventIds: [...undoneEventIds].sort(),
    };
}

/**
 * Derive the destruction polygons that should fill with liquid.
 *
 * A destruction polygon (a clip-hit attack polygon or a destroyed object
 * footprint) floods when more than 1% of its area overlaps any liquid body.
 * The returned polygons are the destruction ranges with the original liquid
 * bodies subtracted, so the flood only covers the destroyed land and never
 * paints over the existing water; it visibly starts at the water's edge.
 */
function tuple(point) {
    return Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [Number(point.x), Number(point.y)];
}

function closestPointOnSegment(point, start, end) {
    const [px, py] = point;
    const [ax, ay] = start;
    const [bx, by] = end;
    const dx = bx - ax;
    const dy = by - ay;
    const scale = dx * dx + dy * dy;
    const t = scale <= 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / scale));
    return [ax + dx * t, ay + dy * t];
}

function polygonConnectionCandidates(left, right, maximumDistance) {
    const a = left.map(tuple);
    const b = right.map(tuple);
    const candidates = [];
    const add = (from, to) => {
        const distance = Math.hypot(to[0] - from[0], to[1] - from[1]);
        if (distance <= maximumDistance + 1e-9) candidates.push({ from, to, distance });
    };
    for (let ai = 0; ai < a.length; ai += 1) {
        const aStart = a[ai];
        const aEnd = a[(ai + 1) % a.length];
        for (let bi = 0; bi < b.length; bi += 1) {
            const bStart = b[bi];
            const bEnd = b[(bi + 1) % b.length];
            add(aStart, closestPointOnSegment(aStart, bStart, bEnd));
            add(aEnd, closestPointOnSegment(aEnd, bStart, bEnd));
            const onAStart = closestPointOnSegment(bStart, aStart, aEnd);
            const onAEnd = closestPointOnSegment(bEnd, aStart, aEnd);
            add(onAStart, bStart);
            add(onAEnd, bEnd);
        }
    }
    return candidates
        .sort((leftCandidate, rightCandidate) => leftCandidate.distance - rightCandidate.distance)
        .filter((candidate, index, all) => index === 0
            || Math.hypot(candidate.from[0] - all[index - 1].from[0], candidate.from[1] - all[index - 1].from[1]) > 0.5
            || Math.hypot(candidate.to[0] - all[index - 1].to[0], candidate.to[1] - all[index - 1].to[1]) > 0.5)
        .slice(0, 64);
}

function connectorPolygon(start, end, width) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-6) return null;
    const nx = -(dy / length) * width / 2;
    const ny = (dx / length) * width / 2;
    return [
        [start[0] + nx, start[1] + ny],
        [end[0] + nx, end[1] + ny],
        [end[0] - nx, end[1] - ny],
        [start[0] - nx, start[1] - ny],
    ];
}

function polygonKey(ring) {
    return ring.map((point) => {
        const [x, y] = tuple(point);
        return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    }).join('|');
}

function blockerPolygons(scene, features) {
    const destroyed = new Set(scene.destroyedObjectIds || []);
    return (features || [])
        .filter((feature) => ['building', 'wall'].includes(feature.category) && !destroyed.has(feature.id))
        .map((feature) => {
            try { return featureToPolygon(feature); } catch { return null; }
        })
        .filter(Boolean);
}

function connectionIsClear(connector, blockers) {
    if (!connector) return true;
    return blockers.every((blocker) => {
        try { return intersectionArea(connector, blocker) <= 0.5; } catch { return false; }
    });
}

export function deriveFloodRegions(scene, liquidBodies = [], features = [], rules = {}) {
    if (!scene) return [];
    const maxGap = Number(rules.maxInflowGapMeters ?? 12);
    const inletWidth = Number(rules.inletWidthMeters ?? 6);
    const propagationGap = Number(rules.propagationGapMeters ?? 1);
    const featureById = new Map((features || []).map((feature) => [feature.id, feature]));
    const craterEventIds = new Set((scene.craterRegions || []).map((crater) => crater.eventId));
    const legacyCandidates = [];
    (scene.clipHits || []).forEach((hit, index) => {
        if (hit?.polygon && !craterEventIds.has(hit.eventId)) {
            legacyCandidates.push({ id: `clip-${hit.eventId || index}`, polygon: hit.polygon, kind: 'legacy' });
        }
    });
    (scene.destroyedObjectIds || []).forEach((id) => {
        const feature = featureById.get(id);
        if (!feature) return;
        try {
            const polygon = featureToPolygon(feature);
            if (polygon.length) legacyCandidates.push({ id: `object-${id}`, polygon, kind: 'legacy' });
        } catch {
            // A destroyed feature without usable geometry cannot flood.
        }
    });
    const craters = (scene.craterRegions || []).map((crater) => ({
        id: `crater-${crater.eventId}`,
        eventId: crater.eventId,
        polygon: crater.polygon,
        kind: 'crater',
    }));
    const blockers = blockerPolygons(scene, features);
    const flooded = new Map();
    const regions = [];

    for (const body of liquidBodies || []) {
        for (const candidate of legacyCandidates) {
            const area = polygonArea(candidate.polygon);
            if (area <= 0) continue;
            try {
                if (intersectionArea(candidate.polygon, body.polygon) / area > 0.01) {
                    flooded.set(candidate.id, body.id);
                }
            } catch {
                // Invalid optional liquid metadata is ignored.
            }
        }
        for (const crater of craters) {
            let connection = null;
            try {
                if (intersectionArea(crater.polygon, body.polygon) > 1e-6) {
                    connection = { distance: 0, from: crater.polygon[0], to: crater.polygon[0] };
                } else {
                    connection = polygonConnectionCandidates(body.polygon, crater.polygon, maxGap)
                        .find((candidate) => connectionIsClear(
                            connectorPolygon(candidate.from, candidate.to, inletWidth),
                            blockers,
                        ));
                }
            } catch {
                connection = null;
            }
            if (!connection) continue;
            flooded.set(crater.id, body.id);
            const inlet = connectorPolygon(connection.from, connection.to, inletWidth);
            if (inlet) {
                regions.push({
                    id: `inlet-${body.id}-${crater.id}`,
                    sourceBodyId: body.id,
                    eventId: crater.eventId,
                    kind: 'inlet',
                    polygon: inlet,
                    flowLine: [connection.from, connection.to],
                });
            }
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const crater of craters) {
            if (flooded.has(crater.id)) continue;
            for (const source of craters) {
                if (!flooded.has(source.id)) continue;
                const connection = polygonConnectionCandidates(source.polygon, crater.polygon, propagationGap)[0];
                if (!connection) continue;
                flooded.set(crater.id, flooded.get(source.id));
                changed = true;
                break;
            }
        }
    }

    const candidates = [...legacyCandidates, ...craters];
    const seen = new Set(regions.map((region) => polygonKey(region.polygon)));
    for (const candidate of candidates) {
        const sourceBodyId = flooded.get(candidate.id);
        if (!sourceBodyId) continue;
        let remainder = candidate.polygon;
        for (const body of liquidBodies || []) {
            try { remainder = polygonDifference(remainder, body.polygon); } catch { /* retain remainder */ }
        }
        flattenMultiPolygonRings(remainder).forEach((ring, index) => {
            const key = polygonKey(ring);
            if (seen.has(key)) return;
            seen.add(key);
            regions.push({
                id: `flood-${candidate.id}-${index}`,
                sourceBodyId,
                eventId: candidate.eventId || null,
                kind: candidate.kind,
                polygon: ring,
            });
        });
    }
    return regions;
}

export function deriveFloodPolygons(scene, liquidBodies = [], features = [], rules = {}) {
    return deriveFloodRegions(scene, liquidBodies, features, rules).map((region) => region.polygon);
}

function flattenMultiPolygonRings(multi) {
    const rings = [];
    (multi || []).forEach((polygon) => {
        (polygon || []).forEach((ring) => {
            if (Array.isArray(ring) && ring.length >= 3 && polygonArea(ring) > 1e-6) rings.push(ring);
        });
    });
    return rings;
}

export function undoLastSceneEvent(state) {
    const events = stateEvents(state);
    if (events.length === 0) return state;
    return {
        ...state,
        // Linear history makes undo a real rollback: the last record is
        // removed instead of being shadowed by another event.
        sceneEvents: events.slice(0, -1),
    };
}

function canonicalizeLegacySceneEvents(events) {
    const undone = new Set();
    for (const event of events) {
        if (event.type === 'undo') undone.add(event.targetEventId);
    }

    const activeActions = events.filter(event => (
        ACTION_EVENT_TYPES.has(event.type) && !undone.has(event.id)
    ));
    let resetIndex = -1;
    for (let index = 0; index < activeActions.length; index += 1) {
        if (activeActions[index].type === 'reset') resetIndex = index;
    }

    // An active legacy reset erased everything before it. The reset record
    // itself is omitted because resets are no longer part of linear history.
    return activeActions
        .slice(resetIndex + 1)
        .filter(event => event.type === 'damage' || event.type === 'restore');
}

function normalizeSceneEvents(rawEvents, knownFeatureIds) {
    assertArrayLimit(rawEvents, MAX_SCENE_EVENTS, 'sceneEvents');
    const normalized = [];
    const priorActions = new Map();
    const undone = new Set();

    for (let index = 0; index < rawEvents.length; index += 1) {
        const { value, id, type } = eventIdAndType(rawEvents[index], index);
        const createdAt = normalizeCreatedAt(value.createdAt, `sceneEvents[${index}].createdAt`);
        if (normalized.some((event) => event.id === id)) {
            throw validationError(`duplicate scene event id "${id}"`);
        }
        let event;
        if (type === 'damage') {
            const objectIds = uniqueIds(value.objectIds ?? [], `sceneEvents[${index}].objectIds`).sort();
            if (knownFeatureIds.size) {
                for (const featureId of objectIds) {
                    if (!knownFeatureIds.has(featureId)) {
                        throw validationError(`sceneEvents[${index}] references unknown feature "${featureId}"`);
                    }
                }
            }
            const clipHits = normalizeClipHits(
                value.clipHits ?? [],
                `sceneEvents[${index}].clipHits`,
                knownFeatureIds,
            );
            const objectSet = new Set(objectIds);
            if (clipHits.some((hit) => objectSet.has(hit.featureId))) {
                throw validationError(`sceneEvents[${index}] mixes object and clip damage`);
            }
            event = {
                id,
                type,
                ...(createdAt ? { createdAt } : {}),
                areaSnapshot: snapshotAttackArea(value.areaSnapshot),
                objectIds,
                clipHits,
                ...(value.craterPolygon
                    ? { craterPolygon: normalizePolygon(value.craterPolygon, `sceneEvents[${index}].craterPolygon`) }
                    : {}),
            };
        } else if (type === 'restore') {
            const featureIds = uniqueIds(value.featureIds ?? [], `sceneEvents[${index}].featureIds`).sort();
            if (knownFeatureIds.size) {
                for (const featureId of featureIds) {
                    if (!knownFeatureIds.has(featureId)) {
                        throw validationError(`sceneEvents[${index}] references unknown feature "${featureId}"`);
                    }
                }
            }
            event = { id, type, ...(createdAt ? { createdAt } : {}), featureIds };
        } else if (type === 'reset') {
            event = { id, type, ...(createdAt ? { createdAt } : {}) };
        } else if (type === 'undo') {
            const targetEventId = asId(value.targetEventId, `sceneEvents[${index}].targetEventId`);
            if (!priorActions.has(targetEventId) || undone.has(targetEventId)) {
                throw validationError(`sceneEvents[${index}] has an invalid undo target`);
            }
            undone.add(targetEventId);
            event = { id, type, ...(createdAt ? { createdAt } : {}), targetEventId };
        } else {
            throw validationError(`sceneEvents[${index}].type is unsupported`);
        }
        normalized.push(event);
        if (ACTION_EVENT_TYPES.has(type)) priorActions.set(id, type);
    }
    // Replay validation catches malformed legacy ordering. After validation,
    // compact append-only reset/undo logs into the new linear representation so
    // imports remain compatible while every subsequent export is canonical.
    deriveSceneState(normalized);
    const canonical = canonicalizeLegacySceneEvents(normalized);
    deriveSceneState(canonical);
    return canonical;
}

export function removeMarkers(state, markerIds) {
    const value = asObject(state, 'state');
    if (!Array.isArray(value.markers)) throw validationError('state.markers must be an array');
    if (!Array.isArray(value.attackAreas)) throw validationError('state.attackAreas must be an array');
    if (!Array.isArray(markerIds)) throw validationError('markerIds must be an array');

    const requestedIds = new Set(uniqueIds(markerIds, 'markerIds'));
    const removedMarkers = [];
    const removedById = new Map();
    value.markers.forEach((marker, index) => {
        const id = asId(marker.id, `state.markers[${index}].id`);
        if (!requestedIds.has(id)) return;
        const snapshot = { ...marker };
        removedMarkers.push({ marker: snapshot, index });
        removedById.set(id, snapshot);
    });

    if (!removedMarkers.length) {
        return { state: value, removedMarkers: [], detachedAreas: [], detachedAreaIds: [] };
    }

    const detachedAreas = [];
    const attackAreas = value.attackAreas.map((area) => {
        const markerId = area.anchor?.type === 'marker' ? String(area.anchor.markerId) : null;
        const marker = markerId ? removedById.get(markerId) : null;
        if (!marker) return area;
        detachedAreas.push({
            id: area.id,
            anchor: { ...area.anchor },
            origin: area.origin ? { ...area.origin } : { x: marker.x, y: marker.y },
        });
        return {
            ...area,
            origin: { x: marker.x, y: marker.y },
            anchor: { type: 'free', markerId: null },
        };
    });

    return {
        state: {
            ...value,
            markers: value.markers.filter(marker => !removedById.has(String(marker.id))),
            attackAreas,
            // Marker cleanup must never alter or synthesize scene-history events.
            sceneEvents: value.sceneEvents,
        },
        removedMarkers,
        detachedAreas,
        detachedAreaIds: detachedAreas.map(area => area.id),
    };
}

export function createInitialState(mapPackage) {
    const { mapId, mapVersion } = getMapMetadata(mapPackage);
    const defaults = mapPackage.defaultPreferences ?? mapPackage.preferences ?? {};
    return {
        saveVersion: SAVE_VERSION,
        mapId,
        mapVersion,
        markers: [],
        characters: [],
        attackAreas: [],
        sceneEvents: [],
        preferences: sanitizeJsonValue(defaults, 'mapPackage.defaultPreferences'),
    };
}

export function migrateSave(raw, mapPackage) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw validationError('save is not valid JSON');
        }
    }
    const originalSave = asObject(parsed, 'save');
    const schemaVersion = Number(originalSave.saveVersion ?? originalSave.schemaVersion ?? 1);
    if (![1, SAVE_VERSION].includes(schemaVersion)) {
        throw validationError(`unsupported save version "${schemaVersion}"`);
    }
    const schemaMigrated = schemaVersion === 1;
    const migratedEvents = schemaMigrated
        ? (originalSave.sceneEvents ?? []).map((event) => {
            if (!isPlainObject(event) || event.type !== 'damage' || event.craterPolygon) return event;
            const groundHit = Array.isArray(event.clipHits)
                ? event.clipHits.find((hit) => hit?.featureId === 'ground-terrain')
                : null;
            return groundHit?.polygon ? { ...event, craterPolygon: groundHit.polygon } : event;
        })
        : originalSave.sceneEvents;
    const save = schemaMigrated
        ? {
            ...originalSave,
            saveVersion: SAVE_VERSION,
            characters: [],
            attackAreas: (originalSave.attackAreas ?? []).map((area) => ({
                ...area,
                craterEnabled: area?.craterEnabled === true,
            })),
            sceneEvents: migratedEvents,
        }
        : originalSave;
    const metadata = getMapMetadata(mapPackage);
    const mapId = asId(save.mapId, 'save.mapId');
    if (mapId !== metadata.mapId) throw validationError('save.mapId does not match the map package');
    const fromVersion = String(save.mapVersion ?? '').trim();
    if (!fromVersion) throw validationError('save.mapVersion is required');
    const schemaWarning = schemaMigrated ? ['存档格式已从 SaveV1 迁移到 SaveV2'] : [];
    if (fromVersion === metadata.mapVersion) {
        return {
            save,
            migrated: schemaMigrated,
            fromVersion,
            toVersion: metadata.mapVersion,
            warnings: schemaWarning,
        };
    }
    if (!getCompatibleMapVersions(mapPackage, metadata.mapVersion).has(fromVersion)) {
        throw validationError('save.mapVersion does not match the map package');
    }
    return {
        save: { ...save, mapVersion: metadata.mapVersion },
        migrated: true,
        fromVersion,
        toVersion: metadata.mapVersion,
        warnings: [...schemaWarning, `地图存档已从 ${fromVersion} 迁移到 ${metadata.mapVersion}`],
    };
}

export function validateAndNormalizeSave(raw, mapPackage) {
    const migration = migrateSave(raw, mapPackage);
    const save = migration.save;
    const version = save.saveVersion ?? save.schemaVersion ?? SAVE_VERSION;
    if (version !== SAVE_VERSION) throw validationError(`unsupported save version "${version}"`);

    const metadata = getMapMetadata(mapPackage);
    const mapId = asId(save.mapId, 'save.mapId');
    const mapVersion = String(save.mapVersion ?? '');
    if (mapId !== metadata.mapId) throw validationError('save.mapId does not match the map package');
    if (mapVersion !== metadata.mapVersion) {
        throw validationError('save.mapVersion does not match the map package');
    }

    assertArrayLimit(save.markers, MAX_MARKERS, 'save.markers');
    assertArrayLimit(save.characters ?? [], MAX_CHARACTERS, 'save.characters');
    assertArrayLimit(save.attackAreas, MAX_ATTACK_AREAS, 'save.attackAreas');
    const markers = save.markers.map(normalizeMarker);
    const knownFeatureIds = getMapFeatureIds(mapPackage);
    const characters = (save.characters ?? []).map((character, index) => normalizeCharacter(
        character,
        index,
        knownFeatureIds,
    ));
    const attackAreas = save.attackAreas.map(normalizeAttackArea);
    assertUnique(markers, 'marker');
    assertUnique(characters, 'character');
    assertUnique(attackAreas, 'attack area');
    validateSaveSpatialBounds(markers, characters, attackAreas, mapPackage);

    const avatarBytes = characters.reduce((total, character) => {
        if (!character.avatarDataUrl) return total;
        const base64 = character.avatarDataUrl.slice(character.avatarDataUrl.indexOf(',') + 1);
        return total + Math.floor(base64.length * 3 / 4) - (base64.match(/=*$/)?.[0].length ?? 0);
    }, 0);
    if (avatarBytes > MAX_AVATAR_TOTAL_BYTES) {
        throw validationError(`character avatars exceed maximum ${MAX_AVATAR_TOTAL_BYTES} bytes`);
    }

    const featureById = new Map(mapFeatures(mapPackage).map((feature) => [String(feature.id), feature]));
    characters.forEach((character, index) => {
        if (character.location.type !== 'building') return;
        const feature = featureById.get(character.location.featureId);
        if (!feature || feature.category !== 'building' || feature.enterable !== true) {
            throw validationError(`characters[${index}] references a non-enterable building`);
        }
    });

    const markerIds = new Set(markers.map((marker) => marker.id));
    const characterIds = new Set(characters.map((character) => character.id));
    for (const area of attackAreas) {
        if (area.anchor.type === 'marker' && !markerIds.has(area.anchor.markerId)) {
            throw validationError(`attack area "${area.id}" references unknown marker "${area.anchor.markerId}"`);
        }
        if (area.anchor.type === 'character' && !characterIds.has(area.anchor.characterId)) {
            throw validationError(`attack area "${area.id}" references unknown character "${area.anchor.characterId}"`);
        }
    }

    const sceneEvents = normalizeSceneEvents(save.sceneEvents, knownFeatureIds);
    return {
        saveVersion: SAVE_VERSION,
        mapId,
        mapVersion,
        markers,
        characters,
        attackAreas,
        sceneEvents,
        preferences: sanitizeJsonValue(save.preferences ?? {}, 'save.preferences'),
    };
}

export function exportSave(state, mapPackage) {
    const value = asObject(state, 'state');
    const { mapId, mapVersion } = getMapMetadata(mapPackage);
    return validateAndNormalizeSave({
        saveVersion: SAVE_VERSION,
        mapId: value.mapId ?? mapId,
        mapVersion: value.mapVersion ?? mapVersion,
        markers: value.markers ?? [],
        characters: value.characters ?? [],
        attackAreas: value.attackAreas ?? [],
        sceneEvents: value.sceneEvents ?? [],
        preferences: value.preferences ?? {},
    }, mapPackage);
}
