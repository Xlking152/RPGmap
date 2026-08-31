import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTokenViewModel } from '../src/render/token-view-model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { classifyNewImportedActor } from '../src/entities/ui.js';

const [runtimeSource, shellSource, markerSource, entitySource, rendererSource] = await Promise.all([
  readFile(new URL('../src/engine/runtime.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/marker/system.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/entities/ui.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/render/token-layer.js', import.meta.url), 'utf8'),
]);

test('v2.2.1 removes the Layers surface, keeps grid rendering on, and reserves four equal sidebar tabs', () => {
  assert.doesNotMatch(runtimeSource, /data-panel="layers"/);
  assert.doesNotMatch(shellSource, /activatePanel\('layers'\)|renderLayers|显示动态网格/);
  assert.doesNotMatch(runtimeSource, /preferences\?\.gridVisible === false/);
  assert.match(shellSource, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(entitySource, /\[data-panel="markers"\]\s*\{\s*display:\s*none/);
});

test('Actor and Marker libraries separate PC templates from independent non-PC instances', () => {
  assert.match(entitySource, /filter\(actor => String\(actor\.type \|\| 'pc'\) === 'pc'\)/);
  assert.match(entitySource, /data-entity-share checked/);
  assert.match(markerSource, /\['monster', 'npc', 'summon', 'other'\]/);
  assert.match(markerSource, /<h2>怪物<\/h2>/);
  assert.match(markerSource, /<h2>NPC<\/h2>/);
  assert.match(markerSource, /<h2>其他模板<\/h2>/);
  assert.match(markerSource, /data-marker-import-actor-type/);
  assert.doesNotMatch(markerSource, /Actor 型指示物|NPC \/ 怪物/);
  assert.match(markerSource, /data-marker-actor-manage/);
  assert.match(markerSource, /api\.status\.applyBatch/);
  assert.match(markerSource, /type: 'actor\.runtime\.perform'/);
  assert.match(markerSource, /actorLink: false/);
});

test('monster and NPC XLSX entry points classify only newly imported Actors', () => {
  const source = { id: 'new-template', name: 'Imported', type: 'pc', partyId: 'party-default' };
  assert.deepEqual(classifyNewImportedActor(source, 'monster'), {
    ...source, type: 'monster', partyId: null,
  });
  assert.deepEqual(classifyNewImportedActor(source, 'npc'), {
    ...source, type: 'npc', partyId: null,
  });
  assert.equal(source.type, 'pc');
  assert.match(entitySource, /if \(actor\) \{/);
  assert.match(entitySource, /classifyNewImportedActor\(createActorFromImport/);
});

test('GM-only and invisible Token presentation keeps canonical selection while showing both badges', () => {
  const actor = {
    id: 'actor-ui', name: '模板', effects: [],
    ...infiniteHorrorRuleset.actor.createDefault({ name: '模板' }),
  };
  const model = createTokenViewModel({
    token: {
      id: 'token-ui', actorId: actor.id, actorLink: true, placement: 'map', x: 1, y: 2,
      name: '模板1', visibility: { mode: 'gm', userIds: [] }, diameterMeters: 1,
    },
    actor, ruleset: infiniteHorrorRuleset, gmViewer: true, invisible: true,
  });
  assert.equal(model.name, '模板1');
  assert.equal(model.gmOnly, true);
  assert.equal(model.invisible, true);
  assert.match(rendererSource, /GM 专属/);
  assert.match(rendererSource, /隐身/);
  assert.match(rendererSource, /model\.gmOnly \|\| model\.invisible/);
  assert.match(rendererSource, /model\.audienceVisibility === 'vague'/);
});
