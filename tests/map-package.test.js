import test from 'node:test';
import assert from 'node:assert/strict';

import { featureToPolygon, intersectionArea } from '../src/engine/geometry.js';
import {
  commitDamageEvent,
  commitRestoreEvent,
  createDamagePreview,
  createInitialState,
  deriveSceneState,
  undoLastSceneEvent,
} from '../src/engine/state.js';
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  ROAD_RULES,
  createLanzhouMapPackage,
  createLanzhouSvg,
  lanzhouMapPackage,
} from '../src/maps/lanzhou.js';

const EXPECTED_LAYERS = [
  'base',
  'liquid',
  'destructible',
  'damage',
  'flood',
  'labels',
];

const PROTECTED_CATEGORIES = [
  'water',
  'road',
  'roads',
  'ruins',
  'parcel',
  'parcels',
  'label',
  'labels',
];

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function featureElementPattern(featureId) {
  const escapedId = escapeRegExp(featureId);
  return new RegExp(
    `<g\\b[^>]*\\bid=["']feature-${escapedId}["'][^>]*\\bdata-feature-id=["']${escapedId}["'][^>]*>`,
    'i',
  );
}

function roadBuffersFrom(mapPackage) {
  const candidates = [
    mapPackage.roadBuffers,
    mapPackage.roadBufferFeatures,
    mapPackage.scene?.roadBuffers,
    mapPackage.metadata?.roadBuffers,
  ];
  return candidates.find(Array.isArray) || [];
}

test('Lanzhou map package keeps the 6000 x 5000 contract and the layered SVG structure', () => {
  assert.equal(MAP_WIDTH, 6000);
  assert.equal(MAP_HEIGHT, 5000);
  assert.equal(lanzhouMapPackage.width, MAP_WIDTH);
  assert.equal(lanzhouMapPackage.height, MAP_HEIGHT);
  assert.equal(lanzhouMapPackage.viewBox, '0 0 6000 5000');
  assert.deepEqual([...lanzhouMapPackage.layers], EXPECTED_LAYERS);
  assert.deepEqual(ROAD_RULES.widthsMeters, { major: 12, secondary: 7, alley: 3, country: 8 });
  assert.deepEqual(ROAD_RULES.setbacksMeters, { building: 3, streetShop: 1.5 });
  assert.equal(lanzhouMapPackage.roadRules, ROAD_RULES);
  assert.equal(lanzhouMapPackage.version, '1.0.6');
  assert.deepEqual([...lanzhouMapPackage.compatibleMapVersions], ['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4', '1.0.5']);
  assert.equal(lanzhouMapPackage.navigation.roads.length, 10);
  assert.equal(lanzhouMapPackage.navigation.gateways.length, 6);
  assert.deepEqual(lanzhouMapPackage.floodRules, {
    maxInflowGapMeters: 12,
    inletWidthMeters: 6,
    propagationGapMeters: 1,
  });

  const svg = createLanzhouSvg();
  assert.equal(svg, lanzhouMapPackage.svg);
  assert.match(svg, /<svg\b[^>]*\bviewBox="0 0 6000 5000"/i);
  assert.match(svg, /\.road\.major\s*\{\s*stroke-width:\s*12\s*;?\s*\}/i);
  assert.match(svg, /\.road\.lane\s*\{\s*stroke-width:\s*7\s*;?\s*\}/i);
  assert.match(svg, /\.road\.alley\s*\{\s*stroke-width:\s*3\s*;?\s*\}/i);
  for (const layer of EXPECTED_LAYERS) {
    assert.match(
      svg,
      new RegExp(`<g\\b[^>]*\\bid=["']layer-${escapeRegExp(layer)}["'][^>]*\\bdata-layer=["']${escapeRegExp(layer)}["']`, 'i'),
      `missing SVG layer ${layer}`,
    );
  }
});

test('all buildings expose historical details and stable entrances', () => {
  const buildings = lanzhouMapPackage.features.filter((feature) => feature.category === 'building');
  assert.equal(buildings.length, 55);
  assert.equal(buildings.filter((feature) => feature.enterable).length, 54);
  assert.equal(buildings.filter((feature) => Array.isArray(feature.entrance)).length, 54);
  assert.equal(buildings.find((feature) => feature.id === 'yamen-gate').enterable, false);
  for (const building of buildings) {
    assert.ok(building.details.use.length > 8, building.id + ' is missing use details');
    assert.ok(building.details.structure.length > 8, building.id + ' is missing structure details');
    assert.ok(building.details.description.length > 8, building.id + ' is missing reconstruction notes');
  }
});

test('the yamen compound uses five low destructible walls without covering its halls', () => {
  const wallIds = [
    'yamen-wall-north',
    'yamen-wall-west',
    'yamen-wall-east',
    'yamen-wall-southwest',
    'yamen-wall-southeast',
  ];
  const hallIds = [
    'yamen-main-hall',
    'yamen-rear-hall',
    'yamen-office-west',
    'yamen-office-east',
  ];
  const walls = wallIds.map((id) => lanzhouMapPackage.features.find((feature) => feature.id === id));
  const halls = hallIds.map((id) => lanzhouMapPackage.features.find((feature) => feature.id === id));

  assert.ok(walls.every(Boolean));
  assert.ok(halls.every(Boolean));
  for (const wall of walls) {
    assert.equal(wall.category, 'wall');
    assert.equal(wall.subtype, 'yamen-wall');
    assert.equal(wall.mode, 'clip');
    for (const hall of halls) {
      assert.equal(
        intersectionArea(featureToPolygon(wall), featureToPolygon(hall)),
        0,
        `${wall.id} must not overlap ${hall.id}`,
      );
    }
  }

  const svg = lanzhouMapPackage.svg;
  assert.doesNotMatch(svg, /M2470 2370 L3010 2350 L3020 2850 L2455 2870 Z/);
  const courtyardMarkup = svg.match(/<g class="courtyard-walls">[\s\S]*?<\/g>/)?.[0] || '';
  assert.equal((courtyardMarkup.match(/<path /g) || []).length, 2);
  for (const id of wallIds) {
    const wallIndex = svg.indexOf(`id="feature-${id}"`);
    assert.notEqual(wallIndex, -1);
    assert.ok(wallIndex < svg.indexOf('id="feature-yamen-main-hall"'));
  }
});

test('feature IDs are unique and every visible feature owns one SVG group inside the destructible layer', () => {
  const { features, svg } = lanzhouMapPackage;
  assert.ok(features.length > 0);
  assert.equal(lanzhouMapPackage.featureCount, features.length);

  const ids = features.map((feature) => feature.id);
  assert.equal(new Set(ids).size, ids.length, 'feature IDs must be unique');

  const severeOnlyIds = new Set(
    features.filter((feature) => feature.severeOnly === true).map((feature) => feature.id),
  );
  const visibleIds = features
    .filter((feature) => !severeOnlyIds.has(feature.id))
    .map((feature) => feature.id);
  const svgFeatureIds = [...svg.matchAll(/\bdata-feature-id=["']([^"']+)["']/gi)]
    .map((match) => match[1]);
  assert.equal(
    svgFeatureIds.length,
    visibleIds.length,
    'SVG feature group count must match visible metadata',
  );
  assert.equal(new Set(svgFeatureIds).size, svgFeatureIds.length, 'SVG feature IDs must be unique');

  for (const feature of features) {
    assert.equal(typeof feature.id, 'string');
    assert.ok(feature.id.length > 0);
    assert.equal(typeof feature.name, 'string');
    assert.ok(feature.name.length > 0, `${feature.id} must expose a public name`);
    assert.ok(['primary', 'secondary', 'detail'].includes(feature.importance), `${feature.id} must expose map importance`);
    assert.equal(feature.geometry?.type, 'polygon', `${feature.id} must use polygon geometry`);
    assert.ok(feature.geometry.points.length >= 3, `${feature.id} polygon must have at least three points`);
    if (!severeOnlyIds.has(feature.id)) {
      assert.match(svg, featureElementPattern(feature.id), `missing SVG group for ${feature.id}`);
    }
  }

  assert.deepEqual(new Set(svgFeatureIds), new Set(visibleIds));

  const destructibleStart = svg.indexOf('id="layer-destructible"');
  const destructibleEnd = svg.indexOf('id="layer-damage"');
  assert.ok(destructibleStart >= 0 && destructibleEnd > destructibleStart);
  const destructibleSection = svg.slice(destructibleStart, destructibleEnd);
  for (const id of visibleIds) {
    assert.match(
      destructibleSection,
      featureElementPattern(id),
      `visible feature ${id} must live inside #layer-destructible`,
    );
  }
});

test('four city wall towers are independent wall features with their own SVG groups', () => {
  const towers = lanzhouMapPackage.features.filter((feature) => feature.subtype === 'wall-tower');
  const buildings = lanzhouMapPackage.features.filter((feature) => feature.category === 'building');
  assert.equal(towers.length, 4);
  assert.deepEqual(
    towers.map((feature) => feature.id).sort(),
    [
      'city-wall-tower-northeast',
      'city-wall-tower-northwest',
      'city-wall-tower-southeast',
      'city-wall-tower-southwest',
    ],
  );
  for (const tower of towers) {
    assert.equal(tower.category, 'wall');
    assert.equal(tower.mode, 'object');
    assert.match(lanzhouMapPackage.svg, featureElementPattern(tower.id));
    for (const building of buildings) {
      assert.equal(
        intersectionArea(tower.geometry.points, building.geometry.points),
        0,
        `${tower.id} must not overlap ${building.id}`,
      );
    }
  }
});

test('Chenghuang temple is a distinct destructible compound with no duplicate shop', () => {
  const temple = lanzhouMapPackage.features.find(
    (feature) => feature.id === 'chenghuang-temple-compound',
  );

  assert.ok(temple, 'the Chenghuang temple compound must be present');
  assert.equal(temple.category, 'building');
  assert.equal(temple.subtype, 'temple');
  assert.equal(temple.mode, 'object');
  assert.deepEqual([...temple.center], [3080, 2060]);
  assert.equal(temple.minCoverage, 0.95);
  assert.equal(temple.ruinStyle, 'tile-timber-earth-rubble');
  assert.equal(
    lanzhouMapPackage.features.some((feature) => feature.id === 'market-shop-04'),
    false,
    'the low-confidence shop formerly occupying the temple parcel must not remain',
  );

  const { svg } = lanzhouMapPackage;
  assert.match(
    svg,
    /id="feature-chenghuang-temple-compound"[^>]*data-category="building"[^>]*data-subtype="temple"[^>]*class="destructible/i,
  );
  assert.doesNotMatch(svg, /data-confidence=/i);
  assert.doesNotMatch(svg, /data-landmark-visibility=/i);
  assert.match(svg, /aria-label="南向庙门"/i);
  assert.match(svg, /aria-label="正殿"/i);
  assert.match(svg, /aria-label="东西廊房"/i);
  assert.match(svg, /aria-label="后部小房"/i);
  assert.match(
    svg,
    /data-label-for="chenghuang-temple-compound"[^>]*>州城隍神祠〔位置推定〕<\/text>/i,
    'the fixed landmark label must follow the compound destruction state',
  );
});

test('liquid bodies are valid map polygons for flood backfill', () => {
  assert.ok(lanzhouMapPackage.liquidBodies.length > 0, 'at least one liquid body is required');
  for (const body of lanzhouMapPackage.liquidBodies) {
    assert.ok(body.id, 'liquid body requires an id');
    assert.ok(body.polygon.length >= 3, 'liquid body polygon must have at least three points');
    assert.equal(typeof body.polygon[0][0], 'number', 'liquid body points must be numeric');
  }

  const ground = lanzhouMapPackage.features.find((feature) => feature.id === 'ground-terrain');
  assert.ok(ground, 'the severe-only ground feature must be present');
  assert.equal(ground.severeOnly, true);
  assert.equal(ground.mode, 'clip');
});

test('protected map layers cannot be selected as destructible categories', () => {
  const destructible = new Set(lanzhouMapPackage.destructibleCategories);
  const accidentallyDestructible = PROTECTED_CATEGORIES.filter((category) => destructible.has(category));
  assert.deepEqual(accidentallyDestructible, []);
  assert.deepEqual(
    [...destructible].sort(),
    ['bridge', 'building', 'terrain', 'vegetation', 'wall'],
  );
});

test('building polygons have zero positive-area overlap', () => {
  const buildings = lanzhouMapPackage.features.filter((feature) => feature.category === 'building');
  const collisions = [];

  for (let leftIndex = 0; leftIndex < buildings.length; leftIndex += 1) {
    const left = buildings[leftIndex];
    const leftPolygon = featureToPolygon(left);
    for (let rightIndex = leftIndex + 1; rightIndex < buildings.length; rightIndex += 1) {
      const right = buildings[rightIndex];
      const overlap = intersectionArea(leftPolygon, featureToPolygon(right));
      if (overlap > 1e-7) collisions.push({ left: left.id, right: right.id, overlap });
    }
  }

  assert.deepEqual(collisions, []);
});

test('building polygons do not enter declared road buffers', (context) => {
  const roadBuffers = roadBuffersFrom(lanzhouMapPackage);
  if (!roadBuffers.length) {
    context.diagnostic('road buffer metadata is not present; buffer collision branch was not applicable');
    return;
  }

  const permitted = lanzhouMapPackage.features.filter((feature) => feature.roadOverlapAllowed === true);
  assert.deepEqual(permitted.map((feature) => feature.id), ['yamen-gate']);
  assert.ok(permitted.every((feature) => feature.subtype.includes('gate') || feature.id.includes('gate')));
  assert.match(
    lanzhouMapPackage.svg,
    /id="feature-yamen-gate"[\s\S]{0,3000}?class="gate-opening"/i,
    'the licensed cross-street yamen gate must render a visible passage opening',
  );
  const buildings = lanzhouMapPackage.features.filter(
    (feature) => feature.category === 'building' && feature.roadOverlapAllowed !== true,
  );
  const collisions = [];
  for (const building of buildings) {
    const buildingPolygon = featureToPolygon(building);
    for (const roadBuffer of roadBuffers) {
      const overlap = intersectionArea(buildingPolygon, featureToPolygon(roadBuffer));
      if (overlap > 1e-7) {
        collisions.push({
          building: building.id,
          roadBuffer: roadBuffer.id || roadBuffer.name || 'unnamed-road-buffer',
          overlap,
        });
      }
    }
  }

  assert.deepEqual(collisions, []);
});

test('SVG is self-contained vector markup without raster or external references', () => {
  const svg = lanzhouMapPackage.svg;
  assert.doesNotMatch(svg, /<canvas\b/i);
  assert.doesNotMatch(svg, /<image\b/i);
  assert.doesNotMatch(svg, /\.(?:png|jpe?g|webp|gif)(?:[?#"']|\s|$)/i);
  assert.doesNotMatch(svg, /data\s*:\s*image\//i);
  assert.doesNotMatch(svg, /\b(?:href|xlink:href)\s*=\s*["'](?!#)[^"']+["']/i);
});

test('optional generated art stays isolated from the default vector map package', () => {
  const chenghuangTempleUrl = 'data:image/webp;base64,dGVtcGxl';
  const cityGatehouseUrl = 'data:image/webp;base64,Y2l0eWdhdGU=';
  const cityWallTowerUrl = 'data:image/webp;base64,dG93ZXI=';
  const jinchengGatehouseUrl = 'data:image/webp;base64,amluY2hlbmc=';
  const marketOfficeHallUrl = 'data:image/webp;base64,b2ZmaWNl';
  const marketStorehouseUrl = 'data:image/webp;base64,c3RvcmU=';
  const terrainUrl = 'data:image/webp;base64,dGVycmFpbg==';
  const pontoonUrl = 'data:image/webp;base64,cG9udG9vbg==';
  const riverUrl = 'data:image/webp;base64,cml2ZXI=';
  const rubbleUrl = 'data:image/webp;base64,cnViYmxl';
  const yamenHallUrl = 'data:image/webp;base64,eWFtZW4=';
  const buildingSprites = {
    yamenGate: ['building://yamen-gate'],
    yamenSideHall: ['building://yamen-side-hall'],
    barracks: ['building://barracks-01', 'building://barracks-02'],
    granary: ['building://granary-01', 'building://granary-02'],
    stable: ['building://stable-01', 'building://stable-02'],
    workshop: ['building://workshop-01', 'building://workshop-02'],
    marketShop: ['building://market-shop-01', 'building://market-shop-02', 'building://market-shop-03'],
    residenceHouse: ['building://residence-house-01', 'building://residence-house-02', 'building://residence-house-03'],
    residenceCourtyard: ['building://residence-courtyard-01', 'building://residence-courtyard-02'],
  };
  const artPackage = createLanzhouMapPackage({
    chenghuangTempleUrl,
    cityGatehouseUrl,
    cityWallTowerUrl,
    jinchengGatehouseUrl,
    loessTerrainUrl: terrainUrl,
    marketOfficeHallUrl,
    marketStorehouseUrl,
    yamenHallUrl,
    yellowRiverPontoonUrl: pontoonUrl,
    yellowRiverUrl: riverUrl,
    buildingSprites,
    rubbleAtlas: {
      url: rubbleUrl,
      width: 1536,
      height: 1024,
      columns: 3,
      rows: 2,
    },
  });

  assert.doesNotMatch(lanzhouMapPackage.svg, /generated-loess-terrain/i);
  assert.doesNotMatch(lanzhouMapPackage.svg, /<image\b[^>]*generated-landmark-art/i);
  assert.match(artPackage.svg, /id="generated-loess-terrain"/i);
  assert.match(artPackage.svg, new RegExp(escapeRegExp(terrainUrl)));
  assert.match(artPackage.svg, /id="generated-yellow-river"/i);
  assert.match(artPackage.svg, new RegExp(escapeRegExp(riverUrl)));
  assert.equal(artPackage.artAssets.chenghuangTempleUrl, chenghuangTempleUrl);
  assert.equal(artPackage.artAssets.cityGatehouseUrl, cityGatehouseUrl);
  assert.equal(artPackage.artAssets.cityWallTowerUrl, cityWallTowerUrl);
  assert.equal(artPackage.artAssets.jinchengGatehouseUrl, jinchengGatehouseUrl);
  assert.equal(artPackage.artAssets.marketOfficeHallUrl, marketOfficeHallUrl);
  assert.equal(artPackage.artAssets.marketStorehouseUrl, marketStorehouseUrl);
  assert.equal(artPackage.artAssets.yamenHallUrl, yamenHallUrl);
  assert.equal(artPackage.artAssets.yellowRiverPontoonUrl, pontoonUrl);
  assert.ok(Object.isFrozen(artPackage.artAssets.buildingSprites));
  for (const [groupName, urls] of Object.entries(buildingSprites)) {
    assert.deepEqual([...artPackage.artAssets.buildingSprites[groupName]], urls);
    assert.ok(Object.isFrozen(artPackage.artAssets.buildingSprites[groupName]));
  }
  assert.equal(artPackage.artAssets.rubbleAtlas.url, rubbleUrl);
  assert.equal(artPackage.artAssets.rubbleAtlas.columns * artPackage.artAssets.rubbleAtlas.rows, 6);
  assert.equal(artPackage.createSvg(), artPackage.svg);
});

test('generated building sprites cover all 50 ordinary buildings with stable isolated variants', () => {
  const buildingSprites = {
    yamenGate: ['building://yamen-gate'],
    yamenSideHall: ['building://yamen-side-hall'],
    barracks: ['building://barracks-01', 'building://barracks-02'],
    granary: ['building://granary-01', 'building://granary-02'],
    stable: ['building://stable-01', 'building://stable-02'],
    workshop: ['building://workshop-01', 'building://workshop-02'],
    marketShop: ['building://market-shop-01', 'building://market-shop-02', 'building://market-shop-03'],
    residenceHouse: ['building://residence-house-01', 'building://residence-house-02', 'building://residence-house-03'],
    residenceCourtyard: ['building://residence-courtyard-01', 'building://residence-courtyard-02'],
  };
  const artPackage = createLanzhouMapPackage({ buildingSprites });
  const expectedFeatures = artPackage.features.filter((feature) => (
    ['barracks', 'granary', 'stable', 'workshop', 'market', 'residence'].includes(feature.subtype)
    || ['yamen-gate', 'yamen-office-west', 'yamen-office-east'].includes(feature.id)
  ));
  assert.equal(expectedFeatures.length, 50);

  const tags = [...artPackage.svg.matchAll(/<image\b[^>]*\bclass="generated-building-art"[^>]*>/g)]
    .map((match) => match[0]);
  assert.equal(tags.length, 50);
  const assetUrls = new Set(Object.values(buildingSprites).flat());
  const usedUrls = new Set();
  const usedFeatureIds = new Set();

  for (const tag of tags) {
    const featureId = tag.match(/\bdata-building-art-for="([^"]+)"/)?.[1];
    const variant = tag.match(/\bdata-building-art-variant="(\d+)"/)?.[1];
    const url = tag.match(/\bhref="([^"]+)"/)?.[1];
    assert.ok(featureId, `missing building feature ID in ${tag}`);
    assert.match(variant || '', /^\d+$/);
    assert.ok(assetUrls.has(url), `unexpected building sprite URL ${url}`);
    assert.match(tag, /preserveAspectRatio="xMidYMid meet"/);
    assert.doesNotMatch(tag, /preserveAspectRatio="none"/);
    assert.equal(usedFeatureIds.has(featureId), false, `${featureId} received more than one sprite`);
    usedFeatureIds.add(featureId);
    usedUrls.add(url);
  }

  assert.deepEqual(usedFeatureIds, new Set(expectedFeatures.map((feature) => feature.id)));
  assert.deepEqual(usedUrls, assetUrls, 'all 18 building variants must be used');
  assert.equal(usedUrls.size, 18);

  const featureSlice = (id) => {
    const start = artPackage.svg.indexOf(`id="feature-${id}"`);
    assert.notEqual(start, -1, `missing feature group ${id}`);
    const next = artPackage.svg.indexOf('<g id="feature-', start + 1);
    return artPackage.svg.slice(start, next === -1 ? undefined : next);
  };
  for (const feature of expectedFeatures) {
    const slice = featureSlice(feature.id);
    assert.equal((slice.match(/class="generated-building-art"/g) || []).length, 1);
    assert.match(slice, new RegExp(`data-building-art-for="${escapeRegExp(feature.id)}"`));
    assert.match(slice, /class="building-vector building-vector-underlay"/);
    assert.match(slice, /generated-building-feature/);
  }

  assert.equal(artPackage.createSvg(), artPackage.svg, 'variant assignment must remain stable across rerenders');
  assert.equal((artPackage.svg.match(/class="building-vector building-vector-underlay"/g) || []).length, 50);
});

test('all nine generated building prototypes preserve partial, destroyed, restore and undo semantics', () => {
  const prototypeIds = [
    'yamen-gate',
    'yamen-office-west',
    'barracks-01',
    'granary-01',
    'stable-01',
    'workshop-01',
    'market-shop-01',
    'residence-02',
    'residence-01',
  ];

  for (const featureId of prototypeIds) {
    const feature = lanzhouMapPackage.features.find((candidate) => candidate.id === featureId);
    assert.ok(feature, `missing prototype ${featureId}`);
    const [x, y] = feature.center;
    const partialArea = {
      id: `partial-${featureId}`,
      type: 'circle',
      center: { x, y },
      radius: 8,
    };
    const partialPreview = createDamagePreview(partialArea, [feature], ['building']);
    assert.deepEqual(partialPreview.objectIds, [], `${featureId} partial hit must keep the object shell`);
    assert.deepEqual(partialPreview.clipHits.map((hit) => hit.featureId), [featureId]);
    let state = commitDamageEvent(createInitialState(lanzhouMapPackage), partialArea, partialPreview);
    assert.ok(deriveSceneState(state.sceneEvents).damagedFeatureIds.includes(featureId));

    const wholeArea = {
      id: `whole-${featureId}`,
      type: 'circle',
      center: { x, y },
      radius: 1000,
    };
    const wholePreview = createDamagePreview(wholeArea, [feature], ['building']);
    assert.deepEqual(wholePreview.objectIds, [featureId]);
    state = commitDamageEvent(state, wholeArea, wholePreview);
    assert.ok(deriveSceneState(state.sceneEvents).destroyedObjectIds.includes(featureId));

    state = commitRestoreEvent(state, [featureId]);
    assert.equal(deriveSceneState(state.sceneEvents).damagedFeatureIds.includes(featureId), false);
    state = undoLastSceneEvent(state);
    assert.ok(deriveSceneState(state.sceneEvents).destroyedObjectIds.includes(featureId));
  }
});

test('generated landmarks stay inside their independently destructible feature groups', () => {
  const artPackage = createLanzhouMapPackage({
    chenghuangTempleUrl: 'temple.webp',
    cityGatehouseUrl: 'city-gate.webp',
    cityWallTowerUrl: 'tower.webp',
    jinchengGatehouseUrl: 'pass-gate.webp',
    marketOfficeHallUrl: 'market-office.webp',
    marketStorehouseUrl: 'market-storehouse.webp',
    yamenHallUrl: 'yamen.webp',
    yellowRiverPontoonUrl: 'pontoon.webp',
  });
  const featureSlice = (id) => {
    const start = artPackage.svg.indexOf(`id="feature-${id}"`);
    assert.notEqual(start, -1, `missing feature group ${id}`);
    const next = artPackage.svg.indexOf('<g id="feature-', start + 1);
    return artPackage.svg.slice(start, next === -1 ? undefined : next);
  };

  assert.match(featureSlice('yamen-main-hall'), /generated-yamen-hall/);
  assert.match(featureSlice('yamen-rear-hall'), /generated-yamen-hall/);
  assert.doesNotMatch(featureSlice('yamen-gate'), /generated-yamen-hall/);
  assert.match(featureSlice('chenghuang-temple-compound'), /generated-chenghuang-temple/);
  for (const id of ['gate-north', 'gate-east', 'gate-south', 'gate-west']) {
    assert.match(featureSlice(id), /generated-city-gatehouse/);
  }
  assert.match(featureSlice('jincheng-gatehouse'), /generated-jincheng-gatehouse/);
  for (const id of ['city-wall-tower-northwest', 'city-wall-tower-northeast', 'city-wall-tower-southeast', 'city-wall-tower-southwest']) {
    assert.match(featureSlice(id), /generated-city-wall-tower/);
  }
  assert.match(featureSlice('yellow-river-pontoon-bridge'), /generated-yellow-river-pontoon/);
  assert.match(featureSlice('market-office'), /generated-market-office-hall/);
  assert.match(featureSlice('market-storehouse'), /generated-market-storehouse/);
  assert.equal((artPackage.svg.match(/generated-yamen-hall/g) || []).length, 3);
  assert.equal((artPackage.svg.match(/generated-chenghuang-temple/g) || []).length, 2);
  assert.equal((artPackage.svg.match(/generated-city-gatehouse/g) || []).length, 5);
  assert.equal((artPackage.svg.match(/generated-jincheng-gatehouse/g) || []).length, 2);
  assert.equal((artPackage.svg.match(/generated-city-wall-tower/g) || []).length, 5);
  assert.equal((artPackage.svg.match(/generated-yellow-river-pontoon/g) || []).length, 2);
  assert.equal((artPackage.svg.match(/generated-market-office-hall/g) || []).length, 2);
  assert.equal((artPackage.svg.match(/generated-market-storehouse/g) || []).length, 2);
});

test('map presentation metadata supports zoom hierarchy and automatic label avoidance', () => {
  const { svg } = lanzhouMapPackage;
  assert.match(svg, /data-map-importance="primary"/);
  assert.match(svg, /data-map-importance="secondary"/);
  assert.match(svg, /data-map-importance="detail"/);
  assert.match(svg, /data-map-label="true"[^>]*data-label-priority="100"/);
  assert.doesNotMatch(svg, /\bdata-map-label(?:\s|>)/, 'SVG data attributes must have XML values');
  assert.match(svg, /data-min-zoom-tier="overview"/);
  assert.match(svg, /data-min-zoom-tier="mid"/);
  assert.match(svg, /data-min-zoom-tier="detail"/);
  assert.match(svg, /data-max-zoom-tier="mid"/);
  assert.match(svg, /data-label-obstacle="true"/);
  assert.match(svg, /data-label-for="yellow-river-pontoon-bridge"/);
});
