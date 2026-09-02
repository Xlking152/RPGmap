import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/health/sheet-extension.js', import.meta.url), 'utf8');

test('Health sheet extension resolves the sheet that triggered an edit instead of a global first sheet', () => {
  assert.match(source, /function subjectFromSheet\(api, sheet\)/);
  assert.match(source, /input\.closest\('\.entity-sheet'\)/);
  assert.match(source, /select\.closest\('\.entity-sheet'\)/);
  assert.doesNotMatch(source, /documentNode\.querySelector\('\.entity-sheet'\)/);
});

test('Health enhancement walks every open Actor sheet', () => {
  assert.match(source, /querySelectorAll\('\.entity-sheet'\)/);
  assert.match(source, /for \(const sheet[\s\S]*enhanceSheet\(sheet\)/);
});

test('Monster and Summon combat-first cards keep Health visible on their combat tab', () => {
  assert.match(source, /activeTab === 'combat'/);
  assert.match(source, /\['monster', 'summon'\]/);
  assert.match(source, /activeTab === 'overview'/);
});

test('Health edit messages no longer claim Actor OWNER edits require the current combat turn', () => {
  assert.doesNotMatch(source, /必须轮到该角色行动/);
  assert.match(source, /需要该 Actor 的 OWNER 权限/);
  assert.match(source, /当前没有该 Token 实例的控制权限/);
});
