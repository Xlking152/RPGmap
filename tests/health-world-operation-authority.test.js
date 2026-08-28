import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function source(file) {
  return readFileSync(path.join(ROOT, file), 'utf8');
}

test('Health controller has no projection-first persistence path', () => {
  const controller = source('src/health/controller.js');
  assert.doesNotMatch(controller, /store\.persist\s*\(/);
  assert.doesNotMatch(controller, /persistNow\s*\(/);
  assert.match(controller, /api\.world\?\.performOperations/);
  assert.match(controller, /type:\s*'actor\.upsert'/);
  assert.match(controller, /type:\s*'token\.actorDelta\.replace'/);
  assert.match(controller, /kind:\s*'health'/);
});

test('Health UI and chat wait for canonical Health confirmation', () => {
  const sheet = source('src/health/sheet-extension.js');
  const chat = source('src/chat/controller.js');
  assert.match(sheet, /addEventListener\('change', async event/);
  assert.match(sheet, /await api\.health\?\.setMode/);
  assert.match(sheet, /await api\.health\?\.performActorOperation/);
  assert.match(chat, /addEventListener\('submit', async event/);
  assert.match(chat, /await api\.damage\.applyToSelected/);
  assert.match(chat, /await api\.healing\.applyToSelected/);
});

test('Damage and Healing facades expose confirmation-based async operations', () => {
  const damage = source('src/damage/controller.js');
  const healing = source('src/healing/controller.js');
  assert.match(damage, /async applyToTokenIds/);
  assert.match(damage, /async applyToSelected/);
  assert.match(healing, /async applyToTokenIds/);
  assert.match(healing, /async applyToSelected/);
});
