import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentsByName = new Map(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  return separator < 0 ? [argument, ''] : [argument.slice(0, separator), argument.slice(separator + 1)];
}));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const root = path.resolve(argumentsByName.get('--root') || path.join(projectRoot, 'artifact', `RPGmap-v${packageJson.version}`));
const archive = path.resolve(argumentsByName.get('--archive') || `${root}.zip`);
const expectedCommit = String(argumentsByName.get('--commit') || '').trim().toLowerCase();
const checksumPath = `${archive}.sha256`;

const PR21_ZIP_BYTES = 5_734_666;
const MAX_ZIP_BYTES = Math.floor(PR21_ZIP_BYTES * 0.7);
const EXPECTED_ROOT_ENTRIES = [
  'VERSION.json',
  'access-control.mjs',
  'app',
  'docs',
  'http-runtime.mjs',
  'launcher.mjs',
  'map',
  'permissions-model.mjs',
  'portable-storage.mjs',
  'ruleset-authority.mjs',
  'server.mjs',
  'start-rpgmap.bat',
  'status-capabilities-v2.mjs',
  'status-operations.mjs',
  'world-operations.mjs',
  'movement-authority.mjs',
  'world-wal.mjs',
  'world-schema.mjs',
  'world-v2.mjs',
  'websocket-runtime.mjs',
];

function fail(message) {
  throw new Error(`Package verification failed: ${message}`);
}

async function entries(directory) {
  return (await readdir(directory, { withFileTypes: true }))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

async function requireFile(relative) {
  const info = await stat(path.join(root, ...relative.split('/'))).catch(() => null);
  if (!info?.isFile()) fail(`missing file ${relative}`);
}

async function requireEmptyDirectory(relative) {
  const directory = path.join(root, ...relative.split('/'));
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) fail(`missing directory ${relative}`);
  if ((await readdir(directory)).length) fail(`${relative} must be empty`);
}

const rootEntries = await entries(root);
const expectedRootEntries = [...EXPECTED_ROOT_ENTRIES].sort((left, right) => left.localeCompare(right, 'en'));
if (JSON.stringify(rootEntries) !== JSON.stringify(expectedRootEntries)) {
  fail(`unexpected root entries: ${rootEntries.join(', ')}`);
}
if ((await entries(path.join(root, 'docs'))).join(',') !== 'OPERATION-GUIDE.md') {
  fail('docs must contain only OPERATION-GUIDE.md');
}
if ((await entries(path.join(root, 'map'))).join(',') !== 'backups,uploads') {
  fail('map must contain only backups and uploads');
}
await requireEmptyDirectory('map/backups');
await requireEmptyDirectory('map/uploads');
await requireFile('docs/OPERATION-GUIDE.md');
await requireFile('app/index.html');
for (const file of EXPECTED_ROOT_ENTRIES.filter(name => name.endsWith('.mjs') || name.endsWith('.bat'))) {
  await requireFile(file);
}
if (rootEntries.filter(name => name.toLowerCase().endsWith('.bat')).length !== 1) fail('package must contain exactly one BAT');

for (const file of rootEntries.filter(name => name.endsWith('.mjs'))) {
  const source = await readFile(path.join(root, file), 'utf8');
  const specifiers = [
    ...source.matchAll(/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g),
  ].map(match => match[1]);
  for (const specifier of specifiers) {
    const target = path.resolve(root, path.dirname(file), specifier);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      fail(`${file} imports outside the package root: ${specifier}`);
    }
    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) fail(`${file} imports missing package module: ${specifier}`);
  }
}

const version = JSON.parse(await readFile(path.join(root, 'VERSION.json'), 'utf8'));
if (version.version !== packageJson.version || version.releaseTag !== `v${packageJson.version}`) {
  fail(`VERSION.json does not match package version ${packageJson.version}`);
}
if (version.worldSchema !== 3) fail(`VERSION.json worldSchema must be 3, received ${version.worldSchema}`);
if (version.operationSchema !== 3) fail(`VERSION.json operationSchema must be 3, received ${version.operationSchema}`);
if (version.statusSchema !== 4) fail(`VERSION.json statusSchema must be 4, received ${version.statusSchema}`);
if (version.accessSchema !== 4) fail(`VERSION.json accessSchema must be 4, received ${version.accessSchema}`);
if (!/^[0-9a-f]{40}$/i.test(String(version.commit || ''))) fail('VERSION.json commit must be a full Git commit');
if (expectedCommit && String(version.commit).toLowerCase() !== expectedCommit) {
  fail(`VERSION.json commit ${version.commit} does not match ${expectedCommit}`);
}

const manifestPath = path.join(root, 'app', '.vite', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const htmlEntry = manifest['index.html'];
const runtimeEntry = manifest['src/runtime/map-runtime.js'];
const defaultMapEntry = manifest['src/map-package/default-map.js'];
const lanzhouDataEntry = manifest['reference/maps/lanzhou/runtime.json'];
const lanzhouSvgEntry = manifest['reference/maps/lanzhou/runtime.svg'];
if (!htmlEntry?.isEntry) fail('manifest is missing index.html entry');
if (!runtimeEntry?.isDynamicEntry) fail('manifest is missing dynamic Map Runtime entry');
if (!defaultMapEntry?.isDynamicEntry) fail('manifest is missing dynamic Lanzhou MapPackage entry');
if (!lanzhouDataEntry?.file?.endsWith('.json')) fail('manifest is missing Lanzhou runtime data');
if (!lanzhouSvgEntry?.file?.endsWith('.svg')) fail('manifest is missing Lanzhou runtime SVG');
for (const key of ['src/runtime/map-runtime.js', 'src/map-package/default-map.js']) {
  if (!(htmlEntry.dynamicImports || []).includes(key)) fail(`index.html does not dynamically import ${key}`);
}

const visited = new Set();
async function verifyManifestRecord(key) {
  if (visited.has(key)) return;
  const record = manifest[key];
  if (!record) fail(`manifest references missing record ${key}`);
  visited.add(key);
  for (const relative of [record.file, ...(record.css || []), ...(record.assets || [])].filter(Boolean)) {
    await requireFile(`app/${relative}`);
  }
  for (const dependency of [...(record.imports || []), ...(record.dynamicImports || [])]) {
    await verifyManifestRecord(dependency);
  }
}
await verifyManifestRecord('index.html');

const lanzhouSources = Object.entries(manifest).filter(([key, record]) =>
  key.startsWith('reference/maps/lanzhou/assets/') && key.endsWith('.webp') && record?.file?.endsWith('.webp'));
if (lanzhouSources.length !== 29) fail(`manifest contains ${lanzhouSources.length} Lanzhou WebP assets instead of 29`);
const defaultAssets = new Set((defaultMapEntry.assets || []).filter(file => file.endsWith('.webp')));
if (defaultAssets.size !== 29) fail(`default MapPackage references ${defaultAssets.size} WebP assets instead of 29`);
for (const [, record] of lanzhouSources) {
  if (!defaultAssets.has(record.file)) fail(`default MapPackage does not reference ${record.file}`);
  await requireFile(`app/${record.file}`);
}
for (const record of [lanzhouDataEntry, lanzhouSvgEntry]) {
  if (!(defaultMapEntry.assets || []).includes(record.file)) fail(`default MapPackage does not reference ${record.file}`);
  await requireFile(`app/${record.file}`);
}

const archiveInfo = await stat(archive);
if (archiveInfo.size > MAX_ZIP_BYTES) fail(`ZIP is ${archiveInfo.size} bytes; limit is ${MAX_ZIP_BYTES}`);
const archiveHash = createHash('sha256').update(await readFile(archive)).digest('hex');
const checksum = (await readFile(checksumPath, 'utf8')).trim();
const checksumMatch = checksum.match(/^([0-9a-f]{64})\s+\*?([^\\/]+)$/i);
if (!checksumMatch || checksumMatch[1].toLowerCase() !== archiveHash || checksumMatch[2] !== path.basename(archive)) {
  fail('ZIP SHA-256 file does not match the archive');
}

const listingCommand = process.platform === 'win32'
  ? ['tar', ['-tf', archive]]
  : ['unzip', ['-Z1', archive]];
const listing = (await execFileAsync(listingCommand[0], listingCommand[1], { maxBuffer: 8 * 1024 * 1024 })).stdout
  .split(/\r?\n/)
  .map(value => value.replaceAll('\\', '/').replace(/^\.\//, ''))
  .filter(Boolean);
const archiveRoot = path.basename(root);
if (!listing.length || listing.some(item => item !== archiveRoot && !item.startsWith(`${archiveRoot}/`))) {
  fail('ZIP contains entries outside its versioned package root');
}
if (listing.some(item => item.includes('/reference/') || item.includes('/src/') || item.includes('/tests/'))) {
  fail('ZIP contains forbidden source or reference trees');
}

console.log(JSON.stringify({
  version: version.version,
  commit: version.commit,
  zipBytes: archiveInfo.size,
  baselineBytes: PR21_ZIP_BYTES,
  maximumBytes: MAX_ZIP_BYTES,
  reduction: 1 - archiveInfo.size / PR21_ZIP_BYTES,
  sha256: archiveHash,
  manifestRecords: visited.size,
  lanzhouWebpAssets: lanzhouSources.length,
  lanzhouRuntimeAssets: [lanzhouDataEntry.file, lanzhouSvgEntry.file],
}, null, 2));
