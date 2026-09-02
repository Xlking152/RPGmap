import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ActorSheet } from '../src/entities/sheet/actor-sheet.js';
import { createSheetContext } from '../src/entities/sheet/permission.js';

const entityIndex = readFileSync(new URL('../src/entities/index.js', import.meta.url), 'utf8');
const lazyRuntime = readFileSync(new URL('../src/ui/lazy-runtime-tools.js', import.meta.url), 'utf8');
const liveUi = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');
const parts = readFileSync(new URL('../src/entities/sheet/parts.js', import.meta.url), 'utf8');

test('Sheet Context takes an explicit Access level and never reads ownership from Actor data', () => {
  const ownerPlay = createSheetContext({ permissionLevel: 'owner', mode: 'play', canRuntimeEdit: true });
  const ownerEdit = createSheetContext({ permissionLevel: 'owner', mode: 'edit', canRuntimeEdit: true });
  const observer = createSheetContext({ permissionLevel: 'observer', mode: 'edit' });
  const limited = createSheetContext({ permissionLevel: 'limited' });
  assert.equal(ownerPlay.editable, false);
  assert.equal(ownerPlay.runtimeInteractive, true);
  assert.equal(ownerEdit.editable, true);
  assert.equal(observer.mode, 'play');
  assert.equal(observer.editable, false);
  assert.equal(limited.limited, true);
  assert.doesNotMatch(readFileSync(new URL('../src/entities/sheet/permission.js', import.meta.url), 'utf8'), /actor\?\.(ownership|permission)/);
});

test('Actor Sheet V3 composes badges, LIMITED content, and GM public profile Parts', () => {
  const actor = { id: 'npc-a', name: '守卫', type: 'npc', publicProfile: { summary: '公开简介' } };
  const sheet = new ActorSheet({ actor, permissionLevel: 'limited' });
  assert.match(sheet.renderBadges(), /LIMITED/);
  assert.match(sheet.renderLimited(), /公开简介/);
  assert.match(parts, /renderPublicProfileEditor/);
  assert.match(parts, /visibleStatusDefinitionIds/);
  assert.doesNotMatch(parts, /<pre>/);
});

test('V3 rendering is native to lazy live UI and the DOM decorator is retired', () => {
  assert.match(lazyRuntime, /installActorSheetOpenPolicy/);
  assert.match(lazyRuntime, /ui-live\.js/);
  assert.doesNotMatch(lazyRuntime, /createActorSheetV2Decorator|sheet-v2-decorator/);
  assert.match(entityIndex, /installActorSheetOpenPolicy\(api\)/);
  assert.doesNotMatch(entityIndex, /createActorSheetV2Decorator|sheet-v2-decorator/);
  assert.match(liveUi, /new ActorSheet/);
  assert.match(liveUi, /data-sheet-interaction-mode/);
  assert.match(liveUi, /data-sheet-mode-toggle/);
  assert.match(liveUi, /entity-sheet-backdrop entity-sheet-window/);
  assert.match(liveUi, /aria-modal="false"/);
});

test('Play/Edit structural gates and runtime operations stay separate', () => {
  assert.match(liveUi, /requireActorStructureEdit/);
  assert.match(liveUi, /record\.interactionMode !== 'edit'/);
  assert.match(liveUi, /requireRuntimeEdit/);
  assert.match(liveUi, /actor\.runtime\.perform/);
});
