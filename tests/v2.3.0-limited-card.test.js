import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');

test('LIMITED Actor rendering returns before Ruleset sheets, Health, Status, and Token configuration', () => {
  const start = source.indexOf("if (actor.audienceRestricted === true) {");
  const end = source.indexOf('const sheetDescription = describeActorSheet', start);
  assert.ok(start >= 0 && end > start);
  const limitedBranch = source.slice(start, end);
  assert.match(limitedBranch, /actor\.name/);
  assert.match(limitedBranch, /entityAvatarHtml\(actor/);
  assert.match(limitedBranch, /actor\.type/);
  assert.match(limitedBranch, /actorSheet\.renderLimited/);
  assert.doesNotMatch(limitedBranch, /resolveStatusUiSnapshot|describeActorSheet|actorSheetBody|actorDelta|health|system/);
});
