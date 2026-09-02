import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retiredUi = path.join(ROOT, 'src', 'entities', 'ui.js');
const sourceRoot = path.join(ROOT, 'src');

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

test('retired monolithic Entity UI stays deleted', () => {
  assert.equal(existsSync(retiredUi), false, 'src/entities/ui.js must not return after the live multi-window migration');
});

test('production source cannot import the retired Entity UI path', () => {
  const offenders = javascriptFiles(sourceRoot).filter(file => {
    const source = readFileSync(file, 'utf8');
    return /(?:from\s+|import\s*\()\s*['"][^'"]*entities\/ui\.js['"]/.test(source)
      || /(?:from\s+|import\s*\()\s*['"]\.\/ui\.js['"]/.test(source) && file.includes(`${path.sep}entities${path.sep}`);
  });
  assert.deepEqual(offenders, []);
});

test('lazy runtime exposes the live Entity UI and never the retired coordinator path', () => {
  const lazy = readFileSync(path.join(ROOT, 'src', 'ui', 'lazy-runtime-tools.js'), 'utf8');
  assert.match(lazy, /createEntityUiTool.*ui-live\.js/);
  assert.doesNotMatch(lazy, /entities\/ui\.js|sheet-window-coordinator/);
});
