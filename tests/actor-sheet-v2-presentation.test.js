import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const decorator = readFileSync(new URL('../src/entities/sheet-v2-decorator.js', import.meta.url), 'utf8');
const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
const lazyRuntime = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');
const liveUi = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');

test('Actor Sheet V2 decorates existing Ruleset sheets instead of replacing their data contract', () => {
  assert.match(decorator, /entity-sheet-v2/);
  assert.match(decorator, /data-sheet-v2-badges/);
  assert.match(decorator, /data-health-panel/);
  assert.doesNotMatch(decorator, /describeActorSheet|actorDelta|world\.operation/);
});

test('character overview keeps the persistent health sidebar layout', () => {
  assert.match(decorator, /data-sheet-kind=\"character\"/);
  assert.match(decorator, /data-sheet-v2-tab=\"overview\"/);
  assert.match(decorator, /grid-template-columns:minmax\(210px,250px\) minmax\(0,1fr\)/);
  assert.match(decorator, /> \[data-health-panel\]/);
});

test('Character, Monster and NPC presentation plus Play/Edit controls stay in the decorator layer', () => {
  assert.match(decorator, /角色卡/);
  assert.match(decorator, /怪物卡/);
  assert.match(decorator, /NPC 卡/);
  assert.match(decorator, /data-sheet-v2-mode-toggle/);
  assert.match(decorator, /data-sheet-interaction-mode/);
  assert.match(decorator, /data-sheet-v2-edit-only/);
});

test('LIMITED, Token instance and read-only states get presentation badges without changing permissions', () => {
  assert.match(decorator, /LIMITED/);
  assert.match(decorator, /TOKEN INSTANCE/);
  assert.match(decorator, /entity-sheet-readonly/);
});

test('Actor Sheet policy and V2 presentation stay in the lazy Entity UI chunk', () => {
  assert.match(lazyRuntime, /installActorSheetOpenPolicy/);
  assert.match(lazyRuntime, /createActorSheetV2Decorator/);
  assert.match(lazyRuntime, /ui-live\.js/);
  assert.match(entityIndex, /installActorSheetOpenPolicy\(api\)/);
  assert.match(entityIndex, /createActorSheetV2Decorator\(\)\.register\(api\)/);
  assert.ok(entityIndex.indexOf('installActorSheetOpenPolicy(api)') < entityIndex.indexOf('createActorSheetV2Decorator().register(api)'));
  assert.ok(entityIndex.indexOf("import('../ui/lazy-runtime-tools.js')") < entityIndex.indexOf('createActorSheetV2Decorator().register(api)'));
  assert.match(liveUi, /entity-sheet-backdrop entity-sheet-window/);
  assert.match(liveUi, /aria-modal=\"false\"/);
});