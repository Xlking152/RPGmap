import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const model = readFileSync(new URL('../src/health/model.js', import.meta.url), 'utf8');
const tokenBars = readFileSync(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');
const instanceUi = readFileSync(new URL('../src/health/instance-ui.js', import.meta.url), 'utf8');
const sheetExtension = readFileSync(new URL('../src/health/sheet-extension.js', import.meta.url), 'utf8');

test('compact health text is generic presentation derived from current/max, not a BLA special case', () => {
  assert.match(model, /segments\.length > 1/);
  assert.match(model, /return `\$\{Math\.max\(0, current\)\}\/\$\{Math\.max\(0, max\)\}`/);
  assert.doesNotMatch(model, /wound-track|HEALTH_MODE_SIMPLE|HEALTH_MODE_WOUND_TRACK/);
});

test('simple current/max can be rendered directly on Token health bars', () => {
  assert.match(tokenBars, /view\.compactSummary/);
  assert.match(tokenBars, /rpgmap-token-healthbar-value/);
});

test('marker and other Token instances expose a per-instance Ruleset health mode selector', () => {
  assert.match(instanceUi, /healthModeOptions/);
  assert.match(instanceUi, /data-ruleset-health-mode/);
  assert.match(instanceUi, /api\.health\.setMode\(token\.actorId, modeSelect\.value, \{ tokenId \}\)/);
});

test('Actor sheet and current inspector prefer the compact HP fraction when available', () => {
  assert.match(sheetExtension, /entity-health-compact/);
  assert.match(sheetExtension, /view\.compactSummary \|\| view\.summary/);
});
