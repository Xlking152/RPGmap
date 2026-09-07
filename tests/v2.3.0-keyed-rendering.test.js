import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tokenLayer = readFileSync(new URL('../src/render/token-layer.js', import.meta.url), 'utf8');
const healthBars = readFileSync(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');
const appShell = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const featureInteractions = readFileSync(new URL('../src/interaction/system.js', import.meta.url), 'utf8');
const sceneAreas = readFileSync(new URL('../src/scene/areas.js', import.meta.url), 'utf8');
const sceneAreaHandles = readFileSync(new URL('../src/scene/area-handles.js', import.meta.url), 'utf8');
const entityUi = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');
const combat = readFileSync(new URL('../src/combat/controller.js', import.meta.url), 'utf8');

test('ordinary Token events update only keyed Token, status, and summary views', () => {
  assert.match(tokenLayer, /function renderToken\(tokenId/);
  assert.match(tokenLayer, /for \(const id of pendingRenderIds\) renderToken\(id/);
  assert.match(tokenLayer, /function renderTokenPosition\(tokenId\)/);
  assert.match(tokenLayer, /pendingPositionIds\.add\(id\)/);
  assert.match(tokenLayer, /if \(motion\.prediction && sameTokenPoint\(canonical, motion\.target\)\) renderToken/);
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
  assert.match(healthBars, /api\.on\('token:move', moveTokenBar\)/);
  assert.doesNotMatch(healthBars, /api\.on\('token:move', event => scheduleTokenRender/);
});

test('current selection summary ignores broad persistence commits', () => {
  assert.doesNotMatch(appShell, /'status:change', 'state:commit'/);
  assert.match(appShell, /'actor:change', 'health:change', 'status:change'/);
});

test('unaffected Actor Sheet Parts and inactive overlays do not enter render queues', () => {
  assert.match(entityUi, /sheetInstances\.get\(record\.key\)\?\.affectedParts\(changes\)/);
  assert.match(entityUi, /if \(affected && !\['header', 'classification', 'tabs', 'body'\]/);
  assert.match(sceneAreaHandles, /selected\?\.anchor\?\.type === kind/);
  assert.match(combat, /String\(current\.tokenId\) === String\(event\.detail\?\.tokenId/);
  assert.match(appShell, /if \(!primaryId && \(tokenIds\.length \|\| actorIds\.length\)\) return/);
});

test('Token movement does not rescan all Feature visual state', () => {
  assert.match(featureInteractions, /'state:import', 'state:commit', 'scene:restore', 'feature:state-change'/);
  assert.match(featureInteractions, /'token:create', 'token:delete', 'token:move', 'token:property-change'/);
  assert.doesNotMatch(featureInteractions, /'token:move'[^\]]*\]\) off\.push\(api\.on\?\.\(eventName, \(\) => \{ syncFeatureVisualState\(\)/s);
  assert.match(featureInteractions, /if \(selectedFeatureId\) renderInspection\(\)/);
});

test('scene area rendering uses an event-refreshed attack area cache', () => {
  assert.match(sceneAreas, /const initialState = api\.getState\(\)/);
  assert.match(sceneAreas, /let cachedAreas = clone\(initialState\?\.attackAreas \|\| \[\]\)/);
  assert.match(sceneAreas, /const areas = \(\) => cachedAreas/);
  assert.match(sceneAreas, /const state = event\?\.detail\?\.state \|\| api\.getState\(\)/);
  assert.match(sceneAreas, /areas\(\)\.some\(area => area\.anchor\?\.type === kind/);
  assert.doesNotMatch(sceneAreas, /const areas = \(\) => api\.getState\(\)\?\.attackAreas/);
  assert.doesNotMatch(sceneAreas, /for \(const marker of api\.getState\(\)\?\.markers/);
});
