import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const source = server.slice(server.indexOf('function audienceFingerprint('), server.indexOf('function advanceResumeBase('));
const fingerprintFactory = new Function('createHash', 'access', 'findUser', 'WORLD_ID', 'GM_SECRET',
  `${source}; return audienceFingerprint;`);
function setup() {
  const user = { id: 'player', name: 'Player', ownership: { actor: 'owner' }, defaultActorId: 'actor',
    placementGrants: { actorTypes: [], actorIds: [], markerKinds: [] }, disabled: false,
    lineOfSightOverride: null, updatedAt: 'fixed', authHash: 'credential' };
  const access = { schemaVersion: 4, revision: 1, users: [user] };
  const session = { role: 'player', userId: user.id, identityStatus: 'active', visionSourceTokenId: 'scout' };
  const create = (world = 'world', secret = 'secret') => fingerprintFactory(createHash, access,
    id => access.users.find(item => item.id === id) || null, world, secret);
  return { access, user, session, create, fingerprint: create() };
}

test('unrelated access updates retain a recipient fingerprint without sharing recipient identity', () => {
  const { access, session, fingerprint } = setup();
  const before = fingerprint(session);
  assert.match(before, /^[a-f0-9]{24}$/);
  access.revision++;
  access.users.push({ id: 'other', ownership: { privateActor: 'owner' }, disabled: false });
  assert.equal(fingerprint(session), before);
  access.users[1].ownership = {}; access.users[1].disabled = true; access.revision++;
  assert.equal(fingerprint(session), before);
  access.users.pop(); access.revision++;
  assert.equal(fingerprint(session), before);
  assert.notEqual(fingerprint({ ...session, userId: 'other' }), before);
  assert.notEqual(fingerprint({ ...session, role: 'gm', userId: null }), before);
});

test('all current recipient fields, source, identity, schema and opaque-ID scope invalidate resume', () => {
  for (const edit of [user => { user.ownership = { actor: 'observer' }; },
    user => { user.defaultActorId = null; }, user => { user.placementGrants.actorIds.push('new-actor'); },
    user => { user.disabled = true; }, user => { user.lineOfSightOverride = false; },
    user => { user.futureVisibilityPolicy = { mode: 'private' }; }, user => { user.authHash = 'new-credential'; }]) {
    const { user, session, fingerprint } = setup();
    const before = fingerprint(session); edit(user);
    assert.notEqual(fingerprint(session), before);
  }
  const { access, session, fingerprint, create } = setup();
  const before = fingerprint(session);
  for (const changed of [{ visionSourceTokenId: 'other' }, { visionSourceTokenId: null },
    { identityStatus: 'pending' }, { role: 'observer' }]) assert.notEqual(fingerprint({ ...session, ...changed }), before);
  assert.notEqual(create('other-world')(session), before);
  assert.notEqual(create('world', 'changed-opaque-seed')(session), before);
  access.schemaVersion++;
  assert.notEqual(fingerprint(session), before);
  access.users = [];
  assert.notEqual(fingerprint(session), before);
});
