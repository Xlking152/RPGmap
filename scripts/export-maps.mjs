import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLanzhouMapPackage } from '../src/maps/lanzhou.js';
import { cleanMapDisplayText, cleanMapPackagePresentation } from '../src/maps/presentation-cleanup.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
export const DEFAULT_MAP_ID = 'northern-song-lanzhou-1104';

function runtimeAssetUrl(fileName) {
  return `/maps/${DEFAULT_MAP_ID}/assets/${fileName}`;
}

export function createSerializableDefaultMapPackage() {
  const artAssets = {
    chenghuangTempleUrl: runtimeAssetUrl('chenghuang-temple.webp'),
    cityGatehouseUrl: runtimeAssetUrl('city-gatehouse.webp'),
    cityWallTowerUrl: runtimeAssetUrl('city-wall-tower.webp'),
    jinchengGatehouseUrl: runtimeAssetUrl('jincheng-gatehouse.webp'),
    loessTerrainUrl: runtimeAssetUrl('loess-terrain.webp'),
    marketOfficeHallUrl: runtimeAssetUrl('market-office-hall.webp'),
    marketStorehouseUrl: runtimeAssetUrl('market-storehouse.webp'),
    yamenHallUrl: runtimeAssetUrl('yamen-hall.webp'),
    yellowRiverPontoonUrl: runtimeAssetUrl('yellow-river-pontoon.webp'),
    yellowRiverUrl: runtimeAssetUrl('yellow-river.webp'),
    buildingSprites: {
      yamenGate: [runtimeAssetUrl('yamen-gate.webp')],
      yamenSideHall: [runtimeAssetUrl('yamen-side-hall.webp')],
      barracks: [runtimeAssetUrl('barracks-01.webp'), runtimeAssetUrl('barracks-02.webp')],
      granary: [runtimeAssetUrl('granary-01.webp'), runtimeAssetUrl('granary-02.webp')],
      stable: [runtimeAssetUrl('stable-01.webp'), runtimeAssetUrl('stable-02.webp')],
      workshop: [runtimeAssetUrl('workshop-01.webp'), runtimeAssetUrl('workshop-02.webp')],
      marketShop: [runtimeAssetUrl('market-shop-01.webp'), runtimeAssetUrl('market-shop-02.webp'), runtimeAssetUrl('market-shop-03.webp')],
      residenceHouse: [runtimeAssetUrl('residence-house-01.webp'), runtimeAssetUrl('residence-house-02.webp'), runtimeAssetUrl('residence-house-03.webp')],
      residenceCourtyard: [runtimeAssetUrl('residence-courtyard-01.webp'), runtimeAssetUrl('residence-courtyard-02.webp')],
    },
    rubbleAtlas: {
      url: runtimeAssetUrl('rubble-atlas.webp'),
      width: 1536,
      height: 1024,
      columns: 3,
      rows: 2,
    },
  };

  const sourcePackage = createLanzhouMapPackage(artAssets);
  const cleaned = cleanMapPackagePresentation(sourcePackage);
  const { createSvg, ...serializable } = cleaned;
  return {
    ...serializable,
    svg: cleanMapDisplayText(sourcePackage.svg),
    packageFormat: 'rpgmap-map-v1',
    runtimeSource: 'external-maps-directory',
  };
}

export async function exportRuntimeMaps(outputRoot) {
  const mapsRoot = path.resolve(outputRoot);
  const mapRoot = path.join(mapsRoot, DEFAULT_MAP_ID);
  const assetsRoot = path.join(mapRoot, 'assets');
  await mkdir(assetsRoot, { recursive: true });

  const generatedAssets = path.join(REPO_ROOT, 'src', 'assets', 'generated');
  const assetNames = (await readdir(generatedAssets)).filter(name => name.toLowerCase().endsWith('.webp'));
  for (const name of assetNames) {
    await copyFile(path.join(generatedAssets, name), path.join(assetsRoot, name));
  }

  const mapPackage = createSerializableDefaultMapPackage();
  await writeFile(path.join(mapRoot, 'map.json'), `${JSON.stringify(mapPackage, null, 2)}\n`, 'utf8');
  await writeFile(path.join(mapRoot, 'README.txt'), [
    'RPGmap MapPackage',
    '',
    `Map ID: ${mapPackage.id}`,
    `Name  : ${mapPackage.name}`,
    `Version: ${mapPackage.version}`,
    '',
    'map.json 是地图定义与几何数据。',
    'assets/ 保存该地图使用的图像资源。',
    'World 中的破坏、角色、Combat 等运行状态不写回这里。',
    '',
  ].join('\n'), 'utf8');

  const registry = {
    schemaVersion: 1,
    defaultMapId: DEFAULT_MAP_ID,
    maps: [{
      id: mapPackage.id,
      name: mapPackage.name,
      title: mapPackage.title,
      version: mapPackage.version,
      manifest: `/maps/${DEFAULT_MAP_ID}/map.json`,
    }],
  };
  await writeFile(path.join(mapsRoot, 'index.json'), `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  return { mapsRoot, mapRoot, registry, mapPackage, assetCount: assetNames.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = process.argv[2];
  if (!outputRoot) {
    console.error('Usage: node scripts/export-maps.mjs <output-maps-directory>');
    process.exit(2);
  }
  const result = await exportRuntimeMaps(outputRoot);
  console.log(`[maps] exported ${result.mapPackage.id} with ${result.assetCount} assets -> ${result.mapRoot}`);
}
