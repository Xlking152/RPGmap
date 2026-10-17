import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMapArchive, inspectMapArchive, mapFileHash } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { resolveLanzhouExportPreset, verifyLanzhouExportReceipt } from './map-export-presets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = process.argv.indexOf('--out');
if (option >= 0 && !process.argv[option + 1]) throw new Error('--out requires a directory');
const output = path.resolve(option >= 0 ? process.argv[option + 1] : path.join(root, 'artifact', 'content-packages'));
const versionOption = process.argv.indexOf('--map-version');
const requestedVersion = versionOption >= 0 ? process.argv[versionOption + 1] : null;
const preset = resolveLanzhouExportPreset(versionOption >= 0 ? requestedVersion : undefined);
let sourceCommit = 'uncommitted';
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}

// Published content is immutable. New art is available only as the explicit candidate version.
const source = path.join(root, 'maps', 'lanzhou');
const snapshotSource = preset.snapshot ? path.join(source, 'published', preset.snapshot) : null;
const artAssets = snapshotSource ? JSON.parse(await readFile(path.join(snapshotSource, 'art-assets.json'), 'utf8')) : {};
if (!snapshotSource) {
  const assetsSource = await readFile(path.join(source, 'assets.js'), 'utf8');
  const imported = new Map([...assetsSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/(assets\/[^']+)'/g)].map(match => [match[1], match[2]]));
  for (const [variable, resource] of imported) {
    if (/^(chenghuangTemple|cityGatehouse|cityWallTower|courtyardGround|jinchengGatehouse|loessTerrain|marketOfficeHall|marketStorehouse|streetPaving|treeCanopy|yamenHall|yellowRiverPontoon|yellowRiver)Url$/.test(variable)) artAssets[variable] = resource;
  }
  artAssets.buildingSprites = {};
  const spriteSource = assetsSource.match(/buildingSprites:\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!spriteSource) throw new Error('Cannot identify Lanzhou building sprite declaration');
  for (const match of spriteSource.matchAll(/(\w+):\s*\[([^\]]+)\]/g)) {
    artAssets.buildingSprites[match[1]] = match[2].split(',').map(value => {
      const resource = imported.get(value.trim());
      if (!resource) throw new Error(`Unresolved asset import: ${value}`);
      return resource;
    });
  }
  artAssets.rubbleAtlas = { url: imported.get('rubbleAtlasUrl'), width: 1536, height: 1024, columns: 3, rows: 2 };
}
const data = JSON.parse(await readFile(path.join(source, 'runtime.json'), 'utf8'));
const sourceMapVersion = data.version;
data.version = preset.version;
data.artAssets = artAssets;
const template = await readFile(path.join(snapshotSource || source, 'runtime.svg'), 'utf8');
const svg = template.replace(/__RPGMAP_ASSET_([A-Za-z0-9.]+)__/g, (_token, key) => {
  const resource = key.split('.').reduce((value, part) => value?.[part], artAssets);
  if (typeof resource !== 'string') throw new Error(`Missing runtime SVG asset ${key}`);
  return resource;
});
const resources = new Set();
function collect(value) {
  if (typeof value === 'string') resources.add(value);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
}
collect(artAssets);
const assets = new Map(await Promise.all([...resources].map(async resource => [resource, await readFile(path.join(source, ...resource.split('/')))])));
assets.set('README.md', snapshotSource ? await readFile(path.join(snapshotSource, 'README.md'))
  : Buffer.from(`北宋兰州城：${data.version} 地图内容。请在 RPGmap 启动器的地图管理页导入此文件；导入不会更改既有场景。\n`));

const packages = [
  { filename: `北宋兰州城-${data.version}.rpgmap`, data, svg, assets },
  ...(process.argv.includes('--fixtures') ? [
    { filename: 'fixtures/最小测试地图-1.2.0.rpgmap', data: createMinimalReferencePackage(), assets: new Map() },
  ] : []),
];
const receipts = [];
const prepared = packages.map(candidate => {
  const isLanzhou = candidate.data.id === data.id;
  const metadata = { author: 'RPGmap', sourceCommit, ...(isLanzhou && !preset.published ? { sourceMapVersion } : {}) };
  const bytes = buildMapArchive({ ...candidate, metadata });
  const inspected = inspectMapArchive(bytes);
  if (isLanzhou) verifyLanzhouExportReceipt(inspected, preset);
  return { candidate, bytes, inspected };
});
await mkdir(output, { recursive: true });
for (const { candidate, bytes, inspected } of prepared) {
  const target = path.join(output, ...candidate.filename.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const receipt = { filename: candidate.filename, id: inspected.manifest.id, version: inspected.manifest.version,
    fingerprint: inspected.fingerprint, sha256: mapFileHash(bytes), size: bytes.length, sourceCommit };
  receipts.push(receipt);
  console.log(`Exported ${candidate.filename} (${bytes.length} bytes; ${inspected.data.features.length} features)`);
}
await writeFile(path.join(output, '地图打包记录.json'), JSON.stringify({ formatVersion: 1, packages: receipts }, null, 2));
