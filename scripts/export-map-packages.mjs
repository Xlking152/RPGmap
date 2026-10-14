import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMapArchive, inspectMapArchive, mapFileHash } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = process.argv.indexOf('--out');
if (option >= 0 && !process.argv[option + 1]) throw new Error('--out requires a directory');
const { version: applicationVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(option >= 0 ? process.argv[option + 1] : path.join(root, 'release', `RPGmap-v${applicationVersion}-验收`));
await mkdir(output, { recursive: true });
let sourceCommit = 'uncommitted';
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}

// Read the checked-in v2.5.5 runtime receipts, rather than generating a different map.
const source = path.join(root, 'maps', 'lanzhou');
const assetsSource = await readFile(path.join(source, 'assets.js'), 'utf8');
const imported = new Map([...assetsSource.matchAll(/import\s+(\w+)\s+from\s+'\.\/(assets\/[^']+)'/g)].map(match => [match[1], match[2]]));
const artAssets = {};
for (const [variable, resource] of imported) {
  if (/^(chenghuangTemple|cityGatehouse|cityWallTower|jinchengGatehouse|loessTerrain|marketOfficeHall|marketStorehouse|yamenHall|yellowRiverPontoon|yellowRiver)Url$/.test(variable)) artAssets[variable] = resource;
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
const data = JSON.parse(await readFile(path.join(source, 'runtime.json'), 'utf8'));
data.artAssets = artAssets;
const template = await readFile(path.join(source, 'runtime.svg'), 'utf8');
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
assets.set('README.md', Buffer.from('北宋兰州城：v2.5.5 的 1.1.0 地图内容。请在 RPGmap 启动器的地图管理页导入此文件；导入不会更改既有场景。\n'));

const packages = [
  { filename: `北宋兰州城-${data.version}.rpgmap`, data, svg, assets },
  { filename: '验收附件/最小测试地图-1.2.0.rpgmap', data: createMinimalReferencePackage(), assets: new Map() },
];
const receipts = [];
for (const candidate of packages) {
  const bytes = buildMapArchive({ ...candidate, metadata: { author: 'RPGmap', sourceCommit } });
  const inspected = inspectMapArchive(bytes);
  const target = path.join(output, ...candidate.filename.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  const receipt = { filename: candidate.filename, id: inspected.manifest.id, version: inspected.manifest.version,
    fingerprint: inspected.fingerprint, sha256: mapFileHash(bytes), size: bytes.length, sourceCommit };
  receipts.push(receipt);
  console.log(`Exported ${candidate.filename} (${bytes.length} bytes; ${inspected.data.features.length} features)`);
}
await writeFile(path.join(output, '地图打包记录.json'), JSON.stringify({ formatVersion: 1, packages: receipts }, null, 2));
