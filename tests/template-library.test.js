import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultActor } from '../src/actor/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { copyActorTemplate, prepareTemplateImport, previewTemplateImport, normalizeLibraryEntry } from '../src/library/model.js';
import { applyWorldOperations, createWorldOperationPatch, applyWorldOperationPatch } from '../src/world/operations.js';
import { createDocumentChanges, applyDocumentChanges } from '../src/documents/changes.js';
import { documentWritesToWorldOperations } from '../src/documents/protocol.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { createTemplateLibrarySystem } from '../src/library/runtime.js';
import { canPlaceActorTemplate } from '../src/permissions/model.js';
import { defaultTokenVisibility } from '../src/token/access.js';
import { exportTemplateArchive } from '../src/content/archive.js';

const mapPackage = { id: 'test', version: '1', width: 100, height: 100, metersPerUnit: 1 };
const bodyRef = `body:${'a'.repeat(64)}`;
function fixture() {
  const actor = createDefaultActor({ id: 'actor-a', name: 'Template', type: 'npc', ruleset });
  const form = actor.system.forms[0];
  form.healthBase.baseMax = 30;
  actor.system.runtime.health = { mode: 'simple', current: 8, wounds: { bashing: 3, lethal: 0, aggravated: 0 }, maxOverride: null };
  actor.system.runtime.customResources = [{ id: 'custom', name: 'Custom', current: 1, max: 9, extension: { retain: true } }];
  actor.system.runtime.badStatuses = { injured: 2 };
  actor.effects = [];
  actor.ownership = { intruder: 'owner' };
  actor.notes = 'Preserve notes';
  actor.extension = { keep: true };
  const raw = { preferences: { entitySystem: { actors: [actor], tokens: [], statusDefinitions: [] } } };
  const world = createWorldV2FromRuntimeState(raw, { ruleset, mapPackage });
  return projectWorldV2ToRuntimeState(raw, world, { ruleset, mapPackage });
}
const entry = () => ({ id: 'template-a', name: 'Archive', type: 'npc', tags: ['sample'], archived: false, bodyRef,
  ruleset: { id: ruleset.id, version: ruleset.version }, extension: { keep: true } });
const upsert = value => ({ type: 'world.library.upsert', payload: { entry: value, expectedBodyRef: null, expectedEntry: null } });

function libraryHarness() {
  let state = fixture(), role = 'gm';
  const order = [], batches = [];
  const button = { dataset: {}, addEventListener() {}, remove() {} };
  const doc = { createElement: () => button, querySelector: () => ({ append() {} }) };
  const api = { ruleset, map: { getContainer: () => ({ ownerDocument: doc }) }, getState: () => state,
    multiplayer: { getStatus: () => ({ connected: true, session: { role } }) }, on: () => () => {},
    content: { async putTemplate() { order.push('content'); return { reference: bodyRef }; } },
    documents: { async dispatchBatch(writes) {
      order.push('documents'); batches.push(writes);
      state = applyWorldOperations(state, documentWritesToWorldOperations(writes), { ruleset }).state;
    } } };
  createTemplateLibrarySystem({ serverRuntime: true }).register(api);
  const world = state.preferences.worldV2;
  const bundle = { schemaVersion: 1, kind: 'actor-template', ruleset: world.ruleset, actor: world.actors[0], statusDefinitions: [] };
  return { api, bundle, batches, order, setRole(value) { role = value; } };
}

test('package import persists immutable bodies then atomically commits the index and copied Actor', async () => {
  const { api, bundle, batches, order } = libraryHarness();
  const original = structuredClone(api.getState());
  const archive = await exportTemplateArchive(bundle, {});
  const preview = await api.library.previewPackage(archive);
  assert.deepEqual(order, []);
  assert.deepEqual(preview.conflicts, []);
  const id = await api.library.importPackage(preview);
  assert.deepEqual(order, ['content', 'documents']);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].map(write => write.intent), ['world.library.upsert', 'actor.upsert']);
  const world = api.getState().preferences.worldV2;
  assert.notEqual(id, bundle.actor.id);
  assert.equal(world.actors.find(actor => actor.id === id).system.runtime.health.current, 30);
  assert.deepEqual(world.actors[0], original.preferences.worldV2.actors[0]);
  assert.deepEqual(world.scenes, original.preferences.worldV2.scenes);
  assert.equal(Object.values(world.templateLibrary)[0].bodyRef, bodyRef);
  await assert.rejects(api.library.importPackage(preview), /template_preview_required/);
});

test('package import rejects forged previews, revoked access, World changes and quota failure without Document writes', async () => {
  const { api, bundle, batches, setRole } = libraryHarness();
  const archive = await exportTemplateArchive(bundle, {});
  const preview = await api.library.previewPackage(archive);
  await assert.rejects(api.library.importPackage({ ...preview }), /template_preview_required/);
  setRole('player');
  await assert.rejects(api.library.importPackage(preview), /library_gm_only/);
  setRole('gm');
  const world = api.getState().preferences.worldV2, originalId = world.id;
  world.id = 'another-world';
  await assert.rejects(api.library.importPackage(preview), /library_world_changed/);
  world.id = originalId;
  api.content.putTemplate = async () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(api.library.importPackage(preview), /QuotaExceededError/);
  assert.deepEqual(batches, []);
  assert.equal(world.actors.length, 1);
  assert.equal(world.templateLibrary, undefined);
});

test('library runtime revokes GM APIs when an offline client joins as Player or retains an audience projection', () => {
  const state = fixture(); let status = { connected: false };
  const button = { dataset: {}, addEventListener() {}, remove() {} };
  const doc = { createElement: () => button, querySelector: () => ({ append() {} }) };
  const api = { map: { getContainer: () => ({ ownerDocument: doc }) }, getState: () => state,
    multiplayer: { getStatus: () => status }, on: () => () => {} };
  createTemplateLibrarySystem().register(api);
  assert.deepEqual(api.library.list(), []);
  status = { connected: true, session: { role: 'player' } };
  assert.throws(() => api.library.list(), { code: 'library_gm_only' });
  status = { connected: false }; state.audienceProjection = true;
  assert.throws(() => api.library.list(), { code: 'library_gm_only' });
});

test('library metadata uses addressed changes and survives WAL replay without changing Actors or Scenes', () => {
  const before = fixture();
  const after = applyWorldOperations(before, [upsert(entry())], { ruleset }).state;
  assert.deepEqual(after.preferences.worldV2.actors, before.preferences.worldV2.actors);
  assert.deepEqual(after.preferences.worldV2.scenes, before.preferences.worldV2.scenes);
  const changes = createDocumentChanges(before, after);
  assert.equal(changes.length, 1);
  assert.deepEqual(Object.keys(changes[0].changed), ['templateLibrary']);
  assert.deepEqual(applyDocumentChanges(before, changes).preferences.worldV2.templateLibrary, { 'template-a': entry() });
  const replay = applyWorldOperationPatch(before, createWorldOperationPatch(before, after));
  assert.deepEqual(replay.preferences.worldV2.templateLibrary, after.preferences.worldV2.templateLibrary);
  assert.equal(normalizeLibraryEntry(replay.preferences.worldV2.templateLibrary['template-a']).extension.keep, true);
});

test('library metadata compare-and-swap prevents overwriting tags when the body reference is unchanged', () => {
  const first = applyWorldOperations(fixture(), [upsert(entry())], { ruleset }).state;
  const update = { type: 'world.library.upsert', payload: { entry: { ...entry(), tags: ['new'] }, expectedBodyRef: bodyRef, expectedEntry: entry() } };
  const second = applyWorldOperations(first, [update], { ruleset }).state;
  assert.throws(() => applyWorldOperations(second, [update], { ruleset }), { code: 'document_field_conflict' });
  const deletion = { type: 'world.library.delete', payload: { entryId: entry().id, expectedBodyRef: bodyRef, expectedEntry: second.preferences.worldV2.templateLibrary['template-a'] } };
  const third = applyWorldOperations(second, [deletion], { ruleset }).state;
  assert.deepEqual(applyWorldOperationPatch(second, createWorldOperationPatch(second, third)).preferences.worldV2.templateLibrary, {});
  assert.throws(() => applyWorldOperations(first, [{ ...update, payload: { ...update.payload, worldId: 'another-world' } }], { ruleset }), { code: 'document_target_mismatch' });
});

test('library identifiers and Document intent addresses reject malformed or mismatched targets', () => {
  assert.equal(normalizeLibraryEntry({ ...entry(), type: 'monster' }).type, 'monster');
  assert.throws(() => normalizeLibraryEntry({ ...entry(), id: '__proto__' }), { code: 'invalid_library_entry' });
  assert.throws(() => normalizeLibraryEntry({ ...entry(), tags: ['x'.repeat(41)] }), { code: 'invalid_library_tags' });
  assert.throws(() => documentWritesToWorldOperations([{ action: 'update', document: { type: 'Actor', id: 'actor-a' },
    intent: 'world.library.upsert', data: upsert(entry()).payload }]), { code: 'document_target_mismatch' });
});

test('GM-only library indexes and body references never enter Player changes or snapshots', () => {
  const before = fixture(), after = applyWorldOperations(before, [upsert(entry())], { ruleset }).state;
  const gm = projectStateForAudience(after, { role: 'gm' });
  assert.equal(gm.preferences.worldV2.templateLibrary['template-a'].bodyRef, bodyRef);
  const viewer = { role: 'player', userId: 'viewer', user: { ownership: {} } };
  const player = projectStateForAudience(after, viewer);
  assert.equal(player.preferences.worldV2.templateLibrary, undefined);
  assert.equal(JSON.stringify(player).includes(bodyRef), false);
  assert.deepEqual(createDocumentChanges(projectStateForAudience(before, viewer), player), []);
});

test('copying a template resets runtime consumption and authority without modifying its source', () => {
  const state = fixture(), source = state.preferences.worldV2.actors[0], original = structuredClone(source);
  source.effects = [{ id: 'temporary', definitionId: 'test', enabled: true }];
  const copy = copyActorTemplate(source, { ruleset, id: 'actor-copy' });
  assert.equal(copy.system.runtime.health.current, 30);
  assert.deepEqual(copy.system.runtime.health.wounds, { bashing: 0, lethal: 0, aggravated: 0 });
  assert.equal(copy.system.runtime.customResources[0].current, 9);
  assert.deepEqual(copy.system.runtime.customResources[0].extension, { retain: true });
  assert.deepEqual(copy.effects, []);
  assert.equal(copy.ownership, undefined);
  assert.equal(copy.partyId, null);
  assert.equal(canPlaceActorTemplate(copy, { actorTypes: ['npc'] }), false);
  assert.equal(canPlaceActorTemplate(copy, { actorIds: [copy.id] }), true);
  assert.equal(canPlaceActorTemplate(copy, { actorIds: `${copy.id}-not-granted` }), false);
  assert.equal(canPlaceActorTemplate(copy, null), false);
  assert.equal(defaultTokenVisibility(copy), 'gm');
  assert.deepEqual(copy.extension, original.extension);
  assert.equal(copy.notes, original.notes);
  assert.equal(source.system.runtime.health.current, original.system.runtime.health.current);
  assert.deepEqual(copy.system.forms, original.system.forms);
});

test('template copy and organization intents preserve existing instances and reject stale organization writes', () => {
  const before = fixture();
  const copied = applyWorldOperations(before, [{ type: 'actor.copy', payload: { actorId: 'actor-a', newActorId: 'actor-new' } }], { ruleset }).state;
  assert.equal(copied.preferences.worldV2.actors.length, 2);
  assert.deepEqual(copied.preferences.worldV2.actors[0], before.preferences.worldV2.actors[0]);
  assert.deepEqual(copied.preferences.worldV2.scenes, before.preferences.worldV2.scenes);
  const update = { type: 'actor.organization.update', payload: { actorId: 'actor-a', organization: { tags: ['one'], archived: true }, expected: {} } };
  const after = applyWorldOperations(copied, [update], { ruleset }).state;
  assert.equal(after.preferences.worldV2.actors[0].organization.archived, true);
  assert.deepEqual(after.preferences.worldV2.scenes, before.preferences.worldV2.scenes);
  assert.throws(() => applyWorldOperations(after, [update], { ruleset }), { code: 'document_field_conflict' });
});

test('template copy retains selected Health mode and maximum definitions while refilling consumption', () => {
  const actor = fixture().preferences.worldV2.actors[0];
  actor.system.runtime.health.mode = 'wound-track';
  actor.system.runtime.health.maxOverride = 40;
  actor.system.runtime.resources.stamina = { maxOverride: 8, current: 2, extension: true };
  const copy = copyActorTemplate(actor, { ruleset, id: 'actor-new' });
  assert.equal(copy.system.runtime.health.mode, 'wound-track');
  assert.equal(copy.system.runtime.health.maxOverride, 40);
  assert.deepEqual(copy.system.runtime.health.wounds, { bashing: 0, lethal: 0, aggravated: 0 });
  assert.equal(copy.system.runtime.resources.stamina.current, 8);
  assert.equal(copy.system.runtime.resources.stamina.extension, true);
});

test('library import previews every conflicting definition and remaps initial effects into a new Actor', () => {
  const world = fixture().preferences.worldV2;
  const current = { id: 'custom-state', name: 'Original', category: 'neutral' };
  world.statusDefinitions.push(current);
  const definition = { ...current, name: 'Imported' };
  const bundle = { schemaVersion: 1, kind: 'actor-template', ruleset: world.ruleset,
    actor: { ...world.actors[0], publicProfile: { ...world.actors[0].publicProfile, visibleStatusDefinitionIds: [current.id] },
      effects: [{ id: 'initial-state', definitionId: current.id, enabled: true, source: { actorId: world.actors[0].id }, extension: { keep: 1 } }] }, statusDefinitions: [definition] };
  assert.deepEqual(previewTemplateImport(bundle, world).conflicts, ['custom-state']);
  let count = 0;
  const prepared = prepareTemplateImport(bundle, world, { ruleset, idFactory: prefix => `${prefix}-new-${++count}` });
  assert.notEqual(prepared.actor.id, bundle.actor.id);
  assert.notEqual(prepared.actor.effects[0].id, 'initial-state');
  assert.equal(prepared.actor.effects[0].definitionId, prepared.remap['custom-state']);
  assert.equal(prepared.actor.effects[0].extension.keep, 1);
  assert.equal(prepared.actor.effects[0].source.actorId, prepared.actor.id);
  assert.deepEqual(prepared.actor.publicProfile.visibleStatusDefinitionIds, [prepared.remap['custom-state']]);
  assert.equal(world.statusDefinitions.at(-1).name, 'Original');
  assert.equal(prepared.actor.system.runtime.health.current, 30);
  assert.throws(() => previewTemplateImport({ ...bundle, ruleset: { ...bundle.ruleset, version: '9' } }, world), { code: 'template_ruleset_incompatible' });
});
