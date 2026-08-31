import { readFile, readdir, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const dist = path.join(root, 'dist');
const manifestPath = path.join(dist, '.vite', 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entry = Object.values(manifest).find(item => item?.isEntry);
if (!entry) throw new Error('Vite manifest does not contain an application entry');

const recordsByFile = new Map(Object.values(manifest).map(item => [item.file, item]));
const staticFiles = new Set();
function collectStatic(record) {
  if (!record || staticFiles.has(record.file)) return;
  staticFiles.add(record.file);
  for (const css of record.css || []) staticFiles.add(css);
  for (const imported of record.imports || []) collectStatic(manifest[imported] || recordsByFile.get(imported));
}
collectStatic(entry);

async function gzipSize(relative) {
  return gzipSync(await readFile(path.join(dist, relative))).length;
}

async function walk(directory, prefix = '') {
  const files = [];
  for (const entryValue of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entryValue.name);
    if (entryValue.isDirectory()) files.push(...await walk(path.join(directory, entryValue.name), relative));
    else files.push(relative);
  }
  return files;
}

const allFiles = await walk(dist);
const initialJs = [...staticFiles].filter(file => file.endsWith('.js'));
const initialCss = [...staticFiles].filter(file => file.endsWith('.css'));
const allJs = allFiles.filter(file => file.endsWith('.js'));
const allCss = allFiles.filter(file => file.endsWith('.css'));
const sum = async files => (await Promise.all(files.map(gzipSize))).reduce((total, value) => total + value, 0);

// v2.1.6 is the formal feature baseline for v2.2.0. Vision/Fog belongs to the
// lazy Map Runtime, so the World Manager payload may not grow. The complete
// application may grow by at most 10% for the new Runtime capability.
const baseline = Object.freeze({
  commit: '55ee22d45985edd27f7a2262fea287764296fcfc',
  version: '2.1.6',
  initialJsGzip: 47000,
  totalJsGzip: 233952,
  totalCssGzip: 7076,
});
const limits = Object.freeze({
  initialJsGzip: baseline.initialJsGzip,
  totalJsGzip: Math.floor(baseline.totalJsGzip * 1.10),
  totalCssGzip: Math.floor(baseline.totalCssGzip * 1.10),
});
const measured = {
  initialJsGzip: await sum(initialJs),
  initialCssGzip: await sum(initialCss),
  totalJsGzip: await sum(allJs),
  totalCssGzip: await sum(allCss),
};
const report = {
  baseline,
  limits,
  measured,
  initialChange: measured.initialJsGzip / baseline.initialJsGzip - 1,
  totalJsChange: measured.totalJsGzip / baseline.totalJsGzip - 1,
  initialFiles: [...staticFiles].sort(),
};
console.log(JSON.stringify(report, null, 2));

for (const key of ['initialJsGzip', 'totalJsGzip', 'totalCssGzip']) {
  if (measured[key] > limits[key]) {
    throw new Error(`${key} ${measured[key]} exceeds budget ${limits[key]}`);
  }
}

for (const file of allFiles) await stat(path.join(dist, file));
