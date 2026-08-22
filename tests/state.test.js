import test from 'node:test';
import assert from 'node:assert/strict';

import {
    commitDamageEvent,
    commitResetSceneEvent,
    commitRestoreEvent,
    createDamagePreview,
    createInitialState,
    damagePreviewSignature,
    deriveFloodPolygons,
    deriveFloodRegions,
    deriveSceneState,
    exportSave,
    migrateSave,
    normalizeAttackArea,
    normalizeMarker,
    normalizeCharacter,
    removeMarkers,
    undoLastSceneEvent,
    validateAndNormalizeSave,
} from '../src/engine/state.js';
import { intersectionArea } from '../src/engine/geometry.js';

const square = (minX, minY, maxX, maxY) => ({
    type: 'Polygon',
    coordinates: [[
        [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY],
    ]],
});

const mapPackage = {
    id: 'lanzhou-v2',
    version: '2.0.0',
    width: 200,
    height: 160,
    features: [
        { id: 'building.yamen', category: 'building', damageMode: 'object', geometry: square(0, 0, 10, 10) },
        { id: 'terrain.hill', category: 'terrain', damageMode: 'clip', geometry: square(5, 0, 20, 15) },
        { id: 'road.main', category: 'road', damageMode: 'object', geometry: square(100, 100, 110, 110) },
    ],
};

const circle = () => ({
    id: 'area-1',
    name: '火球术',
    type: 'circle',
    center: { x: 5, y: 5 },
    radius: 8,
    color: '#c00000',
});

const ring = (minX, minY, maxX, maxY) => [
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
];

test('normalizers canonicalize aliases and reject non-finite geometry', () => {
    assert.deepEqual(normalizeMarker({ id: 7, latlng: { lng: 12, lat: 34 }, name: 'A' }), {
        id: '7',
        name: 'A',
        x: 12,
        y: 34,
        color: '#3498db',
        visible: true,
    });
    const area = normalizeAttackArea({
        id: 'fan-1', type: 'fan', origin: { x: -50, y: 100 }, distance: 60, angle: 90, heading: -90,
    });
    assert.equal(area.shape, 'sector');
    assert.equal(area.range, 60);
    assert.equal(area.angleDeg, 90);
    assert.equal(area.headingDeg, 270);
    assert.deepEqual(area.origin, { x: -50, y: 100 });
    assert.throws(() => normalizeAttackArea({
        id: 'bad', type: 'circle', center: { x: 0, y: 0 }, radius: Number.NaN,
    }), /finite/);
});

test('SaveV2 normalizes characters and migrates SaveV1 with an empty roster', () => {
    const character = normalizeCharacter({
        id: 'hero', name: '韩守忠', color: '#3d9b63',
        location: { type: 'map', x: 40, y: 50 },
    });
    assert.deepEqual(character.location, { type: 'map', x: 40, y: 50 });
    assert.equal(character.avatarDataUrl, null);

    const legacy = {
        saveVersion: 1,
        mapId: mapPackage.id,
        mapVersion: mapPackage.version,
        markers: [],
        attackAreas: [],
        sceneEvents: [],
        preferences: {},
    };
    const migration = migrateSave(legacy, mapPackage);
    assert.equal(migration.migrated, true);
    assert.match(migration.warnings.join(' '), /SaveV1/);
    const normalized = validateAndNormalizeSave(migration.save, mapPackage);
    assert.equal(normalized.saveVersion, 2);
    assert.deepEqual(normalized.characters, []);
});

test('explicit crater damage commits without feature hits and survives replay', () => {
    const area = { ...circle(), craterEnabled: true };
    const preview = createDamagePreview(area, [], []);
    assert.ok(preview.craterPolygon.length > 20);
    const damaged = commitDamageEvent(createInitialState(mapPackage), area, preview);
    assert.equal(damaged.sceneEvents.length, 1);
    assert.ok(damaged.sceneEvents[0].craterPolygon.length > 20);
    assert.equal(deriveSceneState(damaged.sceneEvents).craterRegions.length, 1);
});

test('near-bank craters form an inlet, respect blockers and propagate only through contact', () => {
    const river = { id: 'river', polygon: ring(0, 0, 100, 100) };
    const rules = { maxInflowGapMeters: 12, inletWidthMeters: 6, propagationGapMeters: 1 };
    const scene = {
        destroyedObjectIds: [], clipHits: [],
        craterRegions: [
            { eventId: 'near', polygon: ring(105, 20, 115, 40) },
            { eventId: 'contact', polygon: ring(116, 20, 126, 40) },
        ],
    };
    const regions = deriveFloodRegions(scene, [river], [], rules);
    assert.ok(regions.some((region) => region.kind === 'inlet'));
    assert.ok(regions.some((region) => region.id.includes('crater-near')));
    assert.ok(regions.some((region) => region.id.includes('crater-contact')));

    const farScene = {
        destroyedObjectIds: [], clipHits: [],
        craterRegions: [{ eventId: 'far', polygon: ring(113, 20, 123, 40) }],
    };
    assert.deepEqual(deriveFloodRegions(farScene, [river], [], rules), []);

    const blocker = {
        id: 'bank-building', category: 'building',
        geometry: { type: 'polygon', points: ring(99, 10, 107, 50) },
    };
    const blockedScene = {
        destroyedObjectIds: [], clipHits: [],
        craterRegions: [{ eventId: 'blocked', polygon: ring(108, 20, 118, 40) }],
    };
    assert.deepEqual(deriveFloodRegions(blockedScene, [river], [blocker], rules), []);
});

test('damage preview filters categories and distinguishes object and exact-clip targets', () => {
    const preview = createDamagePreview(circle(), mapPackage.features, ['building', 'terrain']);
    assert.deepEqual(preview.objectIds, ['building.yamen']);
    assert.deepEqual(preview.featureIds, ['building.yamen', 'terrain.hill']);
    assert.equal(preview.clipHits.length, 1);
    assert.equal(preview.clipHits[0].featureId, 'terrain.hill');
    assert.ok(preview.clipHits[0].polygon.length >= 32);

    const buildingOnly = createDamagePreview(circle(), mapPackage.features, ['building']);
    assert.deepEqual(buildingOnly.objectIds, ['building.yamen']);
    assert.deepEqual(buildingOnly.clipHits, []);
});

test('object-like targets localize below 95% coverage and collapse at 95% or more', () => {
    const target = {
        id: 'obj',
        category: 'building',
        mode: 'object',
        geometry: square(0, 0, 100, 100),
        center: { x: 50, y: 50 },
        minCoverage: 0.95,
    };
    const features = [target];
    const partial = createDamagePreview(
        {
            id: 'partial', type: 'rectangle', center: { x: 0, y: 0 },
            length: 50, width: 100, headingDeg: 90,
        },
        features,
        ['building'],
    );
    assert.deepEqual(partial.objectIds, []);
    assert.deepEqual(partial.clipHits.map((hit) => hit.featureId), ['obj']);

    const whole = createDamagePreview(
        {
            id: 'whole', type: 'rectangle', center: { x: 0, y: 0 },
            length: 200, width: 200, headingDeg: 90,
        },
        features,
        ['building'],
    );
    assert.deepEqual(whole.objectIds, ['obj']);
    assert.deepEqual(whole.clipHits, []);
});

test('wall-like and terrain categories always localize even at full coverage', () => {
    const wall = {
        id: 'wall', category: 'wall', mode: 'object',
        geometry: square(0, 0, 100, 100), center: { x: 50, y: 50 },
    };
    const terrain = {
        id: 'terr', category: 'terrain', mode: 'clip',
        geometry: square(0, 0, 100, 100), center: { x: 50, y: 50 },
    };
    const area = {
        id: 'full', type: 'rectangle', center: { x: 0, y: 0 },
        length: 500, width: 500, headingDeg: 90,
    };
    const wallPreview = createDamagePreview(area, [wall], ['wall']);
    assert.deepEqual(wallPreview.objectIds, []);
    assert.deepEqual(wallPreview.clipHits.map((hit) => hit.featureId), ['wall']);

    const terrainPreview = createDamagePreview(area, [terrain], ['terrain']);
    assert.deepEqual(terrainPreview.objectIds, []);
    assert.deepEqual(terrainPreview.clipHits.map((hit) => hit.featureId), ['terr']);
});

test('severeDamage persists and severe-only ground features only enter previews when enabled', () => {
    const severeArea = { ...circle(), severeDamage: true };
    assert.equal(normalizeAttackArea(severeArea).severeDamage, true);
    assert.equal(normalizeAttackArea({ ...circle() }).severeDamage, false);

    const withGround = {
        ...mapPackage,
        features: [
            ...mapPackage.features,
            {
                id: 'ground-terrain', category: 'terrain', mode: 'clip', severeOnly: true,
                geometry: square(-100, -100, 300, 260),
            },
        ],
    };
    const normal = createDamagePreview(circle(), withGround.features, ['terrain']);
    assert.equal(normal.clipHits.some((hit) => hit.featureId === 'ground-terrain'), false);

    const severe = createDamagePreview(severeArea, withGround.features, ['terrain']);
    assert.equal(severe.clipHits.some((hit) => hit.featureId === 'ground-terrain'), true);

    // Severe-only ground is eligible even when the terrain category chip is off.
    const severeWithoutTerrainChip = createDamagePreview(severeArea, withGround.features, ['building']);
    assert.equal(
        severeWithoutTerrainChip.clipHits.some((hit) => hit.featureId === 'ground-terrain'),
        true,
    );
});

test('destruction polygons flood when they overlap a liquid body by more than 1%', () => {
    const river = { id: 'river', polygon: square(0, 0, 100, 100) };
    const wall = {
        id: 'levee', category: 'wall', mode: 'clip',
        geometry: square(0, 95, 100, 105), center: { x: 50, y: 100 },
    };
    const features = [wall];

    // Rectangle straddles the river edge and the levee: ~67% overlap -> floods.
    const overlapping = {
        id: 'breach', type: 'rectangle', center: { x: 0, y: 95 },
        length: 100, width: 30, headingDeg: 90,
    };
    const preview = createDamagePreview(overlapping, features, ['wall']);
    const damaged = commitDamageEvent(createInitialState(mapPackage), overlapping, preview);
    const floods = deriveFloodPolygons(deriveSceneState(damaged.sceneEvents), [river], features);
    assert.equal(floods.length, 1);
    assert.equal(
        intersectionArea(floods[0], river.polygon),
        0,
        'the flood must not paint over the existing liquid body',
    );

    // Same breach geometry, but the attack extends far inland so the water
    // overlap is well below 1% of the destruction range -> no flood.
    const mostlyInland = { ...overlapping, id: 'inland', width: 20000 };
    const inlandPreview = createDamagePreview(mostlyInland, features, ['wall']);
    const inlandDamaged = commitDamageEvent(createInitialState(mapPackage), mostlyInland, inlandPreview);
    assert.deepEqual(
        deriveFloodPolygons(deriveSceneState(inlandDamaged.sceneEvents), [river], features),
        [],
    );

    // Damage far from any liquid never floods.
    const farWall = {
        id: 'far-wall', category: 'wall', mode: 'clip',
        geometry: square(400, 400, 500, 500), center: { x: 450, y: 450 },
    };
    const farPreview = createDamagePreview(overlapping, [farWall], ['wall']);
    const farDamaged = commitDamageEvent(createInitialState(mapPackage), overlapping, farPreview);
    assert.deepEqual(
        deriveFloodPolygons(deriveSceneState(farDamaged.sceneEvents), [river], [farWall]),
        [],
    );

    const restored = commitRestoreEvent(damaged, ['levee']);
    assert.deepEqual(
        deriveFloodPolygons(deriveSceneState(restored.sceneEvents), [river], features),
        [],
    );
});

test('destroyed object footprints flood when they overlap a liquid body', () => {
    const river = { id: 'river', polygon: square(0, 0, 100, 100) };
    const features = [
        {
            id: 'bank-house', category: 'building', mode: 'object',
            geometry: square(0, 90, 20, 120), center: { x: 10, y: 105 },
        },
    ];
    const area = {
        id: 'big', type: 'rectangle', center: { x: 0, y: 0 },
        length: 500, width: 500, headingDeg: 90,
    };
    const preview = createDamagePreview(area, features, ['building']);
    assert.deepEqual(preview.objectIds, ['bank-house']);
    const damaged = commitDamageEvent(createInitialState(mapPackage), area, preview);
    const floods = deriveFloodPolygons(deriveSceneState(damaged.sceneEvents), [river], features);
    assert.equal(floods.length, 1);
    assert.equal(
        intersectionArea(floods[0], river.polygon),
        0,
        'a destroyed footprint flood must exclude the existing liquid body',
    );
});

test('commits are immutable and overlapping damage survives one undo', () => {
    const initial = createInitialState(mapPackage);
    const area = circle();
    const preview = createDamagePreview(area, mapPackage.features, ['building', 'terrain']);
    const once = commitDamageEvent(initial, area, preview);
    const twice = commitDamageEvent(once, area, preview);

    assert.equal(initial.sceneEvents.length, 0);
    assert.equal(once.sceneEvents.length, 1);
    assert.equal(twice.sceneEvents.length, 2);
    assert.ok(Number.isFinite(Date.parse(once.sceneEvents[0].createdAt)));
    assert.deepEqual(deriveSceneState(twice.sceneEvents).destroyedObjectIds, ['building.yamen']);
    assert.equal(deriveSceneState(twice.sceneEvents).clipHits.length, 2);

    const undoneOnce = undoLastSceneEvent(twice);
    assert.equal(undoneOnce.sceneEvents.length, 1);
    assert.equal(undoneOnce.sceneEvents.some(event => event.type === 'undo'), false);
    const scene = deriveSceneState(undoneOnce.sceneEvents);
    assert.deepEqual(scene.destroyedObjectIds, ['building.yamen']);
    assert.equal(scene.clipHits.length, 1);

    const undoneTwice = undoLastSceneEvent(undoneOnce);
    assert.equal(undoneTwice.sceneEvents.length, 0);
    assert.deepEqual(deriveSceneState(undoneTwice.sceneEvents).damagedFeatureIds, []);
    assert.strictEqual(undoLastSceneEvent(undoneTwice), undoneTwice);

    const previewFirst = commitDamageEvent(initial, preview);
    assert.deepEqual(previewFirst.sceneEvents[0].areaSnapshot.origin, { x: 5, y: 5 });
});

test('undo removes only the latest linear record and reset permanently clears all scene history', () => {
    const initial = createInitialState(mapPackage);
    const area = circle();
    const preview = createDamagePreview(area, mapPackage.features, ['building', 'terrain']);
    const damaged = commitDamageEvent(initial, area, preview);

    const restored = commitRestoreEvent(damaged, ['building.yamen']);
    assert.deepEqual(deriveSceneState(restored.sceneEvents).destroyedObjectIds, []);
    assert.deepEqual(deriveSceneState(restored.sceneEvents).damagedFeatureIds, ['terrain.hill']);
    const undoRestore = undoLastSceneEvent(restored);
    assert.equal(undoRestore.sceneEvents.length, 1);
    assert.equal(undoRestore.sceneEvents[0].type, 'damage');
    assert.deepEqual(
        deriveSceneState(undoRestore.sceneEvents).destroyedObjectIds,
        ['building.yamen'],
    );

    const reset = commitResetSceneEvent(restored);
    assert.equal(reset.sceneEvents.length, 0);
    assert.deepEqual(deriveSceneState(reset.sceneEvents).damagedFeatureIds, []);
    const undoReset = undoLastSceneEvent(reset);
    assert.strictEqual(undoReset, reset);
    assert.deepEqual(deriveSceneState(undoReset.sceneEvents).damagedFeatureIds, []);
    assert.strictEqual(commitResetSceneEvent(reset), reset);
});

test('legacy reset and undo logs import safely and export as canonical linear history', () => {
    const initial = createInitialState(mapPackage);
    const allPreview = createDamagePreview(circle(), mapPackage.features, ['building', 'terrain']);
    const buildingPreview = createDamagePreview(circle(), mapPackage.features, ['building']);
    const firstDamage = structuredClone(
        commitDamageEvent(initial, circle(), allPreview).sceneEvents[0],
    );
    const secondDamage = {
        ...structuredClone(commitDamageEvent(initial, circle(), buildingPreview).sceneEvents[0]),
        id: 'scene-legacy-after-reset',
    };

    const legacyWithActiveReset = {
        ...initial,
        sceneEvents: [
            firstDamage,
            { id: 'legacy-reset', type: 'reset', createdAt: new Date().toISOString() },
            secondDamage,
        ],
    };
    assert.deepEqual(
        deriveSceneState(legacyWithActiveReset.sceneEvents).damagedFeatureIds,
        ['building.yamen'],
    );
    const resetImported = validateAndNormalizeSave(legacyWithActiveReset, mapPackage);
    assert.deepEqual(resetImported.sceneEvents.map(event => event.id), ['scene-legacy-after-reset']);
    assert.deepEqual(resetImported.sceneEvents.map(event => event.type), ['damage']);

    const legacyWithUndoneReset = {
        ...initial,
        sceneEvents: [
            firstDamage,
            { id: 'legacy-reset-undone', type: 'reset' },
            { id: 'legacy-undo', type: 'undo', targetEventId: 'legacy-reset-undone' },
        ],
    };
    const undoImported = validateAndNormalizeSave(legacyWithUndoneReset, mapPackage);
    assert.deepEqual(undoImported.sceneEvents.map(event => event.id), [firstDamage.id]);
    assert.deepEqual(
        deriveSceneState(undoImported.sceneEvents).damagedFeatureIds,
        ['building.yamen', 'terrain.hill'],
    );

    const exported = exportSave(legacyWithUndoneReset, mapPackage);
    assert.deepEqual(exported.sceneEvents, undoImported.sceneEvents);
    assert.equal(exported.sceneEvents.some(event => ['reset', 'undo'].includes(event.type)), false);
});

test('committed area snapshot is detached from later area edits and marker bindings', () => {
    const initial = createInitialState(mapPackage);
    const area = {
        ...circle(),
        binding: { markerId: 'caster', offset: { x: 2, y: 3 } },
    };
    const preview = createDamagePreview(area, mapPackage.features, ['building']);
    const damaged = commitDamageEvent(initial, area, preview);
    area.center.x = 999;
    area.radius = 999;
    area.binding.offset.x = 999;

    const snapshot = damaged.sceneEvents[0].areaSnapshot;
    assert.deepEqual(snapshot.origin, { x: 5, y: 5 });
    assert.equal(snapshot.radius, 8);
    assert.deepEqual(snapshot.anchor, { type: 'free', markerId: null });
    assert.ok(Object.isFrozen(snapshot));
});

test('SaveV1 validates references and survives a JSON round trip', () => {
    const area = {
        ...circle(),
        binding: { markerId: 'caster', offset: { x: 0, y: 0 } },
    };
    let state = {
        ...createInitialState(mapPackage),
        markers: [{ id: 'caster', name: '施法者', position: { x: 5, y: 5 }, color: '#00aa00' }],
        attackAreas: [area],
        preferences: { damageCategories: ['building', 'terrain'], opacity: 0.2 },
    };
    state = commitDamageEvent(
        state,
        area,
        createDamagePreview(area, mapPackage.features, ['building', 'terrain']),
    );

    const exported = exportSave(state, mapPackage);
    const imported = validateAndNormalizeSave(JSON.stringify(exported), mapPackage);
    assert.deepEqual(imported, exported);
    assert.deepEqual(deriveSceneState(imported.sceneEvents).damagedFeatureIds, [
        'building.yamen', 'terrain.hill',
    ]);

    assert.throws(() => validateAndNormalizeSave('{not json', mapPackage), /valid JSON/);
    assert.throws(() => validateAndNormalizeSave({
        ...exported,
        attackAreas: [{ ...area, binding: { markerId: 'missing', offset: { x: 0, y: 0 } } }],
    }, mapPackage), /unknown marker/);
    assert.throws(() => validateAndNormalizeSave({
        ...exported,
        sceneEvents: [{
            ...exported.sceneEvents[0], objectIds: ['feature.does-not-exist'], clipHits: [],
        }],
    }, mapPackage), /unknown feature/);
    assert.throws(() => validateAndNormalizeSave({
        ...exported,
        preferences: { opacity: Number.NaN },
    }, mapPackage), /non-finite/);
});

test('compatible map versions migrate to the current version and incompatible versions are rejected', () => {
    const compatiblePackage = {
        ...mapPackage,
        compatibleMapVersions: ['1.0.0'],
    };
    const oldSave = {
        ...createInitialState(compatiblePackage),
        mapVersion: '1.0.0',
    };
    const migration = migrateSave(oldSave, compatiblePackage);

    assert.equal(migration.migrated, true);
    assert.equal(migration.fromVersion, '1.0.0');
    assert.equal(migration.toVersion, '2.0.0');
    assert.equal(migration.save.mapVersion, '2.0.0');
    assert.equal(oldSave.mapVersion, '1.0.0', 'migration must not mutate the original save');
    assert.equal(validateAndNormalizeSave(oldSave, compatiblePackage).mapVersion, '2.0.0');

    assert.throws(() => validateAndNormalizeSave({
        ...oldSave,
        mapVersion: '0.9.0',
    }, compatiblePackage), /mapVersion does not match/);
});

test('damage commits reject previews after geometry or target categories change', () => {
    const area = {
        ...circle(),
        destructionTargets: ['building'],
    };
    const preview = createDamagePreview(area, mapPackage.features, area.destructionTargets);
    assert.equal(preview.signature, damagePreviewSignature(area, ['building']));

    assert.throws(() => commitDamageEvent(
        createInitialState(mapPackage),
        { ...area, radius: area.radius + 1 },
        preview,
    ), /preview is stale/);
    assert.throws(() => commitDamageEvent(
        createInitialState(mapPackage),
        { ...area, destructionTargets: ['terrain'] },
        preview,
    ), /preview is stale/);

    const renamed = commitDamageEvent(
        createInitialState(mapPackage),
        { ...area, name: '只修改名称' },
        preview,
    );
    assert.equal(renamed.sceneEvents.length, 1);
});

test('SaveV1 rejects oversized marker, area, and scene-event collections', () => {
    const base = createInitialState(mapPackage);
    assert.throws(() => validateAndNormalizeSave({
        ...base,
        markers: Array.from({ length: 5001 }, (_, index) => ({
            id: `marker-${index}`,
            name: 'M',
            x: 1,
            y: 1,
            color: '#123456',
        })),
    }, mapPackage), /markers exceeds maximum item count 5000/);

    assert.throws(() => validateAndNormalizeSave({
        ...base,
        attackAreas: Array.from({ length: 1001 }, (_, index) => ({
            ...circle(),
            id: `area-${index}`,
        })),
    }, mapPackage), /attackAreas exceeds maximum item count 1000/);

    assert.throws(() => validateAndNormalizeSave({
        ...base,
        sceneEvents: Array.from({ length: 5001 }, (_, index) => ({
            id: `restore-${index}`,
            type: 'restore',
            featureIds: [],
        })),
    }, mapPackage), /sceneEvents exceeds maximum item count 5000/);
});

test('SaveV1 enforces marker bounds and attack-size limits while allowing off-map AoE origins', () => {
    const base = createInitialState(mapPackage);
    const validOffMapArea = {
        ...circle(),
        center: { x: -400, y: 900 },
        radius: 800,
        range: 800,
        length: 800,
        width: 800,
    };
    const valid = validateAndNormalizeSave({
        ...base,
        markers: [{ id: 'edge', name: '边界点', x: 200, y: 160, color: '#ABCDEF' }],
        attackAreas: [validOffMapArea],
    }, mapPackage);
    assert.deepEqual(valid.attackAreas[0].origin, { x: -400, y: 900 });

    assert.throws(() => validateAndNormalizeSave({
        ...base,
        markers: [{ id: 'negative', name: '非法点', x: -0.01, y: 10, color: '#123456' }],
    }, mapPackage), /outside map bounds/);
    assert.throws(() => validateAndNormalizeSave({
        ...base,
        markers: [{ id: 'too-far', name: '非法点', x: 10, y: 160.01, color: '#123456' }],
    }, mapPackage), /outside map bounds/);
    assert.throws(() => validateAndNormalizeSave({
        ...base,
        attackAreas: [{ ...validOffMapArea, radius: 800.01 }],
    }, mapPackage), /radius exceeds maximum/);
    assert.throws(() => validateAndNormalizeSave({
        ...base,
        attackAreas: [{ ...validOffMapArea, angle: 360, angleDeg: 360 }],
    }, mapPackage), /must not exceed 359/);
});

test('marker removal is atomic, detaches bound areas, and preserves scene history exactly', () => {
    const initial = createInitialState(mapPackage);
    const damaged = commitDamageEvent(
        initial,
        circle(),
        createDamagePreview(circle(), mapPackage.features, ['building']),
    );
    const boundArea = normalizeAttackArea({
        ...circle(),
        id: 'area-bound',
        binding: { markerId: 'm1', offset: { x: 0, y: 0 } },
    });
    const freeArea = normalizeAttackArea({
        ...circle(),
        id: 'area-free',
        center: { x: 100, y: 100 },
    });
    const input = {
        ...damaged,
        markers: [
            normalizeMarker({ id: 'm1', name: 'A', x: 50, y: 60, color: '#123456' }),
            normalizeMarker({ id: 'm2', name: 'B', x: 80, y: 90, color: '#654321' }),
        ],
        attackAreas: [boundArea, freeArea],
    };
    const sceneEventsBefore = structuredClone(input.sceneEvents);
    const result = removeMarkers(input, ['m1', 'missing', 'm1']);

    assert.deepEqual(result.state.markers.map(marker => marker.id), ['m2']);
    assert.deepEqual(result.removedMarkers.map(record => record.marker.id), ['m1']);
    assert.deepEqual(result.detachedAreaIds, ['area-bound']);
    assert.deepEqual(result.state.attackAreas[0].anchor, { type: 'free', markerId: null });
    assert.deepEqual(result.state.attackAreas[0].origin, { x: 50, y: 60 });
    assert.strictEqual(result.state.attackAreas[1], freeArea);
    assert.deepEqual(boundArea.anchor, { type: 'marker', markerId: 'm1' });
    assert.strictEqual(result.state.sceneEvents, input.sceneEvents);
    assert.deepEqual(result.state.sceneEvents, sceneEventsBefore);

    const roundTrip = validateAndNormalizeSave(exportSave(result.state, mapPackage), mapPackage);
    assert.deepEqual(roundTrip.sceneEvents, sceneEventsBefore);
    assert.deepEqual(deriveSceneState(roundTrip.sceneEvents), deriveSceneState(sceneEventsBefore));
});

test('names stay inert plain text, are capped at 80 characters, and colors reject CSS injection', () => {
    const payload = '<img src=x onerror="globalThis.__rpgPwned=true">';
    globalThis.__rpgPwned = false;
    const longPayload = payload + '甲'.repeat(100);
    const imported = validateAndNormalizeSave({
        ...createInitialState(mapPackage),
        markers: [{ id: 'safe-marker', name: longPayload, x: 10, y: 10, color: '#aBcDeF' }],
        attackAreas: [{ ...circle(), name: payload }],
    }, mapPackage);

    assert.equal(imported.markers[0].name, longPayload.slice(0, 80));
    assert.equal(imported.attackAreas[0].name, payload);
    assert.equal(globalThis.__rpgPwned, false);
    assert.equal(imported.markers[0].color, '#aBcDeF');

    assert.throws(() => validateAndNormalizeSave({
        ...createInitialState(mapPackage),
        markers: [{
            id: 'unsafe-color', name: '恶意颜色', x: 10, y: 10,
            color: '#fff;background:url(javascript:alert(1))',
        }],
    }, mapPackage), /safe six-digit hex color/);
    assert.throws(() => validateAndNormalizeSave({
        ...createInitialState(mapPackage),
        attackAreas: [{ ...circle(), color: 'red' }],
    }, mapPackage), /safe six-digit hex color/);

    delete globalThis.__rpgPwned;
});
