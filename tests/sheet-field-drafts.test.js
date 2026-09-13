import test from 'node:test';
import assert from 'node:assert/strict';
import { SheetFieldDrafts } from '../src/entities/sheet/field-drafts.js';
import { ActorSheet } from '../src/entities/sheet/actor-sheet.js';
import { applyInfiniteHorrorActorOperation, createDefaultInfiniteHorrorActor } from '../src/rulesets/infinite-horror/actor.js';

test('Sheet drafts preserve same-field conflicts and isolate windows and fields', () => {
  const a = new SheetFieldDrafts();
  const b = new SheetFieldDrafts();
  a.observe('name', 'old'); b.observe('name', 'old');
  a.observe('party', 'one'); a.edit('name', 'draft');
  a.observe('name', 'remote'); a.observe('party', 'two'); b.observe('name', 'remote');
  assert.equal(a.get('name').value, 'draft');
  assert.equal(a.get('name').conflict, true);
  assert.equal(a.begin('name'), null);
  assert.equal(a.get('party').value, 'two');
  assert.equal(b.get('name').value, 'remote');
  a.retry('name');
  assert.deepEqual(a.begin('name'), { value: 'draft', expected: 'remote' });
  assert.equal(a.begin('name'), null);
});

test('Acknowledgement cannot erase typing that continued while a field was pending', () => {
  const drafts = new SheetFieldDrafts();
  drafts.observe('name', 'a'); drafts.edit('name', 'b'); drafts.begin('name');
  drafts.edit('name', 'c'); drafts.observe('name', 'b'); drafts.settle('name', { success: true });
  assert.equal(drafts.get('name').value, 'c');
  assert.equal(drafts.get('name').dirty, true);
  assert.equal(drafts.get('name').conflict, false);
  assert.deepEqual(drafts.begin('name'), { value: 'c', expected: 'b' });
});

test('Rejected saves retain drafts until explicitly adopting or retrying canonical values', () => {
  const drafts = new SheetFieldDrafts();
  drafts.observe('flag', false); drafts.edit('flag', true); drafts.begin('flag');
  drafts.settle('flag', { success: false, error: 'permission_denied' });
  assert.equal(drafts.get('flag').value, true);
  assert.equal(drafts.notices()[0].error, 'permission_denied');
  drafts.adopt('flag');
  assert.equal(drafts.get('flag').value, false);
  assert.equal(drafts.notices().length, 0);
  drafts.clear();
  assert.equal(drafts.get('flag'), null);
});

test('An acknowledged normalized value replaces only the submitted draft, not later input', () => {
  const drafts = new SheetFieldDrafts();
  drafts.observe('resource', '3'); drafts.edit('resource', '999'); drafts.begin('resource');
  drafts.observe('resource', '20'); drafts.settle('resource', { success: true });
  assert.equal(drafts.get('resource').value, '20');
  assert.equal(drafts.get('resource').dirty, false);
});

test('ActorSheet selects dependent parts before rendering and recognizes removed nested fields', () => {
  const sheet = new ActorSheet({ actor: { id: 'a' }, permissionLevel: 'owner' });
  let renders = 0;
  sheet.definePart('header', { dependencies: { Actor: ['name'], Token: ['actorDelta'] }, render: () => { renders += 1; return 'header'; } });
  sheet.definePart('body', { dependencies: { Token: ['x', 'y'] }, render: () => { renders += 1; return 'body'; } });
  const movement = [{ action: 'move', document: { type: 'Token' }, changed: { x: 3 } }];
  assert.deepEqual([...sheet.affectedParts(movement)], ['body']);
  assert.equal(renders, 0);
  assert.ok(sheet.affectedParts([{ document: { type: 'Token' }, changed: {}, removed: [['actorDelta', 'effects']] }]).has('header'));
  assert.deepEqual([...sheet.affectedParts([{ document: { type: 'ChatMessage' }, changed: { text: 'test' } }])], []);
});

test('Ruleset field operations reject stale runtime values without guessing private paths in Core', () => {
  const actor = createDefaultInfiniteHorrorActor({ id: 'a' });
  const before = structuredClone(actor);
  const operation = { type: 'attribute.set-adjustment', attributeId: 'strength', value: 2, expectedValue: '0' };
  assert.equal(applyInfiniteHorrorActorOperation(actor, operation).changed, true);
  assert.equal(applyInfiniteHorrorActorOperation(actor, { ...operation, value: 4 }).blocked, 'document_field_conflict');
  assert.equal(actor.system.runtime.attributeAdjustments.strength, 2);
  assert.equal(applyInfiniteHorrorActorOperation(actor, { type: 'attribute.set-adjustment', attributeId: 'perception', value: 3, expectedValue: '0' }).changed, true);
  assert.deepEqual(actor.system.forms, before.system.forms);
});
