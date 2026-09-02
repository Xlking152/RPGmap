import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLanzhouSvg } from '../reference/maps/lanzhou/package.js';
import { createLanzhouMapData } from '../reference/maps/lanzhou/package.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import {
  LANZHOU_FEATURE_TAXONOMY,
  LANZHOU_LAYER_PLAN,
  LANZHOU_REFERENCE_META,
} from '../reference/maps/lanzhou/manifest.js';
import { cleanMapPackagePresentation } from '../reference/maps/lanzhou/presentation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = name => `__RPGMAP_ASSET_${name}__`;
const artAssets = {
  chenghuangTempleUrl: token('chenghuangTempleUrl'),
  cityGatehouseUrl: token('cityGatehouseUrl'),
  cityWallTowerUrl: token('cityWallTowerUrl'),
  jinchengGatehouseUrl: token('jinchengGatehouseUrl'),
  loessTerrainUrl: token('loessTerrainUrl'),
  marketOfficeHallUrl: token('marketOfficeHallUrl'),
  marketStorehouseUrl: token('marketStorehouseUrl'),
  yamenHallUrl: token('yamenHallUrl'),
  yellowRiverPontoonUrl: token('yellowRiverPontoonUrl'),
  yellowRiverUrl: token('yellowRiverUrl'),
  buildingSprites: {
    yamenGate: [token('buildingSprites.yamenGate.0')],
    yamenSideHall: [token('buildingSprites.yamenSideHall.0')],
    barracks: [token('buildingSprites.barracks.0'), token('buildingSprites.barracks.1')],
    granary: [token('buildingSprites.granary.0'), token('buildingSprites.granary.1')],
    stable: [token('buildingSprites.stable.0'), token('buildingSprites.stable.1')],
    workshop: [token('buildingSprites.workshop.0'), token('buildingSprites.workshop.1')],
    marketShop: [
      token('buildingSprites.marketShop.0'),
      token('buildingSprites.marketShop.1'),
      token('buildingSprites.marketShop.2'),
    ],
    residenceHouse: [
      token('buildingSprites.residenceHouse.0'),
      token('buildingSprites.residenceHouse.1'),
      token('buildingSprites.residenceHouse.2'),
    ],
    residenceCourtyard: [
      token('buildingSprites.residenceCourtyard.0'),
      token('buildingSprites.residenceCourtyard.1'),
    ],
  },
  rubbleAtlas: { url: token('rubbleAtlas.url'), width: 1536, height: 1024, columns: 3, rows: 2 },
};

const output = path.join(root, 'reference', 'maps', 'lanzhou', 'runtime.svg');
await writeFile(output, createLanzhouSvg(artAssets), 'utf8');
console.log(`Generated ${path.relative(root, output)}`);

const source = createLanzhouMapData();
const runtimeData = cleanMapPackagePresentation({
  ...source,
  artAssets: undefined,
  features: applyLanzhouCapabilities(source.features, source.navigation),
  layerPlan: LANZHOU_LAYER_PLAN,
  featureTaxonomy: LANZHOU_FEATURE_TAXONOMY,
  reference: {
    ...LANZHOU_REFERENCE_META,
    note: 'Map-specific data/rendering only; interaction, destruction and Scene state belong to RPGmap Core.',
  },
});
const dataOutput = path.join(root, 'reference', 'maps', 'lanzhou', 'runtime.json');
await writeFile(dataOutput, JSON.stringify(runtimeData), 'utf8');
console.log(`Generated ${path.relative(root, dataOutput)}`);
