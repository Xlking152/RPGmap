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

export function createLanzhouGeneratedArtAssets() {
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
