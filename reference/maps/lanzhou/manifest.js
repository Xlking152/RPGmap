import { DEFAULT_REFERENCE_MAP_ID } from '../../../src/map-package/constants.js';

export const LANZHOU_REFERENCE_ID = DEFAULT_REFERENCE_MAP_ID;

export const LANZHOU_LAYER_PLAN = Object.freeze([
  { id: 'base', role: 'base', sourceLayers: ['base'], description: '纸张、基础背景与不可交互底图父层' },
  {
    id: 'terrain',
    role: 'terrain',
    sourceLayers: ['terrain', 'ruins', 'roads', 'parcels', 'vegetation'],
    description: '地表、山体、遗迹、道路、街坊与装饰植被；这些物理子层当前仍嵌套在历史 base 父层中',
  },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'], description: '黄河等液体区域' },
  { id: 'special', role: 'special', sourceLayers: ['damage', 'flood'], description: '破坏覆盖、洪水等运行时特殊表现' },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'], description: '建筑、城墙、桥梁、植被、地形等可破坏 Feature' },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'], description: '地图文字与说明' },
]);

export const LANZHOU_FEATURE_TAXONOMY = Object.freeze({
  categories: Object.freeze({
    building: '建筑',
    wall: '城墙',
    vegetation: '植被',
    bridge: '桥梁',
    terrain: '地表',
    road: '道路',
    water: '水体',
  }),
  subtypes: Object.freeze({
    yamen: '州衙',
    barracks: '营房',
    granary: '仓廪',
    stable: '马厩',
    workshop: '工坊',
    'market-office': '市易务',
    market: '市肆',
    temple: '神祠',
    residence: '民居',
    wall: '城墙',
    'wall-tower': '角楼',
    gate: '城门',
    'pass-wall': '关墙',
    'pass-gate': '关楼',
    vegetation: '树木',
    bridge: '浮桥',
  }),
  detailFields: Object.freeze({
    use: '用途',
    structure: '构造',
    description: '说明',
  }),
});

export const LANZHOU_REFERENCE_META = Object.freeze({
  kind: 'reference-map',
  mapFamily: 'lanzhou',
  purpose: 'RPGmap MapPackage implementation reference',
});
