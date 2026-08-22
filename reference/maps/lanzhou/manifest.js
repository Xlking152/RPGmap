export const LANZHOU_REFERENCE_ID = 'northern-song-lanzhou-1104';

export const LANZHOU_LAYER_PLAN = Object.freeze([
  { id: 'base', role: 'base', sourceLayers: ['base'], description: '纸张、基础背景与不可交互底图' },
  { id: 'terrain', role: 'terrain', sourceLayers: ['base'], description: '当前参考图的地表/山体仍与 base 同源；新地图建议独立 terrain layer' },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'], description: '黄河等液体区域' },
  { id: 'special', role: 'special', sourceLayers: ['damage', 'flood'], description: '破坏覆盖、洪水等运行时特殊表现' },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'], description: '建筑、城墙、桥梁、植被、地形等可破坏 Feature' },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'], description: '地图文字与说明' },
]);

export const LANZHOU_REFERENCE_META = Object.freeze({
  kind: 'reference-map',
  mapFamily: 'lanzhou',
  purpose: 'RPGmap MapPackage implementation reference',
});
