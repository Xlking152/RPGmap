import barracks01Url from './assets/barracks-01.webp';
import barracks02Url from './assets/barracks-02.webp';
import chenghuangTempleUrl from './assets/chenghuang-temple.webp';
import cityGatehouseUrl from './assets/city-gatehouse.webp';
import cityWallTowerUrl from './assets/city-wall-tower.webp';
import granary01Url from './assets/granary-01.webp';
import granary02Url from './assets/granary-02.webp';
import jinchengGatehouseUrl from './assets/jincheng-gatehouse.webp';
import loessTerrainUrl from './assets/loess-terrain.webp';
import marketOfficeHallUrl from './assets/market-office-hall.webp';
import marketShop01Url from './assets/market-shop-01.webp';
import marketShop02Url from './assets/market-shop-02.webp';
import marketShop03Url from './assets/market-shop-03.webp';
import marketStorehouseUrl from './assets/market-storehouse.webp';
import residenceCourtyard01Url from './assets/residence-courtyard-01.webp';
import residenceCourtyard02Url from './assets/residence-courtyard-02.webp';
import residenceHouse01Url from './assets/residence-house-01.webp';
import residenceHouse02Url from './assets/residence-house-02.webp';
import residenceHouse03Url from './assets/residence-house-03.webp';
import rubbleAtlasUrl from './assets/rubble-atlas.webp';
import stable01Url from './assets/stable-01.webp';
import stable02Url from './assets/stable-02.webp';
import workshop01Url from './assets/workshop-01.webp';
import workshop02Url from './assets/workshop-02.webp';
import yamenGateUrl from './assets/yamen-gate.webp';
import yamenHallUrl from './assets/yamen-hall.webp';
import yamenSideHallUrl from './assets/yamen-side-hall.webp';
import yellowRiverPontoonUrl from './assets/yellow-river-pontoon.webp';
import yellowRiverUrl from './assets/yellow-river.webp';
import { createLanzhouMapPackage } from './package.js';
import { cleanMapPackagePresentation } from './presentation.js';

export const LANZHOU_LAYER_PLAN = Object.freeze([
  { id: 'base', role: 'base', sourceLayers: ['base'], description: '纸张、基础背景与不可交互底图' },
  { id: 'terrain', role: 'terrain', sourceLayers: ['base'], description: '当前兰州参考图的地表/山体与 base 同源；新地图建议独立 terrain layer' },
  { id: 'liquid', role: 'liquid', sourceLayers: ['liquid'], description: '黄河等液体区域' },
  { id: 'special', role: 'special', sourceLayers: ['damage', 'flood'], description: '破坏覆盖、洪水等运行时特殊表现' },
  { id: 'destructible', role: 'destructible', sourceLayers: ['destructible'], description: '建筑、城墙、桥梁、植被、地形等可破坏 Feature' },
  { id: 'labels', role: 'labels', sourceLayers: ['labels'], description: '地图文字与说明' },
]);

function generatedArtAssets() {
  return {
    chenghuangTempleUrl,
    cityGatehouseUrl,
    cityWallTowerUrl,
    jinchengGatehouseUrl,
    loessTerrainUrl,
    marketOfficeHallUrl,
    marketStorehouseUrl,
    yamenHallUrl,
    yellowRiverPontoonUrl,
    yellowRiverUrl,
    buildingSprites: {
      yamenGate: [yamenGateUrl],
      yamenSideHall: [yamenSideHallUrl],
      barracks: [barracks01Url, barracks02Url],
      granary: [granary01Url, granary02Url],
      stable: [stable01Url, stable02Url],
      workshop: [workshop01Url, workshop02Url],
      marketShop: [marketShop01Url, marketShop02Url, marketShop03Url],
      residenceHouse: [residenceHouse01Url, residenceHouse02Url, residenceHouse03Url],
      residenceCourtyard: [residenceCourtyard01Url, residenceCourtyard02Url],
    },
    rubbleAtlas: { url: rubbleAtlasUrl, width: 1536, height: 1024, columns: 3, rows: 2 },
  };
}

export function createLanzhouReferencePackage({ generatedArt = true } = {}) {
  const source = createLanzhouMapPackage(generatedArt ? generatedArtAssets() : {});
  return cleanMapPackagePresentation({
    ...source,
    layerPlan: LANZHOU_LAYER_PLAN,
    reference: {
      kind: 'reference-map',
      mapFamily: 'lanzhou',
      note: 'Map-specific data and rendering only; interaction/destruction/state logic belongs to RPGmap Core.',
    },
  });
}

export * from './package.js';
export * from './presentation.js';
