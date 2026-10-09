import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encodeResumePatch, decodeResumePatch } from '../deployment/local-server/resume-patch-codec.mjs';
import { createWorldOperationPatch, applyWorldOperationPatch } from '../src/world/operations.js';
import { createDocumentChanges } from '../src/documents/changes.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

const clone = structuredClone;
const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const source = server.slice(server.indexOf('const resumeHistory = [];'), server.indexOf('function findUser('));
const factory = new Function('world', 'Date', 'structuredClone', 'createHash', 'access', 'findUser', 'WORLD_ID', 'GM_SECRET',
  'createWorldOperationPatch', 'applyWorldOperationPatch', 'createDocumentChanges', 'audienceStateFor',
  'projectMotionForSession', 'encodeResumePatch', 'decodeResumePatch', `${source}; return {
    rememberResumeCommit, resumableCommits, audienceFingerprint, resetResumeHistory,
    history: () => resumeHistory, base: () => ({ revision: resumeBaseRevision, state: resumeBaseState }),
    setWorld: value => { world = value; }
  };`);

function harness({ encode = encodeResumePatch, decode = decodeResumePatch, copy = clone } = {}) {
  let now = 1000;
  class Clock extends Date { static now() { return now; } }
  let world = { state: worldCopyInput().state, revision: 0 };
  const user = { id: 'player', ownership: { 'actor-a': 'owner' }, disabled: false };
  const access = { schemaVersion: 4, users: [user] }, projections = [];
  const findUser = id => access.users.find(item => item.id === id) || null;
  const session = { role: 'player', userId: user.id, identityStatus: 'active', visionSourceTokenId: null, audienceRevision: 3 };
  const audience = (viewer, state) => {
    projections.push({ userId: viewer.userId, ownership: clone(findUser(viewer.userId)?.ownership || {}) });
    return projectStateForAudience(state, { role: viewer.role, userId: viewer.userId, user: findUser(viewer.userId),
      visionSourceTokenId: viewer.visionSourceTokenId, ruleset: copyRuleset, mapPackage: copyMap,
      mapMetrics: { metersPerUnit: copyMap.metersPerUnit } });
  };
  const api = factory(world, Clock, copy, createHash, access, findUser, 'world', 'secret',
    createWorldOperationPatch, applyWorldOperationPatch, createDocumentChanges, audience, () => [], encode, decode);
  return { ...api, user, access, session, projections, world: () => world,
    time(value) { now = value; },
    commit(edit = state => { state.preferences.worldV2.scenes[0].tokens[0].x++; }) {
      const before = world.state, after = clone(before); edit(after);
      const nextRevision = world.revision + 1;
      after.preferences.worldV2.updatedAt = `revision-${nextRevision}`;
      const patch = createWorldOperationPatch(before, after, { trustedCanonical: true });
      world = { state: after, revision: nextRevision }; api.setWorld(world);
      api.rememberResumeCommit({ beforeState: before, afterState: after, operationId: `operation-${nextRevision}`,
        baseRevision: nextRevision - 1, revision: nextRevision, updatedAt: `revision-${nextRevision}`,
        results: [], documentBatch: true, fog: [], patch });
      return { before, after, patch };
    },
  };
}

test('native resume encoding preserves negative zero, shared references and complete old patch replay', () => {
  const before = worldCopyInput().state, after = clone(before), shared = { negativeZero: -0, name: 'shared' };
  const fog = after.preferences.worldV2.scenes[0].fog;
  fog.extension = { first: shared, second: shared };
  fog.exploredByParty.party.rows['3'] = [[1, 5]];
  Object.freeze(fog);
  const patch = createWorldOperationPatch(before, after, { trustedCanonical: true });
  assert.equal(patch.world.scenes.fog[0].fog, fog, 'the old private patch retained the exact live Fog');
  const bytes = encodeResumePatch(patch), decoded = decodeResumePatch(bytes);
  assert.equal(Buffer.isBuffer(bytes), true);
  assert.equal(decoded.world.scenes.fog[0].fog.extension.first, decoded.world.scenes.fog[0].fog.extension.second);
  assert.notEqual(decoded.world.scenes.fog[0].fog, fog);
  assert.equal(Object.is(decoded.world.scenes.fog[0].fog.extension.first.negativeZero, -0), true);
  assert.deepEqual(applyWorldOperationPatch(before, decoded), applyWorldOperationPatch(before, patch));
  decoded.world.scenes.fog[0].fog.exploredByParty.party.rows['3'][0][0] = 99;
  assert.equal(fog.exploredByParty.party.rows['3'][0][0], 1);
  assert.equal(decodeResumePatch(bytes).world.scenes.fog[0].fog.exploredByParty.party.rows['3'][0][0], 1);
});

test('actual retained history contains only encoded patches and emits identical permission projections to live history', () => {
  const encoded = harness(), live = harness({ encode: value => value, decode: value => value });
  for (const edit of [
    state => { state.preferences.worldV2.actors[0].notes = 'private notes'; },
    state => { state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows['3'] = [[1, 4]]; },
    state => { state.preferences.worldV2.scenes[0].tokens[0].x = 30; },
  ]) { encoded.commit(edit); live.commit(edit); }
  assert.equal(encoded.history().length, 3);
  assert.ok(encoded.history().every(entry => Buffer.isBuffer(entry.patch)));
  const a = encoded.resumableCommits(encoded.session, 0, encoded.audienceFingerprint(encoded.session));
  const b = live.resumableCommits(live.session, 0, live.audienceFingerprint(live.session));
  assert.deepEqual(a, b);
  assert.equal(a.length, 3); assert.equal(encoded.projections.length, 4);
  assert.deepEqual(encoded.base().state, live.base().state);
});

test('resume encoding retains the full 256-entry capacity and existing five-minute expiry', () => {
  const h = harness();
  for (let index = 0; index < 258; index++) h.commit();
  assert.equal(h.history().length, 256); assert.equal(h.base().revision, 2);
  assert.equal(h.base().state.preferences.worldV2.scenes[0].tokens[0].x, 12);
  const fingerprint = h.audienceFingerprint(h.session);
  assert.equal(h.resumableCommits(h.session, 1, fingerprint), null);
  assert.deepEqual(h.resumableCommits(h.session, 258, fingerprint), []);
  h.time(1000 + 5 * 60_000); h.commit();
  assert.equal(h.history().length, 256, 'exact expiry boundary retains entries');
  h.time(1001 + 5 * 60_000); h.commit();
  assert.equal(h.history().length, 2); assert.equal(h.base().revision, 258);
  assert.equal(h.history()[0].revision, 259);
});

test('recipient, source and current permission changes keep the original strict fingerprint and re-projection boundary', () => {
  const h = harness();
  h.commit(state => { state.preferences.worldV2.actors[0].notes = 'SECRET-NOTES'; }); h.commit();
  const oldFingerprint = h.audienceFingerprint(h.session);
  assert.equal(h.resumableCommits({ ...h.session, userId: 'different' }, 0, oldFingerprint), null);
  assert.equal(h.resumableCommits({ ...h.session, visionSourceTokenId: 'token-a' }, 0, oldFingerprint), null);
  h.user.ownership = {};
  assert.equal(h.resumableCommits(h.session, 0, oldFingerprint), null);
  assert.equal(h.projections.length, 0, 'stale permission fingerprints cannot reach replay');
  const resumed = h.resumableCommits(h.session, 0, h.audienceFingerprint(h.session));
  assert.ok(resumed); assert.equal(resumed.length, 2); assert.equal(h.projections.length, 3);
  assert.ok(h.projections.every(call => Object.keys(call.ownership).length === 0));
  assert.equal(JSON.stringify(resumed).includes('SECRET-NOTES'), false, 'every historical state uses current permissions');
});

test('unexpected encoding failure clears private history without failing the durable commit', () => {
  let fail = false;
  const h = harness({ encode: value => { if (fail) throw new Error('unexpected encoding failure'); return encodeResumePatch(value); } });
  h.commit(); fail = true;
  assert.doesNotThrow(() => h.commit());
  assert.equal(h.world().revision, 2); assert.equal(h.history().length, 0); assert.equal(h.base().revision, 2);
  assert.deepEqual(h.base().state, h.world().state); assert.notEqual(h.base().state, h.world().state);
  assert.equal(h.resumableCommits(h.session, 1, h.audienceFingerprint(h.session)), null);
  fail = false; h.commit();
  assert.equal(h.history().length, 1); assert.equal(h.base().revision, 2);
  assert.equal(h.resumableCommits(h.session, 2, h.audienceFingerprint(h.session)).length, 1);
});

test('encoding plus detached-base failure still falls back safely to a full sync', () => {
  let fail = false;
  const h = harness({ encode: value => { if (fail) throw new Error('encoding failed'); return encodeResumePatch(value); },
    copy: value => { if (fail) throw new Error('clone failed'); return clone(value); } });
  h.commit(); fail = true;
  assert.doesNotThrow(() => h.commit());
  assert.equal(h.history().length, 0); assert.equal(h.base().state, null); assert.equal(h.base().revision, 2);
  assert.equal(h.resumableCommits(h.session, 1, h.audienceFingerprint(h.session)), null);
});

test('decode failures during reconnect or history eviction safely discard resume history', () => {
  let fail = false;
  const h = harness({ decode: value => { if (fail) throw new Error('decode failed'); return decodeResumePatch(value); } });
  h.commit(); fail = true;
  assert.equal(h.resumableCommits(h.session, 0, h.audienceFingerprint(h.session)), null);
  assert.equal(h.history().length, 0); assert.equal(h.base().revision, 1);
  fail = false;
  for (let index = 0; index < 256; index++) h.commit();
  fail = true;
  assert.doesNotThrow(() => h.commit());
  assert.equal(h.history().length, 0); assert.equal(h.base().revision, 258);
  assert.deepEqual(h.base().state, h.world().state);
});

test('corrupt encoded bytes are rejected without exposing a partial patch', () => {
  assert.throws(() => decodeResumePatch({ world: {} }), /Buffer/);
  assert.throws(() => decodeResumePatch(Buffer.from('not a native encoded patch')));
  assert.throws(() => encodeResumePatch({ invalid() {} }));
});
