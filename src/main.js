import 'leaflet/dist/leaflet.css';
import './styles.css';
import barracks01Url from './assets/generated/barracks-01.webp';
import barracks02Url from './assets/generated/barracks-02.webp';
import chenghuangTempleUrl from './assets/generated/chenghuang-temple.webp';
import cityGatehouseUrl from './assets/generated/city-gatehouse.webp';
import cityWallTowerUrl from './assets/generated/city-wall-tower.webp';
import granary01Url from './assets/generated/granary-01.webp';
import granary02Url from './assets/generated/granary-02.webp';
import jinchengGatehouseUrl from './assets/generated/jincheng-gatehouse.webp';
import loessTerrainUrl from './assets/generated/loess-terrain.webp';
import marketOfficeHallUrl from './assets/generated/market-office-hall.webp';
import marketShop01Url from './assets/generated/market-shop-01.webp';
import marketShop02Url from './assets/generated/market-shop-02.webp';
import marketShop03Url from './assets/generated/market-shop-03.webp';
import marketStorehouseUrl from './assets/generated/market-storehouse.webp';
import residenceCourtyard01Url from './assets/generated/residence-courtyard-01.webp';
import residenceCourtyard02Url from './assets/generated/residence-courtyard-02.webp';
import residenceHouse01Url from './assets/generated/residence-house-01.webp';
import residenceHouse02Url from './assets/generated/residence-house-02.webp';
import residenceHouse03Url from './assets/generated/residence-house-03.webp';
import rubbleAtlasUrl from './assets/generated/rubble-atlas.webp';
import stable01Url from './assets/generated/stable-01.webp';
import stable02Url from './assets/generated/stable-02.webp';
import workshop01Url from './assets/generated/workshop-01.webp';
import workshop02Url from './assets/generated/workshop-02.webp';
import yamenGateUrl from './assets/generated/yamen-gate.webp';
import yamenHallUrl from './assets/generated/yamen-hall.webp';
import yamenSideHallUrl from './assets/generated/yamen-side-hall.webp';
import yellowRiverPontoonUrl from './assets/generated/yellow-river-pontoon.webp';
import yellowRiverUrl from './assets/generated/yellow-river.webp';
import { createRpgMapApp } from './engine/app.js';
import { createMovementSystem } from './movement/index.js';
import { createMeasurementSystem } from './measurement/index.js';
import { createEntitySystem } from './entities/index.js';
import { createAppShellUi } from './ui/index.js';
import { createSelectionSystem } from './selection/index.js';
import { createCombatSystem } from './combat/index.js';
import { createLanzhouMapPackage } from './maps/lanzhou.js';
import { cleanMapPackagePresentation } from './maps/presentation-cleanup.js';

const mapPackage = cleanMapPackagePresentation(createLanzhouMapPackage({
  chenghuangTempleUrl, cityGatehouseUrl, cityWallTowerUrl, jinchengGatehouseUrl, loessTerrainUrl,
  marketOfficeHallUrl, marketStorehouseUrl, yamenHallUrl, yellowRiverPontoonUrl, yellowRiverUrl,
  buildingSprites: {
    yamenGate: [yamenGateUrl], yamenSideHall: [yamenSideHallUrl], barracks: [barracks01Url, barracks02Url],
    granary: [granary01Url, granary02Url], stable: [stable01Url, stable02Url], workshop: [workshop01Url, workshop02Url],
    marketShop: [marketShop01Url, marketShop02Url, marketShop03Url], residenceHouse: [residenceHouse01Url, residenceHouse02Url, residenceHouse03Url],
    residenceCourtyard: [residenceCourtyard01Url, residenceCourtyard02Url],
  },
  rubbleAtlas: { url: rubbleAtlasUrl, width: 1536, height: 1024, columns: 3, rows: 2 },
}));

const selectionSystem = createSelectionSystem();

createRpgMapApp({
  container: document.getElementById('app'),
  mapPackage,
  tools: [
    createMovementSystem({ defaultStep: 5, autoStep: true }),
    createEntitySystem({ dropLegacyMarkers: true }),
    createAppShellUi(),
    createMeasurementSystem(),
    selectionSystem,
    createCombatSystem({ selection: selectionSystem })
  ]
});
