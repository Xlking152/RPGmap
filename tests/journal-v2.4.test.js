import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { journalBodyBlob, inspectContent, JOURNAL_BODY_TYPE } from '../src/content/body.js';
import { renderJournalMarkdown } from '../src/journal/markdown.js';
import { normalizeWorldV2 } from '../src/world/model.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { createDocumentChanges, applyDocumentChanges } from '../src/documents/changes.js';
import { documentWritesToWorldOperations } from '../src/documents/protocol.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { createContentStorage } from '../deployment/local-server/content-storage.mjs';
import { sendJson } from '../deployment/local-server/http-runtime.mjs';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=', 'base64');
const imageReference = `asset:${createHash('sha256').update(png).digest('hex')}`;
function entry(id, bodyRef, visibility = { mode: 'gm', userIds: [] }, partyId = null) {
  return { id, title: id, bodyRef, folder: '', visibility, partyId, updatedAt: '2026-01-01T00:00:00.000Z', extension: { kept: true } };
}

function state(journals = []) {
  const mapPackage = { id: 'test-map', version: '1.0.0', title: 'Test' };
  const world = normalizeWorldV2({
    schemaVersion: 4, id: 'world', name: 'World', ruleset: { id: infiniteHorrorRuleset.id, version: infiniteHorrorRuleset.version },
    activeSceneId: 'scene', actors: [{ id: 'pc', name: 'PC', type: 'pc', partyId: 'party-a', system: {}, effects: [] }],
    statusDefinitions: [], journals,
    scenes: [{ id: 'scene', name: 'Scene', mapPackage: { id: mapPackage.id, version: mapPackage.version }, tokens: [], markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, fog: {}, settings: {} }],
  }, { mapPackage, ruleset: infiniteHorrorRuleset });
  return { preferences: { worldV2: world, entitySystem: { schemaVersion: 4, actors: world.actors, tokens: [], statusDefinitions: world.statusDefinitions } } };
}

test('Journal bodies allow bounded Markdown and approved images while rejecting active embeds', async () => {
  const blob = journalBodyBlob({ markdown: '# Brief\n**Safe** [link](https://example.com)', images: [imageReference, imageReference] });
  const metadata = inspectContent(new Uint8Array(await blob.arrayBuffer()), blob.type);
  assert.equal(blob.type, JOURNAL_BODY_TYPE);
  assert.deepEqual(metadata.dependencies, [imageReference]);
  assert.throws(() => journalBodyBlob({ markdown: '<script>alert(1)</script>' }), { code: 'journal_raw_html_forbidden' });
  assert.throws(() => journalBodyBlob({ markdown: '![inline](https://example.com/x.png)' }), { code: 'journal_embed_forbidden' });
  const rendered = renderJournalMarkdown('<img src=x onerror=alert(1)> **ok** [bad](javascript:alert(1))');
  assert.equal(rendered.includes('<img'), false);
  assert.equal(rendered.includes('href="#"'), true);
});

test('Journal operations are addressed, conflict checked and preserved by incremental Documents', () => {
  const source = state();
  const bodyRef = `body:${'a'.repeat(64)}`;
  const journal = entry('journal-a', bodyRef, { mode: 'public', userIds: [] });
  const [operation] = documentWritesToWorldOperations([{
    action: 'create', document: { type: 'Journal', id: journal.id, parent: null },
    intent: 'journal.upsert', data: { journal, expected: null },
  }]);
  const committed = applyWorldOperations(source, [operation], { ruleset: infiniteHorrorRuleset, now: '2026-01-02T00:00:00.000Z' }).state;
  assert.deepEqual(committed.preferences.worldV2.journals[0].extension, { kept: true });
  assert.throws(() => applyWorldOperations(committed, [operation], { ruleset: infiniteHorrorRuleset }), { code: 'document_field_conflict' });
  const changes = createDocumentChanges(source, committed);
  assert.deepEqual(changes.map(change => [change.action, change.document.type, change.document.id]), [['create', 'Journal', 'journal-a']]);
  assert.deepEqual(applyDocumentChanges(source, changes).preferences.worldV2.journals, committed.preferences.worldV2.journals);
});

test('Audience projection exposes only public, owned-party, and explicitly shared Journal metadata', () => {
  const refs = ['a', 'b', 'c', 'd', 'e'].map(character => `body:${character.repeat(64)}`);
  const source = state([
    entry('gm', refs[0]),
    entry('public', refs[1], { mode: 'public', userIds: [] }),
    entry('party', refs[2], { mode: 'party', userIds: [] }, 'party-a'),
    entry('other-party', refs[3], { mode: 'party', userIds: [] }, 'party-b'),
    entry('user', refs[4], { mode: 'users', userIds: ['player'] }),
  ]);
  const projection = projectStateForAudience(source, { role: 'player', userId: 'player', user: { ownership: { pc: 'owner' } } });
  assert.deepEqual(projection.preferences.worldV2.journals.map(value => value.id), ['public', 'party', 'user']);
  assert.equal(projection.preferences.worldV2.journals.every(value => value.extension.kept), true);
  assert.equal(projectStateForAudience(source, { role: 'gm' }).preferences.worldV2.journals.length, 5);
});

test('LAN content reads reauthorize projected Journal bodies and only their approved image dependencies', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-journal-'));
  let projection = state();
  const sessions = { gm: { role: 'gm', userId: 'gm' }, player: { role: 'player', userId: 'player' } };
  const store = createContentStorage({ directory, getState: () => projection, getProjection: () => projection,
    authenticate: req => sessions[req.headers.authorization], serialize: task => task() });
  const server = http.createServer((req, res) => store.handle(req, res, sendJson));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/api/content`;
  const request = (suffix, role, options = {}) => fetch(url + suffix, { ...options, headers: { Authorization: role, ...options.headers } });
  const imageUpload = await (await request('', 'gm', { method: 'POST', body: png, headers: { 'Content-Type': 'image/png' } })).json();
  assert.equal(imageUpload.reference, imageReference);
  const bodyBlob = journalBodyBlob({ markdown: '# Shared', images: [imageReference] });
  const bodyUpload = await (await request('', 'gm', { method: 'POST', body: bodyBlob, headers: { 'Content-Type': bodyBlob.type } })).json();
  assert.equal((await request(`/${bodyUpload.id}`, 'player')).status, 404);
  projection = state([entry('shared', bodyUpload.reference, { mode: 'public', userIds: [] })]);
  assert.equal((await request(`/${bodyUpload.id}`, 'player')).status, 200);
  assert.equal((await request(`/${imageUpload.id}`, 'player')).status, 200);
  projection = state();
  assert.equal((await request(`/${bodyUpload.id}`, 'player')).status, 404);
  assert.equal((await request(`/${imageUpload.id}`, 'player')).status, 404);
});
