import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const statusUi = readFileSync(new URL('../src/status/ui.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../src/status/definition-editor.js', import.meta.url), 'utf8');
const lazyTools = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');

test('the status definition editor is loaded on first management action', () => {
  assert.match(statusUi, /definitionEditorModule \|\|= import\('\.\.\/ui\/lazy-runtime-tools\.js'\)/);
  assert.match(lazyTools, /renderStatusDefinitionEditor/);
  assert.doesNotMatch(statusUi, /export function renderStatusDefinitionEditor/);
  assert.match(editor, /export function renderStatusDefinitionEditor/);
  assert.match(editor, /STATUS_ICON_NAMES/);
});
