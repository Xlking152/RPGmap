import { BUILT_IN_LANZHOU_MAP } from '../../../src/map-package/constants.js';

export const MAP_WIDTH = 6000;
export const MAP_HEIGHT = 5000;
export const ROAD_RULES = Object.freeze({
  widthsMeters: Object.freeze({ major: 12, secondary: 7, alley: 3, country: 8 }),
  setbacksMeters: Object.freeze({ building: 3, streetShop: 1.5 }),
});

const round = (value) => Math.round(value * 100) / 100;

function rotatedRectangle(cx, cy, width, height, angle = 0) {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = width / 2;
  const halfHeight = height / 2;

  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => [
    round(cx + x * cos - y * sin),
    round(cy + x * sin + y * cos),
  ]);
}

function polygonCenter(points) {
  const sum = points.reduce(
    (accumulator, [x, y]) => [accumulator[0] + x, accumulator[1] + y],
    [0, 0],
  );
  return [round(sum[0] / points.length), round(sum[1] / points.length)];
}

function cubicPoint([p0, p1, p2, p3], t) {
  const inverse = 1 - t;
  const x = inverse ** 3 * p0[0]
    + 3 * inverse ** 2 * t * p1[0]
    + 3 * inverse * t ** 2 * p2[0]
    + t ** 3 * p3[0];
  const y = inverse ** 3 * p0[1]
    + 3 * inverse ** 2 * t * p1[1]
    + 3 * inverse * t ** 2 * p2[1]
    + t ** 3 * p3[1];
  return [x, y];
}

const roadCenterlines = [
  { id: 'north-approach', kind: 'major', bufferWidth: 18, curves: [
    [[3538, 1332], [3498, 1430], [3445, 1480], [3364, 1546]],
  ] },
  { id: 'west-country-road', kind: 'country', bufferWidth: 14, curves: [
    [[2085, 2338], [1660, 2385], [1180, 2495], [650, 2670]],
    [[650, 2670], [390, 2755], [160, 2820], [-80, 2860]],
  ] },
  { id: 'east-country-road', kind: 'country', bufferWidth: 14, curves: [
    [[3915, 2152], [4320, 2115], [4720, 1990], [5120, 1835]],
    [[5120, 1835], [5460, 1700], [5730, 1655], [6060, 1670]],
  ] },
  { id: 'south-country-road', kind: 'country', bufferWidth: 14, curves: [
    [[3128, 2944], [3050, 3210], [3010, 3500], [3110, 3760]],
    [[3110, 3760], [3210, 4015], [3440, 4250], [3650, 4520]],
  ] },
  { id: 'north-south-main-street', kind: 'major', bufferWidth: 18, curves: [
    [[3364, 1546], [3390, 1740], [3350, 1960], [3268, 2195]],
    [[3268, 2195], [3190, 2420], [3110, 2695], [3128, 2944]],
  ] },
  { id: 'east-west-main-street', kind: 'major', bufferWidth: 18, curves: [
    [[2085, 2338], [2470, 2270], [2860, 2285], [3268, 2195]],
    [[3268, 2195], [3520, 2140], [3690, 2210], [3915, 2152]],
  ] },
  { id: 'west-secondary-street', kind: 'secondary', bufferWidth: 13, curves: [
    [[2130, 2400], [2400, 2380], [2700, 2320], [3020, 2300]],
    [[3020, 2300], [3120, 2290], [3190, 2240], [3268, 2195]],
  ] },
  { id: 'yamen-lane', kind: 'secondary', bufferWidth: 13, curves: [
    [[2774, 2782], [2900, 2800], [3025, 2875], [3128, 2944]],
  ] },
  { id: 'east-north-alley', kind: 'alley', bufferWidth: 9, curves: [
    [[3300, 2300], [3500, 2320], [3650, 2240], [3950, 2220]],
  ] },
  { id: 'east-south-alley', kind: 'alley', bufferWidth: 9, curves: [
    [[3300, 2540], [3500, 2560], [3700, 2625], [3980, 2680]],
  ] },
];

export const navigationRoads = Object.freeze(roadCenterlines.map((road) => Object.freeze({
  id: road.id,
  kind: road.kind,
  bufferWidth: road.bufferWidth,
  curves: Object.freeze(road.curves.map((curve) => Object.freeze(
    curve.map((point) => Object.freeze([...point])),
  ))),
})));

function createRoadBufferFeatures() {
  const buffers = [];
  const samplesPerCurve = 8;
  roadCenterlines.forEach((road) => {
    const points = [];
    road.curves.forEach((curve, curveIndex) => {
      for (let sample = curveIndex === 0 ? 0 : 1; sample <= samplesPerCurve; sample += 1) {
        points.push(cubicPoint(curve, sample / samplesPerCurve));
      }
    });
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx) * 180 / Math.PI;
      buffers.push(Object.freeze({
        id: `road-buffer-${road.id}-${String(index).padStart(2, '0')}`,
        name: road.id,
        category: 'road-buffer',
        geometry: Object.freeze({
          type: 'polygon',
          points: Object.freeze(rotatedRectangle(
            (start[0] + end[0]) / 2,
            (start[1] + end[1]) / 2,
            length + road.bufferWidth,
            road.bufferWidth,
            angle,
          ).map((point) => Object.freeze(point))),
        }),
      }));
    }
  });
  return Object.freeze(buffers);
}

export const roadBufferFeatures = createRoadBufferFeatures();

function rectangleFeature(
  id,
  category,
  cx,
  cy,
  width,
  height,
  angle,
  renderType,
  options = {},
) {
  return {
    id,
    category,
    mode: options.mode || 'object',
    geometry: { type: 'polygon', points: rotatedRectangle(cx, cy, width, height, angle) },
    center: [cx, cy],
    minCoverage: options.minCoverage ?? 0.95,
    ruinStyle: options.ruinStyle || 'timber-earth',
    layer: options.layer || 'buildings',
    name: options.name || id,
    renderType,
    cx,
    cy,
    width,
    height,
    angle,
    accent: options.accent,
    roadOverlapAllowed: options.roadOverlapAllowed === true,
    severeOnly: options.severeOnly === true,
  };
}

function polygonFeature(id, category, points, renderType, options = {}) {
  return {
    id,
    category,
    mode: options.mode || 'clip',
    geometry: { type: 'polygon', points },
    center: options.center || polygonCenter(points),
    minCoverage: options.minCoverage ?? 0.35,
    ruinStyle: options.ruinStyle || 'rammed-earth',
    layer: options.layer || 'walls-roads',
    name: options.name || id,
    renderType,
    accent: options.accent,
    severeOnly: options.severeOnly === true,
  };
}

const cityWallFeatures = [
  polygonFeature('city-wall-northwest', 'wall', [[2020, 1570], [2775, 1540], [2780, 1602], [2035, 1632]], 'wall', { name: '北城墙西段' }),
  polygonFeature('city-wall-north-mid', 'wall', [[2775, 1540], [3312, 1517], [3321, 1579], [2780, 1602]], 'wall', { name: '北城墙中段' }),
  polygonFeature('city-wall-northeast', 'wall', [[3416, 1513], [3835, 1495], [3850, 1558], [3407, 1575]], 'wall', { name: '北城墙东段' }),
  polygonFeature('city-wall-east-upper', 'wall', [[3835, 1495], [3941, 2072], [3877, 2083], [3775, 1558]], 'wall', { name: '东城墙北段' }),
  polygonFeature('city-wall-east-lower', 'wall', [[3951, 2231], [4070, 2870], [4005, 2878], [3887, 2241]], 'wall', { name: '东城墙南段' }),
  polygonFeature('city-wall-southeast', 'wall', [[4070, 2870], [3208, 2960], [3199, 2896], [4005, 2808]], 'wall', { name: '南城墙东段' }),
  polygonFeature('city-wall-southwest', 'wall', [[3050, 2975], [2140, 3060], [2136, 2995], [3055, 2909]], 'wall', { name: '南城墙西段' }),
  polygonFeature('city-wall-west-lower', 'wall', [[2140, 3060], [2055, 2423], [2120, 2412], [2202, 2995]], 'wall', { name: '西城墙南段' }),
  polygonFeature('city-wall-west-upper', 'wall', [[2047, 2257], [1985, 1580], [2050, 1570], [2111, 2247]], 'wall', { name: '西城墙北段' }),
];

const cityWallTowerFeatures = [
  rectangleFeature('city-wall-tower-northwest', 'wall-tower', 2018, 1582, 112, 112, 0, 'wall-tower', { layer: 'walls-roads', ruinStyle: 'stone-earth-timber', name: '西北角楼（推定）' }),
  rectangleFeature('city-wall-tower-northeast', 'wall-tower', 3836, 1528, 112, 112, 0, 'wall-tower', { layer: 'walls-roads', ruinStyle: 'stone-earth-timber', name: '东北角楼（推定）' }),
  rectangleFeature('city-wall-tower-southeast', 'wall-tower', 4040, 2868, 112, 112, 0, 'wall-tower', { layer: 'walls-roads', ruinStyle: 'stone-earth-timber', name: '东南角楼（推定）' }),
  rectangleFeature('city-wall-tower-southwest', 'wall-tower', 2140, 3030, 112, 112, 0, 'wall-tower', { layer: 'walls-roads', ruinStyle: 'stone-earth-timber', name: '西南角楼（推定）' }),
];

const gateFeatures = [
  rectangleFeature('gate-north', 'gate', 3364, 1546, 112, 104, -2, 'gate', { layer: 'walls-roads', ruinStyle: 'rammed-earth-timber', name: '北门（推定）' }),
  rectangleFeature('gate-east', 'gate', 3914, 2152, 116, 102, 80, 'gate', { layer: 'walls-roads', ruinStyle: 'rammed-earth-timber', name: '东门（推定）' }),
  rectangleFeature('gate-south', 'gate', 3128, 2944, 116, 106, -6, 'gate', { layer: 'walls-roads', ruinStyle: 'rammed-earth-timber', name: '南门（推定）' }),
  rectangleFeature('gate-west', 'gate', 2086, 2338, 110, 100, 84, 'gate', { layer: 'walls-roads', ruinStyle: 'rammed-earth-timber', name: '西门（推定）' }),
];

const passFeatures = [
  polygonFeature('jincheng-wall-west', 'pass-wall', [[2682, 536], [2794, 601], [2857, 854], [2786, 907], [2698, 691]], 'pass-wall', { name: '金城关西垣', ruinStyle: 'stone-earth' }),
  polygonFeature('jincheng-wall-east', 'pass-wall', [[3092, 588], [3219, 681], [3170, 926], [3091, 895], [3126, 717]], 'pass-wall', { name: '金城关东垣', ruinStyle: 'stone-earth' }),
  polygonFeature('jincheng-wall-south', 'pass-wall', [[2786, 907], [3091, 895], [3075, 958], [2810, 967]], 'pass-wall', { name: '金城关南垣', ruinStyle: 'stone-earth' }),
  rectangleFeature('jincheng-gatehouse', 'pass-gate', 2970, 714, 166, 112, 10, 'pass-gate', { layer: 'walls-roads', ruinStyle: 'stone-earth-timber', name: '金城关关楼' }),
];

const bridgeFeature = polygonFeature(
  'yellow-river-pontoon-bridge',
  'bridge',
  [[3407, 818], [3510, 829], [3608, 1328], [3494, 1353]],
  'bridge',
  {
    center: [3508, 1086],
    minCoverage: 0.28,
    ruinStyle: 'timber-rope-river',
    name: '黄河浮桥（线位推测）',
  },
);

const terrainFeatures = [
  polygonFeature('field-west-river', 'terrain', [[180, 1760], [1090, 1630], [1360, 2190], [470, 2410]], 'field', { layer: 'terrain', mode: 'clip', name: '西侧河谷耕地', ruinStyle: 'scorched-ground', minCoverage: 0.16 }),
  polygonFeature('field-east-river', 'terrain', [[4300, 1500], [5480, 1380], [5750, 1910], [4490, 2050]], 'field', { layer: 'terrain', mode: 'clip', name: '东侧河谷耕地', ruinStyle: 'scorched-ground', minCoverage: 0.16 }),
  polygonFeature('field-west-south', 'terrain', [[560, 2940], [1630, 2700], [1860, 3320], [790, 3500]], 'field', { layer: 'terrain', mode: 'clip', name: '西南坡麓耕地', ruinStyle: 'scorched-ground', minCoverage: 0.16 }),
  polygonFeature('field-east-south', 'terrain', [[4310, 2870], [5480, 2720], [5630, 3320], [4480, 3410]], 'field', { layer: 'terrain', mode: 'clip', name: '东南坡麓耕地', ruinStyle: 'scorched-ground', minCoverage: 0.16 }),
];

const yamenFeatures = [
  rectangleFeature('yamen-gate', 'yamen', 2774, 2782, 128, 52, -4, 'gate-building', { name: '州衙仪门', roadOverlapAllowed: true }),
  rectangleFeature('yamen-main-hall', 'yamen', 2765, 2608, 212, 82, -4, 'hall', { name: '州衙正堂', ruinStyle: 'tile-timber-earth' }),
  rectangleFeature('yamen-rear-hall', 'yamen', 2744, 2449, 176, 72, -4, 'hall', { name: '州衙后堂', ruinStyle: 'tile-timber-earth' }),
  rectangleFeature('yamen-office-west', 'yamen', 2533, 2610, 166, 56, 86, 'side-hall', { name: '州衙西廊房' }),
  rectangleFeature('yamen-office-east', 'yamen', 2981, 2602, 162, 56, 86, 'side-hall', { name: '州衙东廊房' }),
];

const barracksFeatures = [
  [2275, 1772, 220, 62, 5], [2535, 1748, 226, 64, 3], [2794, 1716, 214, 62, -2],
  [2264, 1902, 218, 62, 4], [2522, 1888, 230, 64, 1], [2784, 1865, 214, 62, -3],
].map(([cx, cy, width, height, angle], index) => rectangleFeature(
  `barracks-${String(index + 1).padStart(2, '0')}`,
  'barracks', cx, cy, width, height, angle, 'long-building',
  { name: `军营营房 ${index + 1}`, ruinStyle: 'timber-earth' },
));

const granaryFeatures = [
  [3655, 1648, 172, 60, -2], [3820, 1680, 148, 58, 4], [3658, 1780, 178, 60, 1],
  [3826, 1824, 144, 58, 6], [3666, 1917, 170, 60, -1], [3822, 1940, 104, 54, 5],
].map(([cx, cy, width, height, angle], index) => rectangleFeature(
  `granary-${String(index + 1).padStart(2, '0')}`,
  'granary', cx, cy, width, height, angle, 'granary',
  { name: `仓廪 ${index + 1}`, ruinStyle: 'raised-timber-earth' },
));

const stableFeatures = [
  [2305, 2083, 238, 74, 2], [2590, 2057, 244, 76, -3], [2866, 1986, 226, 72, -5],
].map(([cx, cy, width, height, angle], index) => rectangleFeature(
  `stable-${String(index + 1).padStart(2, '0')}`,
  'stable', cx, cy, width, height, angle, 'stable',
  { name: `马厩 ${index + 1}`, ruinStyle: 'timber-thatch' },
));

const workshopFeatures = [
  [2258, 2515, 172, 72, 8], [2460, 2488, 184, 70, -4], [2268, 2682, 160, 70, 6],
  [2380, 2800, 178, 72, 2], [2625, 2825, 156, 66, -7],
].map(([cx, cy, width, height, angle], index) => rectangleFeature(
  `workshop-${String(index + 1).padStart(2, '0')}`,
  'workshop', cx, cy, width, height, angle, 'workshop',
  { name: `军需修造场 ${index + 1}`, ruinStyle: 'timber-earth-debris' },
));

const marketFeatures = [
  rectangleFeature('market-office', 'market-office', 3608, 2010, 148, 54, 4, 'hall', { name: '市易务（位置推测）', ruinStyle: 'tile-timber-earth' }),
  rectangleFeature('market-storehouse', 'market-office', 3810, 2040, 124, 50, 7, 'granary', { name: '市易务货栈（推测）', ruinStyle: 'timber-earth' }),
  [3168, 1652, 118, 58, -5, '#ad6549'], [3192, 1774, 112, 56, -3, '#54776c'],
  [3156, 1905, 122, 58, -5, '#947a43'], [3110, 2042, 116, 56, -7, '#855b72'],
  [3515, 1644, 84, 52, 2, '#b46a4b'], [3512, 1778, 86, 52, 1, '#557b63'],
  [3510, 1904, 86, 52, -1, '#9a7744'], [3455, 2040, 82, 52, -4, '#6d698a'],
  [2675, 2160, 118, 54, 3, '#a75c46'], [2940, 2100, 108, 52, -2, '#4e786d'],
].map((definition, index) => {
  if (!Array.isArray(definition)) return definition;
  const [cx, cy, width, height, angle, accent] = definition;
  return rectangleFeature(
    `market-shop-${String(index - 1).padStart(2, '0')}`,
    'market', cx, cy, width, height, angle, 'shop',
    { name: `沿街店铺 ${index - 1}`, ruinStyle: 'timber-earth', accent },
  );
}).filter((feature) => feature.id !== 'market-shop-04');

const templeFeatures = [
  rectangleFeature(
    'chenghuang-temple-compound',
    'temple',
    3080,
    2060,
    144,
    188,
    -4,
    'temple-compound',
    {
      name: '州城隍神祠〔位置推定〕',
      ruinStyle: 'tile-timber-earth-rubble',
    },
  ),
];

const residenceFeatures = [
  [2130, 2190, 132, 66, 8], [2200, 2795, 126, 68, 9], [2355, 2888, 148, 70, -6],
  [2552, 2940, 136, 66, 4], [3010, 1638, 138, 68, -4], [2155, 1690, 126, 64, 7],
  [3430, 2860, 132, 66, 5], [3740, 2358, 146, 70, 8], [3902, 2396, 126, 66, 12],
  [3498, 2468, 140, 70, -8], [3700, 2528, 136, 66, 3], [3903, 2595, 128, 66, 10],
  [3398, 2640, 142, 70, -10], [3618, 2722, 138, 66, -3], [3840, 2790, 126, 64, 8],
  [3320, 2770, 122, 64, -8], [3400, 2400, 116, 62, 5], [2168, 1968, 126, 66, 6],
].map(([cx, cy, width, height, angle], index) => rectangleFeature(
  `residence-${String(index + 1).padStart(2, '0')}`,
  'residence', cx, cy, width, height, angle,
  index % 4 === 0 ? 'courtyard-house' : 'house',
  { name: `民居 ${index + 1}`, ruinStyle: index % 3 === 0 ? 'timber-thatch-earth' : 'timber-earth' },
));

const vegetationFeatures = [
  [2180, 1700, 22], [2400, 1635, 18], [3000, 1575, 17], [3730, 1555, 16],
  [2140, 2470, 20], [2410, 2790, 17], [2870, 2870, 19], [3300, 2860, 18],
  [3520, 2210, 16], [3770, 2250, 18], [3430, 2520, 21], [3810, 2660, 17],
  [2610, 2350, 19], [2870, 2310, 15], [3040, 2400, 16], [2290, 2220, 14],
].map(([cx, cy, radius], index) => rectangleFeature(
  `tree-${String(index + 1).padStart(2, '0')}`,
  'vegetation', cx, cy, radius * 2, radius * 2, 0, 'tree',
  { layer: 'vegetation', name: `城内树木 ${index + 1}`, ruinStyle: 'felled-tree', accent: index % 3 },
));

const groundFeature = polygonFeature(
  'ground-terrain',
  'terrain',
  [[0, 0], [MAP_WIDTH, 0], [MAP_WIDTH, MAP_HEIGHT], [0, MAP_HEIGHT]],
  'field',
  {
    layer: 'terrain',
    mode: 'clip',
    severeOnly: true,
    name: '基础地表',
    minCoverage: 0,
  },
);

const featureDefinitions = Object.freeze([
  ...terrainFeatures,
  ...cityWallFeatures,
  ...cityWallTowerFeatures,
  ...gateFeatures,
  ...passFeatures,
  bridgeFeature,
  ...yamenFeatures,
  ...barracksFeatures,
  ...granaryFeatures,
  ...stableFeatures,
  ...workshopFeatures,
  ...marketFeatures,
  ...templeFeatures,
  ...residenceFeatures,
  ...vegetationFeatures,
  groundFeature,
]);

function canonicalCategory(feature) {
  if (feature.category === 'bridge') return 'bridge';
  if (feature.category === 'vegetation') return 'vegetation';
  if (feature.category === 'terrain') return 'terrain';
  if (['wall', 'wall-tower', 'gate', 'pass-wall', 'pass-gate'].includes(feature.category)) return 'wall';
  return 'building';
}

const PRIMARY_FEATURE_IDS = new Set([
  'yellow-river-pontoon-bridge',
  'jincheng-gatehouse',
  'chenghuang-temple-compound',
  'yamen-main-hall',
  'yamen-rear-hall',
  'market-office',
]);

function featureImportance(feature) {
  const isGateOrTower = ['gate', 'pass-gate', 'wall-tower'].includes(feature.category);
  if (PRIMARY_FEATURE_IDS.has(feature.id) || isGateOrTower) return 'primary';
  if (['residence', 'vegetation', 'terrain'].includes(feature.category)) return 'detail';
  return 'secondary';
}

const BUILDING_DETAIL_TEMPLATES = Object.freeze({
  yamen: Object.freeze({
    use: '州级官署，承担行政、司法、文书与接待事务。',
    structure: '夯土台基、木构梁架与灰绿色瓦顶，院落沿中轴组织。',
    description: '功能与相对层级依据北宋州治制度复原，具体位置与尺度为游戏化推定。',
  }),
  barracks: Object.freeze({
    use: '驻军日常住宿、点名与军械整理。',
    structure: '长条形夯土墙木构营房，开间重复，屋顶低缓。',
    description: '属于城内军营建筑群，单栋编号用于主持人精确管理。',
  }),
  granary: Object.freeze({
    use: '储存军粮、官粮与应急物资。',
    structure: '抬高基础、厚夯土墙和封闭式瓦顶，以利防潮防火。',
    description: '仓廪数量和布置为基于城防后勤需求的合理推定。',
  }),
  stable: Object.freeze({
    use: '拴养军马并存放鞍具、草料。',
    structure: '木柱屋棚、夯土地面与分隔栏，通风开敞。',
    description: '靠近军营布置，便于骑兵和传令人员快速取马。',
  }),
  workshop: Object.freeze({
    use: '修理兵器、车辆、皮具及常用军需器材。',
    structure: '夯土木构工坊，内部设工作台、炉台与材料区。',
    description: '工坊职能为综合军需修造，不对应单一史料记载作坊。',
  }),
  'market-office': Object.freeze({
    use: '管理市场交易、税契、货物登记与官营仓储。',
    structure: '较规整的官式木构厅房或封闭货栈，使用瓦顶。',
    description: '市易务位置与附属货栈均为依据城市道路关系作出的推定。',
  }),
  market: Object.freeze({
    use: '沿街售卖日用货物、饮食与小型手工业制品。',
    structure: '低矮木构店面、浅檐与可收放布棚，入口面向街道。',
    description: '店铺不对应具体字号，编号用于场景叙事和破坏记录。',
  }),
  temple: Object.freeze({
    use: '州城城隍祭祀、地方守护信仰与公共仪式。',
    structure: '围墙内布置门、庭院和正殿，采用较正式的瓦顶木构。',
    description: '祠址为参考后世方志关系所作推定，不是考古测绘结论。',
  }),
  residence: Object.freeze({
    use: '普通居民起居、储物与家庭生产。',
    structure: '夯土墙木构民居，部分带紧凑院落，灰褐或灰绿瓦顶。',
    description: '民居为街坊尺度复原，不对应已知历史住户。',
  }),
});

const BUILDING_DETAIL_OVERRIDES = Object.freeze({
  'yamen-main-hall': Object.freeze({ use: '州衙核心政务与审理空间，也是正式仪式的主要厅堂。' }),
  'yamen-rear-hall': Object.freeze({ use: '州衙内部议事、文书处理与官员日常办公空间。' }),
  'market-office': Object.freeze({ use: '市易务正厅，负责市场监管、税契与官营交易。' }),
  'market-storehouse': Object.freeze({ use: '市易务附属货栈，用于暂存登记货物与官营物资。' }),
  'chenghuang-temple-compound': Object.freeze({ description: '位置依据后世地方志所述相对方位推定，作为游戏场景使用。' }),
});

function buildingMetadata(feature) {
  if (canonicalCategory(feature) !== 'building') return {};
  const template = BUILDING_DETAIL_TEMPLATES[feature.category] || BUILDING_DETAIL_TEMPLATES.residence;
  const details = Object.freeze({ ...template, ...(BUILDING_DETAIL_OVERRIDES[feature.id] || {}) });
  const enterable = feature.id !== 'yamen-gate';
  if (!enterable || !Number.isFinite(feature.cx) || !Number.isFinite(feature.cy)) {
    return { details, enterable, entrance: null };
  }
  const radians = ((feature.angle || 0) * Math.PI) / 180;
  const offset = feature.height / 2 + 12;
  return {
    details,
    enterable,
    entrance: Object.freeze([
      round(feature.cx - Math.sin(radians) * offset),
      round(feature.cy + Math.cos(radians) * offset),
    ]),
  };
}

const publicFeatures = Object.freeze(featureDefinitions.map((feature) => Object.freeze({
  id: feature.id,
  name: feature.name || feature.id,
  category: canonicalCategory(feature),
  subtype: feature.category,
  importance: featureImportance(feature),
  mode: feature.mode,
  geometry: Object.freeze({
    type: 'polygon',
    points: Object.freeze(feature.geometry.points.map((point) => Object.freeze([...point]))),
  }),
  center: Object.freeze([...feature.center]),
  minCoverage: feature.mode === 'object' ? 0.95 : feature.minCoverage,
  ruinStyle: feature.ruinStyle,
  roadOverlapAllowed: feature.roadOverlapAllowed,
  severeOnly: Boolean(feature.severeOnly),
  ...buildingMetadata(feature),
})));

const navigationGateways = Object.freeze([
  ...gateFeatures,
  ...passFeatures.filter((feature) => feature.category === 'pass-gate'),
  ...yamenFeatures.filter((feature) => feature.id === 'yamen-gate'),
].map((feature) => Object.freeze({
  featureId: feature.id,
  polygon: Object.freeze(rotatedRectangle(
    feature.cx,
    feature.cy,
    Math.max(18, feature.width * 0.24),
    feature.height + 24,
    feature.angle,
  ).map((point) => Object.freeze(point))),
})));

const pointsAttribute = (points) => points.map(([x, y]) => `${x},${y}`).join(' ');

function featureGroupOpen(feature, className) {
  const importance = featureImportance(feature);
  const obstacle = importance === 'primary' ? ' data-label-obstacle="true"' : '';
  return `<g id="feature-${feature.id}" data-feature-id="${feature.id}" data-category="${canonicalCategory(feature)}" data-subtype="${feature.category}" data-mode="${feature.mode}" data-map-importance="${importance}"${obstacle} class="destructible ${className}">`;
}

function renderWall(feature) {
  const points = pointsAttribute(feature.geometry.points);
  return `${featureGroupOpen(feature, 'wall-feature')}
    <polygon points="${points}" class="wall-shadow" transform="translate(7 9)"/>
    <polygon points="${points}" class="rammed-wall"/>
    <polyline points="${points} ${feature.geometry.points[0][0]},${feature.geometry.points[0][1]}" class="wall-crown"/>
  </g>`;
}

function renderPassWall(feature) {
  const points = pointsAttribute(feature.geometry.points);
  return `${featureGroupOpen(feature, 'pass-wall-feature')}
    <polygon points="${points}" class="pass-wall-shadow" transform="translate(8 10)"/>
    <polygon points="${points}" class="pass-wall"/>
    <polyline points="${points}" class="pass-stone-seam"/>
  </g>`;
}

function renderWallTower(feature, artAssets = {}) {
  const { cx, cy, width, height, angle } = feature;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  return `${featureGroupOpen(feature, 'wall-tower-feature')}
    <g transform="rotate(${angle} ${cx} ${cy}) translate(${cx} ${cy})">
      <rect x="${round(-halfWidth + 8)}" y="${round(-halfHeight + 10)}" width="${width}" height="${height}" rx="5" class="building-shadow"/>
      <rect x="${-halfWidth}" y="${-halfHeight}" width="${width}" height="${height}" rx="4" class="wall-tower-base"/>
      <rect x="${round(-width * 0.34)}" y="${round(-height * 0.34)}" width="${round(width * 0.68)}" height="${round(height * 0.68)}" rx="3" class="wall-tower-roof"/>
      <path d="M ${round(-width * 0.34)} ${round(-height * 0.34)} L 0 0 L ${round(width * 0.34)} ${round(-height * 0.34)} M ${round(-width * 0.34)} ${round(height * 0.34)} L 0 0 L ${round(width * 0.34)} ${round(height * 0.34)}" class="hip-ridge"/>
      ${landmarkImage(artAssets.cityWallTowerUrl, -halfWidth - 4, -halfHeight - 4, width + 8, height + 8, 'generated-city-wall-tower')}
    </g>
  </g>`;
}

function roofTileLines(width, height) {
  const lines = [];
  const count = Math.max(3, Math.floor(width / 30));
  for (let index = 1; index < count; index += 1) {
    const x = -width / 2 + (width * index) / count;
    lines.push(`<line x1="${round(x)}" y1="${round(-height / 2 + 5)}" x2="${round(x)}" y2="${round(height / 2 - 5)}" class="roof-tile-line"/>`);
  }
  return lines.join('');
}

function renderGate(feature, pass = false, artAssets = {}) {
  const { cx, cy, width, height, angle } = feature;
  const roofWidth = width * 0.78;
  const roofHeight = height * 0.52;
  const wallClass = pass ? 'pass-gate-base' : 'gate-base';
  return `${featureGroupOpen(feature, pass ? 'pass-gate-feature' : 'gate-feature')}
    <g transform="rotate(${angle} ${cx} ${cy}) translate(${cx} ${cy})">
      <rect x="${-width / 2 + 7}" y="${-height / 2 + 9}" width="${width}" height="${height}" rx="7" class="building-shadow"/>
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" rx="7" class="${wallClass}"/>
      <rect x="${-width * 0.12}" y="${-height / 2 - 2}" width="${width * 0.24}" height="${height + 4}" rx="9" class="gate-opening"/>
      <rect x="${-roofWidth / 2}" y="${-roofHeight / 2}" width="${roofWidth}" height="${roofHeight}" rx="4" class="gate-roof"/>
      <path d="M ${-roofWidth / 2} 0 L 0 ${-roofHeight / 2} L ${roofWidth / 2} 0 L 0 ${roofHeight / 2} Z" class="hip-ridge"/>
      <line x1="${-roofWidth * 0.28}" y1="0" x2="${roofWidth * 0.28}" y2="0" class="roof-ridge"/>
      ${landmarkImage(
        pass ? artAssets.jinchengGatehouseUrl : artAssets.cityGatehouseUrl,
        -width / 2 - 4,
        -height / 2 - 4,
        width + 8,
        height + 8,
        pass ? 'generated-jincheng-gatehouse' : 'generated-city-gatehouse',
      )}
    </g>
  </g>`;
}

function renderBridge(feature, artAssets = {}) {
  const pontoons = Array.from({ length: 13 }, (_, index) => {
    const t = index / 12;
    const x = 3458 + 94 * t + Math.sin(t * Math.PI) * 18;
    const y = 846 + 478 * t;
    const angle = 77 - t * 5;
    return `<g transform="translate(${round(x)} ${round(y)}) rotate(${round(angle)})">
      <ellipse cx="0" cy="0" rx="33" ry="12" class="bridge-boat"/>
      <line x1="-20" y1="0" x2="20" y2="0" class="bridge-boat-rib"/>
    </g>`;
  }).join('');
  const planks = Array.from({ length: 22 }, (_, index) => {
    const t = index / 21;
    const x = 3464 + 84 * t + Math.sin(t * Math.PI) * 18;
    const y = 836 + 500 * t;
    return `<line x1="${round(x - 24)}" y1="${round(y + 4)}" x2="${round(x + 24)}" y2="${round(y - 4)}" class="bridge-plank"/>`;
  }).join('');

  return `${featureGroupOpen(feature, 'bridge-feature')}
    <g class="bridge-vector${artAssets.yellowRiverPontoonUrl ? ' bridge-vector-underlay' : ''}">
      <path d="M3462 832 C3487 986 3512 1160 3549 1338" class="bridge-rope-shadow"/>
      ${pontoons}
      <path d="M3462 832 C3487 986 3512 1160 3549 1338" class="bridge-deck"/>
      ${planks}
      <path d="M3431 831 C3453 997 3478 1174 3518 1341 M3492 826 C3517 986 3542 1154 3580 1332" class="bridge-rail"/>
    </g>
    <g transform="rotate(-10 3508 1086)">
      ${landmarkImage(artAssets.yellowRiverPontoonUrl, 3442, 818, 132, 536, 'generated-yellow-river-pontoon')}
    </g>
  </g>`;
}

function renderField(feature) {
  const points = pointsAttribute(feature.geometry.points);
  return `${featureGroupOpen(feature, 'terrain-feature field-feature')}
    <polygon points="${points}" class="field"/>
    <polygon points="${points}" class="field-overlay"/>
  </g>`;
}

const buildingPalette = {
  yamen: ['#d8c8a6', '#6f776d', '#4e554e'],
  barracks: ['#d7c8a9', '#7d776a', '#555148'],
  granary: ['#d9c49b', '#806f58', '#574b3b'],
  stable: ['#cfbb96', '#8a7355', '#5c4a37'],
  workshop: ['#d4bd96', '#786b5a', '#51473d'],
  'market-office': ['#d9c7a2', '#70796e', '#4c554d'],
  market: ['#dcc6a0', '#81735f', '#574b3d'],
  temple: ['#ddc9a5', '#667168', '#444d47'],
  residence: ['#d9c8a7', '#868078', '#5b5650'],
};

function landmarkImage(url, x, y, width, height, className) {
  if (!url) return '';
  return `<image href="${escapeSvgAttribute(url)}" x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" preserveAspectRatio="none" class="generated-landmark-art ${className}"/>`;
}

function stableVariant(value, count) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

function buildingSpriteGroup(feature) {
  if (feature.category === 'yamen' && feature.renderType === 'gate-building') return 'yamenGate';
  if (feature.category === 'yamen' && feature.renderType === 'side-hall') return 'yamenSideHall';
  if (feature.category === 'barracks') return 'barracks';
  if (feature.category === 'granary') return 'granary';
  if (feature.category === 'stable') return 'stable';
  if (feature.category === 'workshop') return 'workshop';
  if (feature.category === 'market' && feature.renderType === 'shop') return 'marketShop';
  if (feature.category === 'residence' && feature.renderType === 'house') return 'residenceHouse';
  if (feature.category === 'residence' && feature.renderType === 'courtyard-house') return 'residenceCourtyard';
  return null;
}

function buildingArtImage(feature, buildingSprites) {
  const groupName = buildingSpriteGroup(feature);
  const variants = groupName ? buildingSprites?.[groupName] : null;
  if (!variants?.length) return '';
  const variant = stableVariant(feature.id, variants.length);
  return `<image href="${escapeSvgAttribute(variants[variant])}" x="${round(-feature.width / 2)}" y="${round(-feature.height / 2)}" width="${round(feature.width)}" height="${round(feature.height)}" preserveAspectRatio="xMidYMid meet" class="generated-building-art" data-building-art-for="${escapeSvgAttribute(feature.id)}" data-building-art-variant="${variant}"/>`;
}

function renderTempleCompound(feature, artAssets = {}) {
  const { cx, cy, width, height, angle } = feature;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const gateHalfWidth = 38;
  const openingHalfWidth = 11;

  return `${featureGroupOpen(feature, 'building-feature temple temple-compound')}
    <g transform="rotate(${angle} ${cx} ${cy}) translate(${cx} ${cy})">
      <rect x="${round(-halfWidth + 8)}" y="${round(-halfHeight + 10)}" width="${width}" height="${height}" rx="5" class="building-shadow"/>
      <rect x="${-halfWidth}" y="${-halfHeight}" width="${width}" height="${height}" rx="3" class="temple-ground"/>
      <path d="M ${-halfWidth} ${halfHeight} V ${-halfHeight} H ${halfWidth} V ${halfHeight}
        M ${-halfWidth} ${halfHeight} H ${-gateHalfWidth}
        M ${gateHalfWidth} ${halfHeight} H ${halfWidth}" class="temple-wall"/>

      <g aria-label="后部小房">
        <rect x="-31" y="-91" width="62" height="15" class="building-base" style="fill:#ddc9a5"/>
        <rect x="-35" y="-94" width="70" height="21" rx="2" class="roof" style="fill:#72786f;stroke:#444d47"/>
        <line x1="-22" y1="-83.5" x2="22" y2="-83.5" class="roof-ridge"/>
      </g>

      <g aria-label="正殿">
        <rect x="-52" y="-66" width="104" height="34" class="building-base" style="fill:#ddc9a5"/>
        <rect x="-57" y="-71" width="114" height="44" rx="3" class="roof" style="fill:#667168;stroke:#444d47"/>
        <path d="M -57 -71 L -34 -49 L -57 -27 M 57 -71 L 34 -49 L 57 -27" class="hip-ridge"/>
        <line x1="-34" y1="-49" x2="34" y2="-49" class="roof-ridge"/>
        <rect x="-10" y="-33" width="20" height="7" class="door"/>
      </g>

      <g aria-label="东西廊房">
        <rect x="-62" y="-20" width="21" height="65" class="building-base" style="fill:#d8c39e"/>
        <rect x="-66" y="-24" width="29" height="73" rx="2" class="roof" style="fill:#74776c;stroke:#494d47"/>
        <line x1="-51.5" y1="-14" x2="-51.5" y2="39" class="roof-ridge"/>
        <rect x="41" y="-20" width="21" height="65" class="building-base" style="fill:#d8c39e"/>
        <rect x="37" y="-24" width="29" height="73" rx="2" class="roof" style="fill:#74776c;stroke:#494d47"/>
        <line x1="51.5" y1="-14" x2="51.5" y2="39" class="roof-ridge"/>
      </g>

      <rect x="-33" y="-16" width="66" height="63" rx="4" class="temple-courtyard"/>
      <circle cx="0" cy="14" r="7" class="temple-incense-burner"/>
      <path d="M 0 84 V 47" class="temple-entry-path"/>

      <g aria-label="南向庙门">
        <rect x="${-gateHalfWidth}" y="72" width="${round(gateHalfWidth - openingHalfWidth)}" height="20" class="building-base" style="fill:#d9c39d"/>
        <rect x="${openingHalfWidth}" y="72" width="${round(gateHalfWidth - openingHalfWidth)}" height="20" class="building-base" style="fill:#d9c39d"/>
        <rect x="${-gateHalfWidth - 4}" y="68" width="${round(gateHalfWidth - openingHalfWidth + 4)}" height="28" rx="2" class="roof" style="fill:#667168;stroke:#444d47"/>
        <rect x="${openingHalfWidth}" y="68" width="${round(gateHalfWidth - openingHalfWidth + 4)}" height="28" rx="2" class="roof" style="fill:#667168;stroke:#444d47"/>
        <line x1="${-gateHalfWidth}" y1="82" x2="${-openingHalfWidth}" y2="82" class="roof-ridge"/>
        <line x1="${openingHalfWidth}" y1="82" x2="${gateHalfWidth}" y2="82" class="roof-ridge"/>
        <rect x="${-openingHalfWidth}" y="72" width="${openingHalfWidth * 2}" height="22" class="gate-opening"/>
      </g>
      ${landmarkImage(artAssets.chenghuangTempleUrl, -halfWidth - 4, -halfHeight - 4, width + 8, height + 8, 'generated-chenghuang-temple')}
    </g>
  </g>`;
}

function renderBuilding(feature, artAssets = {}) {
  const { cx, cy, width, height, angle, renderType, category } = feature;
  const [base, roof, ridge] = buildingPalette[category] || buildingPalette.residence;
  const platformX = -width / 2 - 7;
  const platformY = -height / 2 - 7;
  const platformWidth = width + 14;
  const platformHeight = height + 14;
  let body = '';

  if (renderType === 'stable') {
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${width * 0.66}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${-width / 2 - 5}" y="${-height / 2 - 5}" width="${width * 0.69}" height="${height * 0.55}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <line x1="${-width / 2}" y1="${-height * 0.23}" x2="${round(-width / 2 + width * 0.66 - 5)}" y2="${-height * 0.23}" class="roof-ridge"/>
      <rect x="${round(width * 0.18)}" y="${round(-height / 2 + 5)}" width="${round(width * 0.31)}" height="${round(height - 10)}" class="stable-yard"/>
      <path d="M${round(width * 0.18)} ${round(-height / 2 + 5)}V${round(height / 2 - 5)} M${round(width * 0.33)} ${round(-height / 2 + 5)}V${round(height / 2 - 5)}" class="timber-posts"/>
      <path d="M${round(width * 0.18)} ${round(-height * 0.12)}H${round(width / 2 - 5)} M${round(width * 0.18)} ${round(height * 0.2)}H${round(width / 2 - 5)}" class="stable-partition"/>`;
  } else if (renderType === 'workshop') {
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${width * 0.64}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${-width / 2 - 5}" y="${-height / 2 - 5}" width="${width * 0.68}" height="${height + 10}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <line x1="${-width / 2}" y1="0" x2="${round(-width / 2 + width * 0.64)}" y2="0" class="roof-ridge"/>
      <rect x="${round(width * 0.18)}" y="${round(-height / 2 + 3)}" width="${round(width * 0.30)}" height="${round(height - 6)}" class="work-yard"/>
      <circle cx="${round(width * 0.28)}" cy="${round(-height * 0.15)}" r="10" class="workshop-hearth"/>
      <rect x="${round(width * 0.24)}" y="${round(height * 0.15)}" width="${round(width * 0.18)}" height="9" class="work-bench"/>`;
  } else if (renderType === 'gate-building') {
    const opening = width * 0.30;
    const wing = (width - opening) / 2;
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${wing}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${opening / 2}" y="${-height / 2}" width="${wing}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${-width / 2 - 6}" y="${-height / 2 - 6}" width="${wing + 6}" height="${height + 12}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <rect x="${opening / 2}" y="${-height / 2 - 6}" width="${wing + 6}" height="${height + 12}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <line x1="${-width / 2}" y1="0" x2="${-opening / 2}" y2="0" class="roof-ridge"/>
      <line x1="${opening / 2}" y1="0" x2="${width / 2}" y2="0" class="roof-ridge"/>
      <rect x="${-opening / 2}" y="${-height / 2 + 2}" width="${opening}" height="${height - 4}" class="gate-opening" opacity=".82"/>
      <path d="M ${-opening / 2} ${-height / 2} V ${height / 2} M ${opening / 2} ${-height / 2} V ${height / 2}" class="timber-posts"/>`;
  } else if (renderType === 'shop') {
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${-width / 2 - 5}" y="${-height / 2 - 5}" width="${width + 10}" height="${height + 10}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <line x1="${round(-width * 0.34)}" y1="0" x2="${round(width * 0.34)}" y2="0" class="roof-ridge"/>
      ${roofTileLines(width, height)}
      <rect x="${-width / 2}" y="${round(height / 2 - 4)}" width="${width}" height="16" rx="2" class="shop-awning" style="fill:${feature.accent || '#a05d47'}"/>
      <line x1="${-width / 2 + 8}" y1="${round(height / 2 + 12)}" x2="${-width / 2 + 8}" y2="${round(height / 2 + 25)}" class="awning-post"/>
      <line x1="${width / 2 - 8}" y1="${round(height / 2 + 12)}" x2="${width / 2 - 8}" y2="${round(height / 2 + 25)}" class="awning-post"/>`;
  } else if (renderType === 'courtyard-house') {
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" class="courtyard-ground"/>
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height * 0.38}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <line x1="${round(-width * 0.34)}" y1="${round(-height * 0.31)}" x2="${round(width * 0.34)}" y2="${round(-height * 0.31)}" class="roof-ridge"/>
      <rect x="${-width / 2}" y="${round(-height * 0.02)}" width="${width * 0.24}" height="${height * 0.52}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <rect x="${round(width * 0.26)}" y="${round(-height * 0.02)}" width="${width * 0.24}" height="${height * 0.52}" class="roof" style="fill:${roof};stroke:${ridge}"/>
      <rect x="${round(-width * 0.18)}" y="${round(height * 0.23)}" width="${round(width * 0.36)}" height="${round(height * 0.2)}" class="courtyard"/>`;
  } else {
    const hip = renderType === 'hall' || renderType === 'gate-building';
    body = `
      <rect x="${-width / 2}" y="${-height / 2}" width="${width}" height="${height}" class="building-base" style="fill:${base}"/>
      <rect x="${-width / 2 - 6}" y="${-height / 2 - 6}" width="${width + 12}" height="${height + 12}" rx="3" class="roof" style="fill:${roof};stroke:${ridge}"/>
      ${hip ? `<path d="M ${-width / 2 - 6} ${-height / 2 - 6} L ${round(-width * 0.30)} 0 L ${-width / 2 - 6} ${height / 2 + 6} M ${width / 2 + 6} ${-height / 2 - 6} L ${round(width * 0.30)} 0 L ${width / 2 + 6} ${height / 2 + 6}" class="hip-ridge"/>` : roofTileLines(width, height)}
      <line x1="${round(-width * 0.30)}" y1="0" x2="${round(width * 0.30)}" y2="0" class="roof-ridge"/>
      <rect x="${round(-width * 0.08)}" y="${round(height / 2 - 2)}" width="${round(width * 0.16)}" height="8" class="door"/>`;
  }

  const generatedBuildingArt = buildingArtImage(feature, artAssets.buildingSprites);
  let generatedLandmarkArt = '';
  if (category === 'yamen' && renderType === 'hall') {
    generatedLandmarkArt = landmarkImage(artAssets.yamenHallUrl, -width / 2 - 8, -height / 2 - 10, width + 16, height + 20, 'generated-yamen-hall');
  } else if (category === 'market-office' && renderType === 'hall') {
    generatedLandmarkArt = landmarkImage(artAssets.marketOfficeHallUrl, -width / 2 - 8, -height / 2 - 10, width + 16, height + 20, 'generated-market-office-hall');
  } else if (category === 'market-office' && renderType === 'granary') {
    generatedLandmarkArt = landmarkImage(artAssets.marketStorehouseUrl, -width / 2 - 7, -height / 2 - 7, width + 14, height + 14, 'generated-market-storehouse');
  }
  const hasGeneratedArt = Boolean(generatedBuildingArt || generatedLandmarkArt);
  const generatedFeatureClass = generatedBuildingArt
    ? ' generated-building-feature'
    : (generatedLandmarkArt ? ' generated-landmark-feature' : '');

  return `${featureGroupOpen(feature, `building-feature ${category}${generatedFeatureClass}`)}
    <g transform="rotate(${angle} ${cx} ${cy}) translate(${cx} ${cy})">
      <rect x="${round(platformX + 8)}" y="${round(platformY + 10)}" width="${round(platformWidth)}" height="${round(platformHeight)}" rx="5" class="building-shadow"/>
      <rect x="${platformX}" y="${platformY}" width="${platformWidth}" height="${platformHeight}" rx="5" class="building-platform"/>
      <g class="building-vector${hasGeneratedArt ? ' building-vector-underlay' : ''}">${body}</g>
      ${generatedLandmarkArt}
      ${generatedBuildingArt}
    </g>
  </g>`;
}

function renderFeature(feature, artAssets = {}) {
  if (feature.renderType === 'field') return renderField(feature);
  if (feature.renderType === 'wall') return renderWall(feature);
  if (feature.renderType === 'pass-wall') return renderPassWall(feature);
  if (feature.renderType === 'wall-tower') return renderWallTower(feature, artAssets);
  if (feature.renderType === 'gate') return renderGate(feature, false, artAssets);
  if (feature.renderType === 'pass-gate') return renderGate(feature, true, artAssets);
  if (feature.renderType === 'bridge') return renderBridge(feature, artAssets);
  if (feature.renderType === 'temple-compound') return renderTempleCompound(feature, artAssets);
  if (feature.renderType === 'tree') {
    return `${featureGroupOpen(feature, 'vegetation-feature tree-feature')}${treeSvg(feature.cx, feature.cy, feature.width / 2, feature.accent || 0)}</g>`;
  }
  return renderBuilding(feature, artAssets);
}

function treeSvg(x, y, radius, tone = 0) {
  const palettes = [
    ['#607b4e', '#879a63'],
    ['#6f8252', '#9aa36c'],
    ['#536f49', '#7f945f'],
  ];
  const [dark, light] = palettes[tone % palettes.length];
  return `<g class="tree" transform="translate(${round(x)} ${round(y)})">
    <ellipse cx="4" cy="7" rx="${round(radius)}" ry="${round(radius * 0.76)}" class="tree-shadow"/>
    <circle cx="0" cy="0" r="${round(radius)}" fill="${dark}"/>
    <circle cx="${round(-radius * 0.22)}" cy="${round(-radius * 0.24)}" r="${round(radius * 0.61)}" fill="${light}"/>
    <circle cx="${round(radius * 0.31)}" cy="${round(-radius * 0.08)}" r="${round(radius * 0.42)}" fill="${light}" opacity=".72"/>
  </g>`;
}

function seededVegetation() {
  let state = 1104;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const trees = [];
  const bands = [
    [60, 80, 2550, 610, 66],
    [3250, 60, 5900, 650, 72],
    [80, 3750, 1800, 4820, 64],
    [4200, 3520, 5900, 4820, 72],
  ];
  bands.forEach(([x0, y0, x1, y1, count], bandIndex) => {
    for (let index = 0; index < count; index += 1) {
      const x = x0 + random() * (x1 - x0);
      const y = y0 + random() * (y1 - y0);
      const radius = 9 + random() * 15;
      trees.push(treeSvg(x, y, radius, bandIndex + index));
    }
  });
  return trees.join('');
}

function createParcelsLayer() {
  return `<g id="layer-parcels" data-layer="parcels">
    <path d="M2110 1660 L3010 1605 L3060 2130 L2850 2200 L2140 2240 Z" class="parcel military-parcel"/>
    <path d="M3520 1570 L3845 1555 L3910 2045 L3520 2110 Z" class="parcel granary-parcel"/>
    <path d="M3030 1585 L3550 1570 L3495 2115 L3010 2175 Z" class="parcel market-parcel"/>
    <path d="M2420 2340 L3055 2325 L3060 2870 L2440 2900 Z" class="parcel yamen-parcel"/>
    <path d="M2135 2415 L2675 2335 L2780 2860 L2170 2970 Z" class="parcel workshop-parcel"/>
    <path d="M2115 1960 L2960 1930 L2945 2195 L2140 2270 Z" class="parcel stable-parcel"/>
    <path d="M3300 2290 L3975 2250 L4010 2800 L3250 2885 Z" class="parcel residential-parcel"/>
    <path d="M2090 2720 L2670 2860 L2610 2980 L2150 3025 Z" class="parcel residential-parcel pale"/>
    <g class="courtyard-walls">
      <path d="M2470 2370 L3010 2350 L3020 2850 L2455 2870 Z"/>
      <path d="M2160 1660 L2980 1620 L2995 2130 L2145 2195 Z"/>
      <path d="M3540 1590 L3830 1570 L3880 2025 L3530 2070 Z"/>
    </g>
  </g>`;
}

function createRoadsLayer() {
  const roadPaths = `
    <g class="roads outside-roads">
      <path d="M3538 1332 C3498 1430 3445 1480 3364 1546" class="road-edge major"/>
      <path d="M3538 1332 C3498 1430 3445 1480 3364 1546" class="road major"/>
      <path d="M2085 2338 C1660 2385 1180 2495 650 2670 C390 2755 160 2820 -80 2860" class="road-edge country"/>
      <path d="M2085 2338 C1660 2385 1180 2495 650 2670 C390 2755 160 2820 -80 2860" class="road country"/>
      <path d="M3915 2152 C4320 2115 4720 1990 5120 1835 C5460 1700 5730 1655 6060 1670" class="road-edge country"/>
      <path d="M3915 2152 C4320 2115 4720 1990 5120 1835 C5460 1700 5730 1655 6060 1670" class="road country"/>
      <path d="M3128 2944 C3050 3210 3010 3500 3110 3760 C3210 4015 3440 4250 3650 4520" class="road-edge country"/>
      <path d="M3128 2944 C3050 3210 3010 3500 3110 3760 C3210 4015 3440 4250 3650 4520" class="road country"/>
    </g>
    <g class="roads city-roads">
      <path d="M3364 1546 C3390 1740 3350 1960 3268 2195 C3190 2420 3110 2695 3128 2944" class="road-edge major"/>
      <path d="M3364 1546 C3390 1740 3350 1960 3268 2195 C3190 2420 3110 2695 3128 2944" class="road major"/>
      <path d="M2085 2338 C2470 2270 2860 2285 3268 2195 C3520 2140 3690 2210 3915 2152" class="road-edge major"/>
      <path d="M2085 2338 C2470 2270 2860 2285 3268 2195 C3520 2140 3690 2210 3915 2152" class="road major"/>
      <path d="M2130 2400 C2400 2380 2700 2320 3020 2300 C3120 2290 3190 2240 3268 2195" class="road-edge lane"/>
      <path d="M2130 2400 C2400 2380 2700 2320 3020 2300 C3120 2290 3190 2240 3268 2195" class="road lane"/>
      <path d="M2774 2782 C2900 2800 3025 2875 3128 2944" class="road-edge lane"/>
      <path d="M2774 2782 C2900 2800 3025 2875 3128 2944" class="road lane"/>
      <path d="M3300 2300 C3500 2320 3650 2240 3950 2220" class="road-edge alley"/>
      <path d="M3300 2300 C3500 2320 3650 2240 3950 2220" class="road alley"/>
      <path d="M3300 2540 C3500 2560 3700 2625 3980 2680" class="road-edge alley"/>
      <path d="M3300 2540 C3500 2560 3700 2625 3980 2680" class="road alley"/>
    </g>`;

  return roadPaths;
}

function createDestructibleLayer(artAssets = {}) {
  return `<g id="layer-destructible" data-layer="destructible">
    ${featureDefinitions
    .filter((feature) => !feature.severeOnly)
    .map((feature) => renderFeature(feature, artAssets))
    .join('\n')}
  </g>`;
}

function createLabelsLayer() {
  return `<g id="layer-labels" data-layer="labels">
    <g class="map-title" transform="translate(360 420)" data-map-label="true" data-label-priority="100" data-min-zoom-tier="overview" data-max-zoom-tier="overview" data-label-candidates="0,0">
      <text x="0" y="0">北宋兰州城</text>
      <text x="2" y="55" class="map-subtitle">崇宁三年（1104）· 游戏比例地图</text>
    </g>
    <text x="1030" y="1105" class="water-label" transform="rotate(6 1030 1105)" data-map-label="true" data-label-priority="94" data-min-zoom-tier="overview" data-max-zoom-tier="mid" data-label-candidates="0,0|0,-20|0,20">黄　河</text>
    <text x="2890" y="480" class="place-label strong" data-map-label="true" data-label-priority="96" data-min-zoom-tier="overview" data-label-anchor="jincheng-gatehouse" data-label-candidates="0,0|-30,0|30,0">金城关</text>
    <text x="3600" y="1060" class="small-label water-note" transform="rotate(79 3600 1060)" data-label-for="yellow-river-pontoon-bridge" data-map-label="true" data-label-priority="82" data-min-zoom-tier="mid" data-label-anchor="yellow-river-pontoon-bridge" data-label-candidates="0,0|-24,0|24,0">浮桥（线位推测）</text>
    <text x="3030" y="1450" class="district-label" data-map-label="true" data-label-priority="86" data-min-zoom-tier="overview" data-max-zoom-tier="mid" data-label-candidates="0,0|0,-24|0,24">1104年主体城</text>
    <text x="2700" y="3540" class="ruin-label" data-map-label="true" data-label-priority="48" data-min-zoom-tier="mid" data-max-zoom-tier="mid">旧南城遗迹</text>
    <text x="2540" y="2370" class="place-label" data-map-label="true" data-label-priority="90" data-min-zoom-tier="mid" data-label-anchor="yamen-main-hall">州衙〔位置推测〕</text>
    <text x="2190" y="1685" class="place-label" data-map-label="true" data-label-priority="66" data-min-zoom-tier="mid">军营</text>
    <text x="3560" y="1580" class="place-label" data-map-label="true" data-label-priority="64" data-min-zoom-tier="mid">仓廪</text>
    <text x="2250" y="2020" class="place-label" data-map-label="true" data-label-priority="58" data-min-zoom-tier="mid">马厩</text>
    <text x="2160" y="2440" class="place-label" data-map-label="true" data-label-priority="55" data-min-zoom-tier="mid">军需修造场</text>
    <text x="3450" y="2120" class="place-label" data-map-label="true" data-label-priority="72" data-min-zoom-tier="mid" data-label-anchor="market-office">市易务</text>
    <text x="3080" y="2184" text-anchor="middle" class="temple-label" data-label-for="chenghuang-temple-compound" data-map-label="true" data-label-priority="92" data-min-zoom-tier="mid" data-label-anchor="chenghuang-temple-compound">州城隍神祠〔位置推定〕</text>
    <text x="3610" y="2860" class="place-label muted" data-map-label="true" data-label-priority="30" data-min-zoom-tier="detail">民居与小院</text>
    <text x="3310" y="1468" class="gate-label" data-map-label="true" data-label-priority="78" data-min-zoom-tier="mid" data-label-anchor="gate-north">北门〔推定〕</text>
    <text x="3985" y="2110" class="gate-label" transform="rotate(80 3985 2110)" data-map-label="true" data-label-priority="78" data-min-zoom-tier="mid" data-label-anchor="gate-east">东门〔推定〕</text>
    <text x="3020" y="3060" class="gate-label" data-map-label="true" data-label-priority="78" data-min-zoom-tier="mid" data-label-anchor="gate-south">南门〔推定〕</text>
    <text x="1960" y="2390" class="gate-label" transform="rotate(-84 1960 2390)" data-map-label="true" data-label-priority="78" data-min-zoom-tier="mid" data-label-anchor="gate-west">西门〔推定〕</text>
    <text x="1050" y="4230" class="terrain-label" data-map-label="true" data-label-priority="70" data-min-zoom-tier="overview" data-max-zoom-tier="mid" data-label-candidates="0,0|0,-18|18,0">南部山麓与冲沟</text>
    <text x="4770" y="490" class="terrain-label" data-map-label="true" data-label-priority="70" data-min-zoom-tier="overview" data-max-zoom-tier="mid" data-label-candidates="0,0|0,18|-18,0">北岸山地</text>
    <g class="north-arrow" transform="translate(5530 420)">
      <path d="M0 105 L34 0 L68 105 L34 78 Z"/>
      <line x1="34" y1="72" x2="34" y2="145"/>
      <text x="34" y="-20" text-anchor="middle">北</text>
    </g>
    <g class="scale" transform="translate(410 4600)">
      <text x="0" y="-24">约比例尺（游戏坐标）</text>
      <rect x="0" y="0" width="250" height="18" class="scale-dark"/>
      <rect x="250" y="0" width="250" height="18" class="scale-light"/>
      <rect x="500" y="0" width="250" height="18" class="scale-dark"/>
      <rect x="750" y="0" width="250" height="18" class="scale-light"/>
      <path d="M0 0V30 M250 0V30 M500 0V30 M750 0V30 M1000 0V30"/>
      <text x="0" y="56">0</text><text x="490" y="56">500</text><text x="972" y="56">1000 m</text>
    </g>
  </g>`;
}

function escapeSvgAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function generatedTerrainPattern(artAssets) {
  if (!artAssets?.loessTerrainUrl) return '';
  return `<pattern id="generated-loess-terrain" width="768" height="768" patternUnits="userSpaceOnUse">
      <image href="${escapeSvgAttribute(artAssets.loessTerrainUrl)}" width="768" height="768" preserveAspectRatio="none"/>
    </pattern>`;
}

function generatedRiverPattern(artAssets) {
  if (!artAssets?.yellowRiverUrl) return '';
  return `<pattern id="generated-yellow-river" width="768" height="768" patternUnits="userSpaceOnUse">
      <image href="${escapeSvgAttribute(artAssets.yellowRiverUrl)}" width="768" height="768" preserveAspectRatio="none"/>
    </pattern>`;
}

function generatedTerrainOverlay(artAssets, markup) {
  return artAssets?.loessTerrainUrl ? markup : '';
}

export function createLanzhouSvg(artAssets = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${MAP_WIDTH}" height="${MAP_HEIGHT}" viewBox="0 0 ${MAP_WIDTH} ${MAP_HEIGHT}" role="img" aria-labelledby="lanzhou-title lanzhou-desc" preserveAspectRatio="xMidYMid meet">
  <title id="lanzhou-title">北宋兰州城 · RPG 战术地图</title>
  <desc id="lanzhou-desc">一幅分层矢量地图，表现黄河、北岸金城关和浮桥、1104年主体城、废弃南城遗迹，以及边防州城的军营、仓廪、马厩、修造场、市易务、官署、州城隍神祠推定院落和民居。</desc>
  <defs>
    <linearGradient id="paper-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eee3ca"/><stop offset=".52" stop-color="#e7d9bc"/><stop offset="1" stop-color="#dfcfad"/>
    </linearGradient>
    <linearGradient id="river-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#8eb3be"/><stop offset=".25" stop-color="#699cad"/><stop offset=".58" stop-color="#4f879b"/><stop offset="1" stop-color="#8cb1ba"/>
    </linearGradient>
    <linearGradient id="mountain-gradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#a99872"/><stop offset="1" stop-color="#c9b993"/>
    </linearGradient>
    <pattern id="paper-fiber" width="56" height="44" patternUnits="userSpaceOnUse">
      <path d="M3 9 Q18 3 38 10 M18 31 Q36 25 54 33" fill="none" stroke="#7d6e53" stroke-width="1.2" opacity=".075"/>
      <circle cx="8" cy="37" r="1.3" fill="#775f42" opacity=".09"/><circle cx="45" cy="19" r="1" fill="#775f42" opacity=".08"/>
    </pattern>
    <pattern id="field-hatch" width="34" height="34" patternUnits="userSpaceOnUse" patternTransform="rotate(10)">
      <path d="M0 5 H34 M0 18 H34 M0 31 H34" stroke="#8b7a4e" stroke-width="2" opacity=".22"/>
    </pattern>
    <pattern id="rubble-pattern" width="38" height="30" patternUnits="userSpaceOnUse">
      <path d="M3 20 l8 -7 10 5 8 -9" fill="none" stroke="#806e53" stroke-width="3" opacity=".38"/>
      <circle cx="30" cy="24" r="2.5" fill="#8c7857" opacity=".42"/>
    </pattern>
    ${generatedTerrainPattern(artAssets)}
    ${generatedRiverPattern(artAssets)}
    <style>
      text { font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Microsoft YaHei", serif; fill: #443925; paint-order: stroke; stroke: #eee3ca; stroke-width: 5px; stroke-linejoin: round; }
      .terrain-contour { fill: none; stroke: #7e6d4f; stroke-width: 9; opacity: .24; }
      .terrain-contour.fine { stroke-width: 4; opacity: .18; }
      .mountain-face { fill: url(#mountain-gradient); stroke: #806f50; stroke-width: 8; }
      .mountain-light { fill: #d4c5a1; opacity: .55; }
      .gully { fill: none; stroke: #9f865f; stroke-width: 24; opacity: .35; stroke-linecap: round; }
      .field { fill: #cabb91; stroke: #9e8b62; stroke-width: 5; }
      .field-overlay { fill: url(#field-hatch); }
      .city-ground { fill: #eadfc8; stroke: #bda986; stroke-width: 5; }
      .river-bank { fill: none; stroke: #76654b; stroke-width: 13; opacity: .66; }
      .river-inner-bank { fill: none; stroke: #d5c39e; stroke-width: 30; opacity: .75; }
      .water-current { fill: none; stroke: #e8f0e9; stroke-width: 8; opacity: .31; stroke-linecap: round; }
      .sandbar { fill: #d1bd91; stroke: #b49b6c; stroke-width: 5; opacity: .9; }
      .ruin-wall { fill: none; stroke: #927b58; stroke-width: 48; stroke-dasharray: 95 34 42 28; stroke-linecap: round; opacity: .55; }
      .ruin-crown { fill: none; stroke: #6f5c43; stroke-width: 7; stroke-dasharray: 38 24; opacity: .52; }
      .ruin-foundation { fill: url(#rubble-pattern); stroke: #8c7655; stroke-width: 6; stroke-dasharray: 18 12; opacity: .62; }
      .road-edge { fill: none; stroke: #9d8969; stroke-linecap: round; stroke-linejoin: round; opacity: .45; }
      .road { fill: none; stroke: #c9b793; stroke-linecap: round; stroke-linejoin: round; }
      .road-edge.major { stroke-width: 18; }.road.major { stroke-width: 12; }
      .road-edge.country { stroke-width: 14; }.road.country { stroke-width: 8; stroke-dasharray: 34 7; }
      .road-edge.lane { stroke-width: 13; }.road.lane { stroke-width: 7; }
      .road-edge.alley { stroke-width: 9; }.road.alley { stroke-width: 3; }
      .parcel { stroke: #ad9874; stroke-width: 5; stroke-dasharray: 18 10; }
      .military-parcel { fill: #e0d4bb; }.granary-parcel { fill: #ddcfac; }.market-parcel { fill: #e6d4b3; }
      .yamen-parcel { fill: #e5d8bf; }.workshop-parcel { fill: #dbc7a6; }.stable-parcel { fill: #deceb0; }
      .residential-parcel { fill: #e5d8bf; }.residential-parcel.pale { fill: #e9ddc6; }
      .courtyard-walls path { fill: none; stroke: #9f8764; stroke-width: 11; stroke-dasharray: 34 14; opacity: .65; }
      .wall-shadow { fill: #7c6a51; opacity: .26; }.rammed-wall { fill: #c7b58f; stroke: #826d4e; stroke-width: 8; }
      .wall-crown { fill: none; stroke: #e4d5b5; stroke-width: 10; stroke-dasharray: 28 14; opacity: .72; }
      .pass-wall-shadow { fill: #594b39; opacity: .32; }.pass-wall { fill: #a99773; stroke: #65543d; stroke-width: 9; }
      .pass-stone-seam { fill: none; stroke: #d5c39f; stroke-width: 7; stroke-dasharray: 24 16; opacity: .65; }
      .wall-tower-base { fill: #b39b70; stroke: #68533a; stroke-width: 7; }.wall-tower-roof { fill: #6f776d; stroke: #465049; stroke-width: 5; }
      .gate-base { fill: #bca881; stroke: #705d43; stroke-width: 7; }.pass-gate-base { fill: #9e8a68; stroke: #5c4b37; stroke-width: 8; }
      .gate-opening { fill: #41372c; stroke: #251e18; stroke-width: 5; }.gate-roof { fill: #6d726b; stroke: #474c47; stroke-width: 7; }
      .building-shadow { fill: #66533c; opacity: .24; }.building-platform { fill: #d8c8aa; stroke: #9d8663; stroke-width: 4; }
      .building-base { stroke: #856c4d; stroke-width: 4; }.roof { stroke-width: 6; }
      .roof-ridge { stroke: #4d4840; stroke-width: 7; stroke-linecap: round; }.hip-ridge { fill: none; stroke: #555149; stroke-width: 5; opacity: .9; }
      .roof-tile-line { stroke: #4e4b45; stroke-width: 2.4; opacity: .28; }.door { fill: #5c3e2a; }
      .stable-yard, .work-yard { fill: #c8b28d; stroke: #886e4d; stroke-width: 4; stroke-dasharray: 12 7; }
      .timber-posts, .stable-partition { fill: none; stroke: #60472f; stroke-width: 5; }.workshop-hearth { fill: #6a5a47; stroke: #41382e; stroke-width: 4; }
      .work-bench { fill: #725239; }.shop-awning { stroke: #563d2d; stroke-width: 3; }.awning-post { stroke: #60452e; stroke-width: 5; }
      .courtyard-ground { fill: #d4c3a4; stroke: #8e7656; stroke-width: 5; }.courtyard { fill: #e5d7bc; stroke: #9c8562; stroke-width: 3; }
      .temple-ground { fill: #ead8b8; stroke: #8b3e32; stroke-width: 5; }.temple-wall { fill: none; stroke: #8f382e; stroke-width: 10; stroke-linecap: square; stroke-linejoin: round; }
      .temple-courtyard { fill: #f0dfc2; stroke: #b77b55; stroke-width: 3; }.temple-incense-burner { fill: #7e392f; stroke: #482821; stroke-width: 3; }
      .temple-entry-path { fill: none; stroke: #aa684d; stroke-width: 9; stroke-dasharray: 5 6; }.temple-label { font-size: 25px; font-weight: 800; fill: #7d2f28; stroke: #f0e1c7; stroke-width: 5px; paint-order: stroke fill; }
      .generated-landmark-art { pointer-events: none; opacity: .64; filter: saturate(.42) contrast(.76) brightness(1.16) sepia(.18); }
      .building-vector-underlay { opacity: .34; }
      .generated-building-art { pointer-events: none; opacity: .62; filter: saturate(.42) contrast(.76) brightness(1.16) sepia(.18); }
      .generated-building-feature .building-shadow { opacity: .15; }
      .generated-building-feature .building-platform { fill-opacity: .78; stroke-width: 2.5; }
      .generated-building-feature .building-vector-underlay { opacity: .24; }
      .generated-building-feature .building-vector-underlay .roof-tile-line,
      .generated-building-feature .building-vector-underlay .roof-ridge,
      .generated-building-feature .building-vector-underlay .hip-ridge,
      .generated-building-feature .building-vector-underlay .door,
      .generated-building-feature .building-vector-underlay .shop-awning,
      .generated-building-feature .building-vector-underlay .awning-post,
      .generated-building-feature .building-vector-underlay .stable-partition,
      .generated-building-feature .building-vector-underlay .timber-posts,
      .generated-building-feature .building-vector-underlay .workshop-hearth,
      .generated-building-feature .building-vector-underlay .work-bench { opacity: 0; }
      .generated-building-feature.yamen .building-platform { stroke: #9b6252; }
      .generated-landmark-feature.yamen .building-platform { stroke: #8f5146; stroke-width: 4.5; }
      .generated-landmark-feature.market-office .building-platform { stroke: #55766a; stroke-width: 4.5; }
      .generated-building-feature.barracks .generated-building-art { filter: saturate(.34) contrast(.76) brightness(1.17) sepia(.12); }
      .generated-building-feature.granary .generated-building-art { filter: saturate(.40) contrast(.77) brightness(1.15) sepia(.24); }
      .generated-building-feature.stable .generated-building-art { filter: saturate(.44) contrast(.78) brightness(1.13) sepia(.25); }
      .generated-building-feature.workshop .generated-building-art { filter: saturate(.38) contrast(.82) brightness(1.10) sepia(.20); }
      .generated-building-feature.market .generated-building-art { filter: saturate(.54) contrast(.78) brightness(1.13) sepia(.16); }
      .generated-building-feature.residence .generated-building-art { filter: saturate(.38) contrast(.74) brightness(1.18) sepia(.18); }
      .building-feature .generated-landmark-art { opacity: .62; }
      .generated-yamen-hall { opacity: .60; }.generated-chenghuang-temple { opacity: .64; }
      .generated-city-gatehouse { opacity: .60; }.generated-jincheng-gatehouse { opacity: .64; }
      .generated-city-wall-tower { opacity: .62; }.generated-yellow-river-pontoon { opacity: .66; }
      .generated-market-office-hall { opacity: .60; }.generated-market-storehouse { opacity: .58; }
      .bridge-rope-shadow { fill: none; stroke: #29444b; stroke-width: 78; opacity: .22; }
      .bridge-boat { fill: #5f4733; stroke: #34281f; stroke-width: 5; }.bridge-boat-rib { stroke: #b99d73; stroke-width: 4; }
      .bridge-deck { fill: none; stroke: #8d704e; stroke-width: 46; stroke-linecap: round; }
      .bridge-plank { stroke: #d0b17a; stroke-width: 8; stroke-linecap: round; }.bridge-rail { fill: none; stroke: #513d2a; stroke-width: 6; stroke-dasharray: 18 12; }
      .bridge-vector-underlay { opacity: .32; }
      .tree-shadow { fill: #4a4734; opacity: .22; }.tree circle { stroke: #4f613f; stroke-width: 2.4; }
      .map-title text:first-child { font-size: 78px; font-weight: 700; letter-spacing: 12px; }.map-subtitle { font-size: 29px; letter-spacing: 3px; }
      .water-label { font-size: 66px; font-style: italic; fill: #e7f0eb; stroke: #4f7f8c; stroke-width: 8px; opacity: .9; }
      .place-label { font-size: 34px; font-weight: 650; }.place-label.strong { font-size: 46px; }.small-label { font-size: 24px; }
      .district-label { font-size: 42px; letter-spacing: 9px; opacity: .46; }.ruin-label { font-size: 40px; fill: #765f42; stroke: #e5d8bd; opacity: .8; letter-spacing: 7px; }
      .gate-label { font-size: 24px; fill: #684c35; }.terrain-label { font-size: 34px; fill: #6f664c; stroke: #d3c5a5; opacity: .72; letter-spacing: 6px; }
      .place-label.muted { opacity: .7; }.water-note { fill: #e4efeb; stroke: #4d7d88; }.north-arrow path { fill: #594a34; stroke: #e5d8bd; stroke-width: 5; }.north-arrow line { stroke: #594a34; stroke-width: 8; }.north-arrow text { font-size: 32px; font-weight: 700; }
      .scale text { font-size: 22px; stroke-width: 3px; }.scale path { fill: none; stroke: #4f4332; stroke-width: 5; }.scale-dark { fill: #554833; }.scale-light { fill: #e8dcc2; stroke: #554833; stroke-width: 4; }
      .map-label-hidden { display: none !important; }
      svg[data-zoom-tier="overview"] [data-map-importance="detail"] { opacity: .48; }
      svg[data-zoom-tier="overview"] [data-map-importance="secondary"] { opacity: .76; }
      svg[data-zoom-tier="overview"] [data-map-importance="detail"] .roof-tile-line,
      svg[data-zoom-tier="overview"] [data-map-importance="detail"] .door,
      svg[data-zoom-tier="overview"] .road.alley { display: none; }
      svg[data-zoom-tier="overview"] #layer-parcels { opacity: .58; }
      svg[data-zoom-tier="overview"] .road.lane { opacity: .58; }
      svg[data-zoom-tier="mid"] [data-map-importance="detail"] { opacity: .82; }
      svg[data-zoom-tier="detail"] .place-label { font-size: 18px; stroke-width: 3px; }
      svg[data-zoom-tier="detail"] .small-label,
      svg[data-zoom-tier="detail"] .gate-label,
      svg[data-zoom-tier="detail"] .temple-label { font-size: 15px; stroke-width: 3px; }
    </style>
  </defs>

  <g id="layer-base" data-layer="base">
  <g id="layer-terrain" data-layer="terrain">
    <rect width="6000" height="5000" fill="url(#paper-gradient)"/>
    <rect width="6000" height="5000" fill="url(#paper-fiber)"/>
    ${generatedTerrainOverlay(artAssets, '<rect width="6000" height="5000" fill="url(#generated-loess-terrain)" opacity=".14" class="generated-terrain-texture"/>')}
    <path d="M0 0 H6000 V670 C5560 610 5320 710 5000 670 C4660 625 4450 520 4160 595 C3840 680 3590 780 3260 724 C2920 666 2650 540 2330 615 C1940 705 1750 620 1410 570 C1030 515 760 650 430 610 C250 588 115 548 0 520 Z" class="mountain-face"/>
    <path d="M0 360 C590 220 1020 470 1480 380 C1960 290 2280 470 2660 395 L2710 615 C2190 730 1810 600 1400 565 C880 520 510 670 0 520 Z" class="mountain-light"/>
    <path d="M3260 724 C3630 610 3890 430 4310 380 C4760 330 5230 550 6000 420 V0 H3040 Z" class="mountain-light" opacity=".38"/>
    <path d="M0 5000 H6000 V3570 C5520 3450 5130 3660 4680 3580 C4290 3510 4030 3370 3700 3500 C3370 3630 3090 3770 2750 3700 C2380 3625 2130 3470 1780 3570 C1350 3695 940 3560 560 3660 C320 3720 145 3820 0 3880 Z" class="mountain-face"/>
    <path d="M0 4240 C580 3860 1080 4040 1570 3870 C2050 3700 2340 3860 2770 3750 L2720 5000 H0 Z" class="mountain-light"/>
    <path d="M3730 3510 C4140 3350 4460 3720 4870 3650 C5320 3570 5580 3460 6000 3600 V5000 H3600 Z" class="mountain-light" opacity=".55"/>
    <path d="M140 330 C650 250 990 420 1430 360 M420 485 C890 410 1180 520 1640 485 M3570 300 C4080 190 4540 360 5020 300 M3970 510 C4500 420 5050 590 5610 490" class="terrain-contour"/>
    <path d="M180 4020 C720 3800 1190 3990 1660 3800 M460 4300 C1060 4070 1580 4260 2180 4010 M3880 3790 C4340 3600 4900 3850 5530 3700 M4150 4140 C4700 3940 5290 4120 5840 3990" class="terrain-contour"/>
    <path d="M2640 160 C2570 350 2490 530 2410 710 M3180 100 C3250 300 3230 490 3160 700 M1310 3900 C1510 4150 1580 4450 1620 4860 M4470 3630 C4280 3950 4210 4280 4220 4740" class="gully"/>
    <path d="M2025 1575 L3835 1495 L4070 2870 L2140 3060 Z" class="city-ground"/>
    ${generatedTerrainOverlay(artAssets, '<path d="M2025 1575 L3835 1495 L4070 2870 L2140 3060 Z" fill="url(#generated-loess-terrain)" opacity=".12" class="generated-terrain-texture"/>')}
  </g>

  <g id="layer-ruins" data-layer="ruins">
    <path d="M2050 3070 C2500 3160 3320 3140 4040 3035 M4040 3035 C4100 3230 4090 3430 4010 3580 M4010 3580 C3450 3660 2770 3690 2110 3600 M2110 3600 C2050 3410 2030 3230 2050 3070" class="ruin-wall"/>
    <path d="M2050 3070 C2500 3160 3320 3140 4040 3035 M4040 3035 C4100 3230 4090 3430 4010 3580 M4010 3580 C3450 3660 2770 3690 2110 3600 M2110 3600 C2050 3410 2030 3230 2050 3070" class="ruin-crown"/>
    <path d="M2250 3220 L2700 3260 L2680 3460 L2280 3430 Z" class="ruin-foundation"/>
    <path d="M2930 3200 L3370 3190 L3420 3440 L2960 3460 Z" class="ruin-foundation"/>
    <path d="M3590 3145 L3920 3110 L3930 3390 L3600 3415 Z" class="ruin-foundation"/>
    <path d="M2630 3540 C2950 3500 3270 3510 3590 3470" class="ruin-crown"/>
    <g fill="#887456" opacity=".58">
      <circle cx="2160" cy="3120" r="18"/><circle cx="2300" cy="3150" r="13"/><circle cx="2780" cy="3210" r="17"/>
      <circle cx="3450" cy="3150" r="15"/><circle cx="3970" cy="3100" r="19"/><circle cx="4050" cy="3300" r="13"/>
      <circle cx="3930" cy="3540" r="17"/><circle cx="3300" cy="3610" r="15"/><circle cx="2700" cy="3600" r="14"/>
    </g>
  </g>

  <g id="layer-roads" data-layer="roads">
    ${createRoadsLayer()}
  </g>
  ${createParcelsLayer()}

  <g id="layer-vegetation" data-layer="vegetation">
    ${seededVegetation()}
    <g class="reed-beds" fill="#758258" opacity=".68">
      <path d="M220 1390 l8 -70 10 65 15 -86 5 91 22 -65 1 84 Z"/><path d="M1880 1450 l8 -76 11 68 15 -92 7 90 18 -63 4 75 Z"/>
      <path d="M4730 1310 l8 -72 10 64 15 -86 6 82 20 -62 2 75 Z"/><path d="M5480 1260 l8 -68 10 62 14 -82 7 77 19 -59 2 72 Z"/>
    </g>
  </g>
  </g>

  <g id="layer-liquid" data-layer="liquid">
    <g id="layer-water" data-layer="water">
      <path d="M0 846 C650 775 1180 1005 1800 910 C2350 826 2800 758 3348 868 C3890 976 4310 712 4895 780 C5380 838 5650 718 6000 760 L6000 1242 C5510 1178 5230 1325 4705 1253 C4200 1182 3855 1392 3330 1292 C2850 1200 2470 1290 1950 1392 C1360 1505 690 1228 0 1322 Z" fill="url(#river-gradient)"/>
      ${artAssets?.yellowRiverUrl ? '<path d="M0 846 C650 775 1180 1005 1800 910 C2350 826 2800 758 3348 868 C3890 976 4310 712 4895 780 C5380 838 5650 718 6000 760 L6000 1242 C5510 1178 5230 1325 4705 1253 C4200 1182 3855 1392 3330 1292 C2850 1200 2470 1290 1950 1392 C1360 1505 690 1228 0 1322 Z" fill="url(#generated-yellow-river)" opacity=".24" class="generated-river-texture"/>' : ''}
      <path d="M0 846 C650 775 1180 1005 1800 910 C2350 826 2800 758 3348 868 C3890 976 4310 712 4895 780 C5380 838 5650 718 6000 760" class="river-inner-bank"/>
      <path d="M6000 1242 C5510 1178 5230 1325 4705 1253 C4200 1182 3855 1392 3330 1292 C2850 1200 2470 1290 1950 1392 C1360 1505 690 1228 0 1322" class="river-inner-bank"/>
      <path d="M0 846 C650 775 1180 1005 1800 910 C2350 826 2800 758 3348 868 C3890 976 4310 712 4895 780 C5380 838 5650 718 6000 760" class="river-bank"/>
      <path d="M6000 1242 C5510 1178 5230 1325 4705 1253 C4200 1182 3855 1392 3330 1292 C2850 1200 2470 1290 1950 1392 C1360 1505 690 1228 0 1322" class="river-bank"/>
      <path d="M260 1050 C620 960 980 1140 1360 1060 M1600 1160 C2060 1070 2370 1180 2710 1070 M3770 1110 C4200 1000 4500 1110 4870 1015 M5060 1040 C5360 980 5620 1040 5880 960" class="water-current"/>
      <path d="M1120 1115 C1370 1060 1600 1110 1780 1190 C1550 1260 1290 1250 1050 1190 Z" class="sandbar"/>
      <path d="M4140 910 C4370 830 4590 845 4780 910 C4580 980 4360 990 4170 955 Z" class="sandbar"/>
      <path d="M2500 1035 C2670 990 2820 1025 2950 1090 C2760 1140 2600 1130 2460 1080 Z" class="sandbar" opacity=".72"/>
    </g>
  </g>

  ${createDestructibleLayer(artAssets)}

  <g id="layer-damage" data-layer="damage"></g>
  <g id="layer-flood" data-layer="flood"></g>

  ${createLabelsLayer()}
</svg>`;
}

const riverTopSegments = [
  [[0, 846], [650, 775], [1180, 1005], [1800, 910]],
  [[1800, 910], [2350, 826], [2800, 758], [3348, 868]],
  [[3348, 868], [3890, 976], [4310, 712], [4895, 780]],
  [[4895, 780], [5380, 838], [5650, 718], [6000, 760]],
];
const riverBottomSegments = [
  [[6000, 1242], [5510, 1178], [5230, 1325], [4705, 1253]],
  [[4705, 1253], [4200, 1182], [3855, 1392], [3330, 1292]],
  [[3330, 1292], [2850, 1200], [2470, 1290], [1950, 1392]],
  [[1950, 1392], [1360, 1505], [690, 1228], [0, 1322]],
];

function sampleCurveSegments(segments, samplesPerSegment = 6) {
  const points = [];
  segments.forEach((segment, segmentIndex) => {
    for (let sample = segmentIndex === 0 ? 0 : 1; sample <= samplesPerSegment; sample += 1) {
      const point = cubicPoint(segment, sample / samplesPerSegment);
      points.push([round(point[0]), round(point[1])]);
    }
  });
  return points;
}

function riverBodyPolygon() {
  return Object.freeze([
    ...sampleCurveSegments(riverTopSegments).map((point) => Object.freeze(point)),
    ...sampleCurveSegments(riverBottomSegments).map((point) => Object.freeze(point)),
  ]);
}

function normalizeArtAssets(artAssets = {}) {
  const buildingSpriteGroups = [
    'yamenGate',
    'yamenSideHall',
    'barracks',
    'granary',
    'stable',
    'workshop',
    'marketShop',
    'residenceHouse',
    'residenceCourtyard',
  ];
  const buildingSprites = Object.freeze(Object.fromEntries(
    buildingSpriteGroups.map((groupName) => [
      groupName,
      Object.freeze((artAssets.buildingSprites?.[groupName] || [])
        .filter(Boolean)
        .map((url) => String(url))),
    ]),
  ));
  const rubbleAtlas = artAssets.rubbleAtlas?.url ? Object.freeze({
    url: String(artAssets.rubbleAtlas.url),
    width: Number(artAssets.rubbleAtlas.width) || 1536,
    height: Number(artAssets.rubbleAtlas.height) || 1024,
    columns: Number(artAssets.rubbleAtlas.columns) || 3,
    rows: Number(artAssets.rubbleAtlas.rows) || 2,
  }) : null;
  return Object.freeze({
    chenghuangTempleUrl: artAssets.chenghuangTempleUrl ? String(artAssets.chenghuangTempleUrl) : null,
    cityGatehouseUrl: artAssets.cityGatehouseUrl ? String(artAssets.cityGatehouseUrl) : null,
    cityWallTowerUrl: artAssets.cityWallTowerUrl ? String(artAssets.cityWallTowerUrl) : null,
    jinchengGatehouseUrl: artAssets.jinchengGatehouseUrl ? String(artAssets.jinchengGatehouseUrl) : null,
    loessTerrainUrl: artAssets.loessTerrainUrl ? String(artAssets.loessTerrainUrl) : null,
    marketOfficeHallUrl: artAssets.marketOfficeHallUrl ? String(artAssets.marketOfficeHallUrl) : null,
    marketStorehouseUrl: artAssets.marketStorehouseUrl ? String(artAssets.marketStorehouseUrl) : null,
    yamenHallUrl: artAssets.yamenHallUrl ? String(artAssets.yamenHallUrl) : null,
    yellowRiverPontoonUrl: artAssets.yellowRiverPontoonUrl ? String(artAssets.yellowRiverPontoonUrl) : null,
    yellowRiverUrl: artAssets.yellowRiverUrl ? String(artAssets.yellowRiverUrl) : null,
    buildingSprites,
    rubbleAtlas,
  });
}

export function createLanzhouMapPackage(artAssets = {}) {
  const normalizedArtAssets = normalizeArtAssets(artAssets);
  const createSvg = () => createLanzhouSvg(normalizedArtAssets);
  return Object.freeze({
    id: BUILT_IN_LANZHOU_MAP.id,
    title: BUILT_IN_LANZHOU_MAP.title,
    name: '北宋兰州城（1104）',
    version: BUILT_IN_LANZHOU_MAP.version,
    compatibleMapVersions: Object.freeze(['1.0.0', '1.0.1', '1.0.2', '1.0.3', '1.0.4']),
    period: '北宋·崇宁三年（1104）',
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    metersPerUnit: 1,
    defaultPreferences: Object.freeze({
      snapMeters: 5,
      gridVisible: true,
    }),
    viewBox: `0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`,
    initialView: Object.freeze([250, 150, 5750, 4700]),
    layers: Object.freeze([
      'base',
      'liquid',
      'destructible',
      'damage',
      'flood',
      'labels',
    ]),
    features: publicFeatures,
    roadBuffers: roadBufferFeatures,
    roadRules: ROAD_RULES,
    navigation: Object.freeze({
      cellSizeMeters: 10,
      roads: navigationRoads,
      gateways: navigationGateways,
      bridgeFeatureIds: Object.freeze(['yellow-river-pontoon-bridge']),
    }),
    floodRules: Object.freeze({
      maxInflowGapMeters: 12,
      inletWidthMeters: 6,
      propagationGapMeters: 1,
    }),
    featureCount: publicFeatures.length,
    destructibleCategories: Object.freeze(['building', 'wall', 'vegetation', 'bridge', 'terrain']),
    liquidBodies: Object.freeze([
      Object.freeze({
        id: 'yellow-river',
        name: '黄河',
        polygon: riverBodyPolygon(),
      }),
    ]),
    artAssets: normalizedArtAssets,
    svg: createSvg(),
    createSvg,
  });
}

export const lanzhouMapPackage = createLanzhouMapPackage();
