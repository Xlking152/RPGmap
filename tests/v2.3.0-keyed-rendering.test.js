import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tokenLayer = readFileSync(new URL('../src/render/token-layer.js', import.meta.url), 'utf8');
const healthBars = readFileSync(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');
const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');

test('ordinary Token events update only keyed Token, status, and summary views', () => {
  assert.match(tokenLayer, /function renderToken\(tokenId/);
  assert.match(tokenLayer, /for \(const id of pendingRenderIds\) renderToken\(id/);
  assert.match(tokenLayer, /eventRenderFrame = requestFrame/);
  assert.match(tokenLayer, /const changed = new Set\(\[\.\.\.previous, \.\.\.selectedIds\]\)/);
  assert.doesNotMatch(tokenLayer, /'state:saved'/);
  assert.doesNotMatch(tokenLayer, /api\.on\('state:commit', render\)/);
});

test('Health bars use targeted entity events and reserve full renders for import or viewport changes', () => {
  assert.match(healthBars, /function tokenIdsFromEvent\(event\)/);
  assert.match(healthBars, /\['health:change', 'status:change', 'actor:change'\]/);
  assert.doesNotMatch(healthBars, /api\.on\('state:commit'/);
  assert.match(healthBars, /api\.on\('state:import', scheduleFullRender\)/);
});

test('current selection summary ignores broad persistence commits', () => {
  assert.doesNotMatch(appShell, /'status:change', 'state:commit'/);
  assert.match(appShell, /'actor:change', 'health:change', 'status:change'/);
});
