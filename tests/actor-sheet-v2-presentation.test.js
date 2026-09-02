import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const decorator = readFileSync(new URL('../src/entities/sheet-v2-decorator.js', import.meta.url), 'utf8');
const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
const lazyRuntime = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');

test('Actor Sheet V2 decorates existing Ruleset sheets instead of replacing their data contract', () => {
  assert.match(decorator, /entity-sheet-v2/);
  assert.match(decorator, /data-sheet-v2-badges/);
  assert.match(decorator, /data-health-panel/);
  assert.doesNotMatch(decorator, /describeActorSheet|actorDelta|world\.operation/);
});

test('overview uses a persistent health sidebar while other Ruleset sections stay in main content', () => {
  assert.match(decorator, /data-sheet-v2-tab=\"overview\"/);
  assert.match(decorator, /grid-template-columns:minmax\(210px,250px\) minmax\(0,1fr\)/);
  assert.match(decorator, /> \[data-health-panel\]/);
});

test('LIMITED, Token instance and read-only states get presentation badges without changing permissions', () => {
  assert.match(decorator, /LIMITED/);
  assert.match(decorator, /TOKEN INSTANCE/);
  assert.match(decorator, /entity-sheet-readonly/);
});

test('Actor Sheet V2 stays in the lazy Entity UI chunk', () => {
  assert.match(lazyRuntime, /createActorSheetV2Decorator/);
  assert.match(entityIndex, /createActorSheetV2Decorator\(\)\.register\(api\)/);
  assert.ok(entityIndex.indexOf("import('../ui/lazy-runtime-tools.js')") < entityIndex.indexOf('createActorSheetV2Decorator().register(api)'));
});
