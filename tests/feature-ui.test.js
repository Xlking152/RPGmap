import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareMapPackage } from '../src/map-package/contract.js';
import {
  featureCategoryLabel,
  featureDetailRows,
  featureEntranceText,
  featureSubtypeLabel,
} from '../src/interaction/ui-model.js';
import { LANZHOU_FEATURE_TAXONOMY, LANZHOU_LAYER_PLAN } from '../reference/maps/lanzhou/manifest.js';
import { createLanzhouSvg } from '../reference/maps/lanzhou/package.js';
import { MINIMAL_FEATURE_TAXONOMY, createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

function preparedGenericUiMap() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g data-layer="base"></g></svg>';
  return prepareMapPackage({
    id: 'generic-feature-ui', version: '1.0.0', width: 100, height: 100, layers: ['base'], svg,
    featureTaxonomy: {
      categories: { mechanism: '机关' },
      subtypes: { portal: '传送门' },
      detailFields: { purpose: '用途', code: '编号' },
    },
    features: [{
      id: 'portal-a', name: 'Portal A', category: 'mechanism', subtype: 'portal',
      geometry: { type: 'polygon', points: [[40, 20], [60, 20], [60, 80], [40, 80]] },
      center: [50, 50], entrance: [50, 80], details: { purpose: '跨区域移动', code: 7 },
      capabilities: { inspectable: true, enterable: true },
    }],
  }, { source: 'test:generic-feature-ui' });
}

test('MapPackage normalizes map-owned Feature taxonomy for generic UI labels', () => {
  const mapPackage = preparedGenericUiMap();
  const feature = mapPackage.features[0];
  assert.equal(featureCategoryLabel(mapPackage, feature), '机关');
  assert.equal(featureSubtypeLabel(mapPackage, feature), '传送门');
  assert.equal(featureCategoryLabel(mapPackage, 'unknown-category'), 'unknown-category');
  assert.equal(Object.isFrozen(mapPackage.featureTaxonomy), true);
  assert.equal(Object.isFrozen(mapPackage.featureTaxonomy.categories), true);
});

test('generic Feature UI model renders details and entrance without category rules', () => {
  const mapPackage = preparedGenericUiMap();
  const feature = mapPackage.features[0];
  assert.deepEqual(featureDetailRows(mapPackage, feature), [
    { key: 'purpose', label: '用途', value: '跨区域移动' },
    { key: 'code', label: '编号', value: '7' },
  ]);
  assert.equal(featureEntranceText(feature), 'x 50.0 · y 80.0');
});

test('Feature UI model no longer exports Character location helpers', async () => {
  const uiModel = await import('../src/interaction/ui-model.js');
  assert.equal(uiModel.characterFeatureId, undefined);
  assert.equal(uiModel.charactersInsideFeature, undefined);
  assert.equal(uiModel.featureLocationLabel, undefined);
});

test('reference maps declare taxonomy instead of relying on Core category labels', () => {
  const minimal = prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal-ui' });
  assert.deepEqual(minimal.featureTaxonomy, MINIMAL_FEATURE_TAXONOMY);
  assert.equal(featureCategoryLabel(minimal, 'door'), '门');
  assert.equal(LANZHOU_FEATURE_TAXONOMY.subtypes.yamen, '州衙');
  assert.equal(LANZHOU_FEATURE_TAXONOMY.categories.wall, '城墙');
});

test('Lanzhou Layer Plan points to real tagged physical SVG layers', () => {
  const svg = createLanzhouSvg();
  const terrain = LANZHOU_LAYER_PLAN.find((layer) => layer.id === 'terrain');
  assert.deepEqual([...terrain.sourceLayers], ['terrain', 'ruins', 'roads', 'parcels', 'vegetation']);
  const physicalLayers = new Set([...svg.matchAll(/\bdata-layer=["']([^"']+)["']/g)].map((match) => match[1]));
  for (const layer of LANZHOU_LAYER_PLAN) {
    for (const sourceLayer of layer.sourceLayers) assert.ok(physicalLayers.has(sourceLayer), `${layer.id} references missing physical layer ${sourceLayer}`);
  }
});
