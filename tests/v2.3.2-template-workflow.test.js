import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('Ctrl/Cmd route planning stays above Fog and renders live waypoint distances', async () => {
  const source = await read('../src/movement/controller.js');
  assert.match(source, /MOVEMENT_PREVIEW_PANE = 'movementPreviewPane'/);
  assert.match(source, /previewPane\.style\.zIndex = '550'/);
  assert.match(source, /interaction\.modifierSeen \|\|=/);
  assert.match(source, /\['drag', 'click'\]\.includes\(current\.mode\)/);
  assert.match(source, /route\.slice\(1, -1\)/);
  assert.match(source, /addPathDistanceLabel/);
  assert.match(source, /validationPending/);
  assert.match(source, /validationSequence/);
  assert.match(source, /if \(interaction\) reset\('窗口失去焦点/);
});

test('the eager Entity facade opens XLSX picker synchronously before lazy parsing', async () => {
  const eager = await read('../src/entities/index.js');
  const live = await read('../src/entities/ui-live.js');
  const marker = await read('../src/marker/system.js');
  const requestBody = eager.slice(eager.indexOf('function requestImport'), eager.indexOf('async function handleImportFile'));
  assert.match(requestBody, /xlsxInput\.click\(\)/);
  assert.doesNotMatch(requestBody, /await |load\(\)\.then/);
  assert.match(eager, /await entityApi\?\.importFile\?\.\(file, context\)/);
  assert.match(live, /\.\.\.api\.entities/);
  assert.match(live, /importFile\(file, context = \{\}\)/);
  assert.doesNotMatch(live, /createElement\('input'\)[\s\S]{0,120}application\/vnd\.openxmlformats/);
  assert.match(marker, /requestImport\?\.\(\{ actorId: null, actorType:/);
});

test('independent templates expose a GM-only new-instance Health default', async () => {
  const source = await read('../src/health/sheet-extension.js');
  assert.match(source, /canEditTemplateHealthMode/);
  assert.match(source, /sheetInteractionMode !== 'edit'/);
  assert.match(source, /session\?\.role !== 'gm'/);
  assert.match(source, /默认生命规则（新实例）/);
  assert.match(source, /现有实例的生命规则和当前生命不会改变/);
  assert.match(source, /healthInput\(field, actorId, tokenId, disabled\)/);
});

test('monster and NPC template deletion is explicit and Document-authoritative', async () => {
  const marker = await read('../src/marker/system.js');
  const live = await read('../src/entities/ui-live.js');
  const controller = await read('../src/entities/token-controller.js');
  const deletion = await read('../src/entities/canonical-delete.js');
  assert.match(marker, /data-marker-actor-delete/);
  assert.match(live, /data-sheet-action="delete-template"/);
  assert.match(controller, /请输入模板名称以确认/);
  assert.match(controller, /sceneNames/);
  assert.match(deletion, /api\.documents\.dispatch/);
  assert.match(deletion, /intent: 'actor.delete'/);
  assert.match(deletion, /deleteReferencedTokens: true/);
  assert.doesNotMatch(deletion, /api\.world\.commit/);
});
