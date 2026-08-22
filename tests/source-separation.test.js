import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));

async function javascriptFiles(directory = SRC_ROOT) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(fullPath));
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function relativeSourcePath(file) {
  return path.relative(SRC_ROOT, file).split(path.sep).join('/');
}

test('only explicit build/compatibility adapters may import Lanzhou reference sources', async () => {
  const allowed = new Set([
    'map-package/default-map.js',
    'maps/lanzhou.js',
  ]);
  const importers = [];

  for (const file of await javascriptFiles()) {
    const source = await readFile(file, 'utf8');
    if (/reference\/maps\/lanzhou|reference\\maps\\lanzhou/.test(source)) {
      importers.push(relativeSourcePath(file));
    }
  }

  assert.deepEqual(importers.sort(), [...allowed].sort());
});

test('generic Core movement/interaction/elevation/navigation source contains no Lanzhou identity or Feature IDs', async () => {
  const coreRoots = ['engine', 'interaction', 'elevation', 'movement'];
  const forbidden = /LANZHOU_|northern-song-lanzhou|gate-north|gate-east|gate-south|gate-west|jincheng-gatehouse|yamen-gate/i;

  for (const root of coreRoots) {
    const directory = path.join(SRC_ROOT, root);
    for (const file of await javascriptFiles(directory)) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, forbidden, `${relativeSourcePath(file)} contains map-specific identity`);
    }
  }
});
