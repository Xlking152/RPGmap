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

// Fixed gates from the approved v2.4.0 plan, not adjusted by measurement results.
const baseline = Object.freeze({
  commit: 'dae58632844953c6f8edf061778e0d7f3d93d181',
  version: '2.3.4',
  initialJsGzip: 11713,
  totalJsGzip: 269252,
  totalCssGzip: 7076,
});
const limits = Object.freeze({
  initialJsGzip: 11726,
  totalJsGzip: 310000,
  totalCssGzip: Math.floor(baseline.totalCssGzip * 1.05),
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
