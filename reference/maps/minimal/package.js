const WIDTH = 1000;
const HEIGHT = 800;

const features = Object.freeze([
  Object.freeze({
    id: 'demo-house',
    name: '示例木屋',
    category: 'building',
    subtype: 'residence',
    importance: 'primary',
    mode: 'object',
    renderType: 'building',
    layer: 'structures',
    geometry: Object.freeze({ type: 'polygon', points: Object.freeze([[350, 270], [650, 270], [650, 470], [350, 470]]) }),
    center: Object.freeze([500, 370]),
    entrance: Object.freeze([500, 470]),
    enterable: true,
    minCoverage: 0.95,
    ruinStyle: 'timber-earth',
    destructible: Object.freeze({ enabled: true, maxHp: 100, material: 'timber-earth' }),
    capabilities: Object.freeze({
      navigation: Object.freeze({ blocks: true, collisionGroup: 'structure', blockingHeightFt: 15 }),
    }),
    details: Object.freeze({
      use: '用于验证通用建筑交互。',
      structure: '木构与夯土示例。',
      description: '该对象不包含任何兰州城专属逻辑。',
    }),
  }),
  Object.freeze({
    id: 'demo-door',
    name: '示例木门',
    category: 'door',
    subtype: 'door',
    importance: 'primary',
    mode: 'object',
    renderType: 'door',
    layer: 'structures',
    geometry: Object.freeze({ type: 'polygon', points: Object.freeze([[470, 452], [530, 452], [530, 478], [470, 478]]) }),
    center: Object.freeze([500, 465]),
    capabilities: Object.freeze({
      inspectable: true,
      interactive: true,
      openable: true,
      actions: Object.freeze({ inspect: true, open: true, close: true }),
      navigation: Object.freeze({
        blocks: true,
        collisionGroup: 'structure',
        blockingHeightFt: 8,
        passableWhenOpen: true,
        passageTile: 'open',
      }),
    }),
    interaction: Object.freeze({ initialState: Object.freeze({ open: false }) }),
  }),
  Object.freeze({
    id: 'demo-wall',
    name: '示例墙体',
    category: 'wall',
    subtype: 'wall',
    importance: 'secondary',
    mode: 'clip',
    renderType: 'wall',
    layer: 'structures',
    geometry: Object.freeze({ type: 'polygon', points: Object.freeze([[180, 560], [820, 560], [820, 590], [180, 590]]) }),
    center: Object.freeze([500, 575]),
    minCoverage: 0.35,
    ruinStyle: 'stone-earth',
    destructible: Object.freeze({ enabled: true, maxHp: 180, material: 'stone-earth' }),
    capabilities: Object.freeze({
      navigation: Object.freeze({
        blocks: true,
        collisionGroup: 'structure',
        blockingHeightFt: 12,
        passableWhenDestroyed: true,
        damageCreatesPassage: true,
      }),
    }),
  }),
]);

export const MINIMAL_LAYER_PLAN = Object.freeze([
  { id: 'base', role: 'base', sourceLayers: ['base'] },
  { id: 'terrain', role: 'terrain', sourceLayers: ['terrain'] },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'] },
  { id: 'structure', role: 'structure', sourceLayers: ['structure'] },
  { id: 'special', role: 'special', sourceLayers: ['special', 'damage', 'flood'] },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'] },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'] },
]);

export const MINIMAL_FEATURE_TAXONOMY = Object.freeze({
  categories: Object.freeze({
    building: '建筑',
    door: '门',
    wall: '墙体',
  }),
  subtypes: Object.freeze({
    residence: '木屋',
    door: '门',
    wall: '墙体',
  }),
  detailFields: Object.freeze({
    use: '用途',
    structure: '构造',
    description: '说明',
  }),
});

export function createMinimalReferenceSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
    <g id="layer-base" data-layer="base"><rect width="1000" height="800" fill="#eee5cf"/></g>
    <g id="layer-terrain" data-layer="terrain"><path d="M0 520 Q250 440 500 520 T1000 520 V800 H0Z" fill="#cdbb8d"/></g>
    <g id="layer-liquid" data-layer="liquid"><ellipse cx="170" cy="190" rx="110" ry="70" fill="#83aeb8"/></g>
    <g id="layer-structure" data-layer="structure">
      <g id="feature-demo-door" data-feature-id="demo-door" data-category="door"><rect x="470" y="452" width="60" height="26" fill="#6f4a2d" stroke="#3e2a1b" stroke-width="4"/></g>
    </g>
    <g id="layer-special" data-layer="special"></g>
    <g id="layer-destructible" data-layer="destructible">
      <g id="feature-demo-house" data-feature-id="demo-house" data-category="building" class="destructible"><rect x="350" y="270" width="300" height="200" fill="#b88a59" stroke="#5e4631" stroke-width="8"/></g>
      <g id="feature-demo-wall" data-feature-id="demo-wall" data-category="wall" class="destructible"><rect x="180" y="560" width="640" height="30" fill="#82745e"/></g>
    </g>
    <g id="layer-damage" data-layer="damage"></g>
    <g id="layer-flood" data-layer="flood"></g>
    <g id="layer-labels" data-layer="labels"><text x="40" y="70" font-size="36">RPGmap Minimal Reference Map</text></g>
  </svg>`;
}

export function createMinimalReferencePackage() {
  const createSvg = () => createMinimalReferenceSvg();
  return Object.freeze({
    id: 'rpgmap-minimal-reference',
    title: 'RPGmap Minimal Reference Map',
    name: '最小参考地图',
    version: '1.2.0',
    compatibleMapVersions: Object.freeze(['1.0.0']),
    width: WIDTH,
    height: HEIGHT,
    metersPerUnit: 1,
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    initialView: Object.freeze([0, 0, WIDTH, HEIGHT]),
    defaultPreferences: Object.freeze({ snapMeters: 5, gridVisible: true }),
    layers: Object.freeze(['base', 'terrain', 'liquid', 'structure', 'special', 'destructible', 'damage', 'flood', 'labels']),
    layerPlan: MINIMAL_LAYER_PLAN,
    featureTaxonomy: MINIMAL_FEATURE_TAXONOMY,
    features,
    featureCount: features.length,
    destructibleCategories: Object.freeze(['building', 'wall']),
    roadBuffers: Object.freeze([]),
    roadRules: Object.freeze({ widthsMeters: Object.freeze({}), setbacksMeters: Object.freeze({}) }),
    navigation: Object.freeze({ cellSizeMeters: 10, roads: Object.freeze([]), gateways: Object.freeze([]), bridgeFeatureIds: Object.freeze([]) }),
    floodRules: Object.freeze({ maxInflowGapMeters: 0, inletWidthMeters: 0, propagationGapMeters: 0 }),
    liquidBodies: Object.freeze([Object.freeze({ id: 'demo-pond', name: '示例水体', polygon: Object.freeze([[60, 120], [280, 120], [280, 260], [60, 260]]) })]),
    svg: createSvg(),
    createSvg,
    reference: Object.freeze({ kind: 'reference-map', mapFamily: 'minimal', note: 'Core-independence test map.' }),
  });
}

export const minimalReferencePackage = createMinimalReferencePackage();
