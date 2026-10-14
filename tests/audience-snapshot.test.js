import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAudienceSnapshotChanges } from '../src/multiplayer/audience-snapshot.js';
import { applyDocumentChanges } from '../src/documents/changes.js';

const state = () => ({ preferences: { worldV2: { id: 'world', schemaVersion: 4, activeSceneId: 'scene',
  ruleset: { id: 'rules', version: '1' }, actors: [{ id: 'actor', system: { private: 'secret', public: true } }],
  statusDefinitions: [], journals: [], scenes: [{ id: 'scene', mapPackage: { id: 'map', version: '1' },
    tokens: [{ id: 'token', actorId: 'actor', x: 1, y: 2 }], markers: [], attackAreas: [], sceneEvents: [],
    featureStates: {}, fog: { exploredByParty: { party: { rows: { 0: [[0, 2]] } } } } }] },
  audienceVision: { source: null } } });
const context = () => ({ reason: 'vision.source.set', loadedMap: { id: 'map', version: '1' },
  loadedRuleset: { id: 'rules', version: '1' }, currentRevision: 4, nextRevision: 4 });

test('source projection diff preserves deletion paths, filtered entities and Fog notifications', () => {
  const before = state(), after = structuredClone(before);
  delete after.preferences.worldV2.actors[0].system.private;
  after.preferences.worldV2.scenes[0].tokens = [];
  after.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[0] = [[0, 9]];
  after.preferences.audienceVision.source = { tokenId: 'new-source' };
  const delta = sourceAudienceSnapshotChanges(before, after, context());
  assert.deepEqual(delta.changes.find(change => change.document.type === 'Actor').removed, [['system', 'private']]);
  assert(delta.changes.some(change => change.document.type === 'Token' && change.action === 'delete'));
  assert.deepEqual(delta.changeSet.tokens[0].removeIds, ['token']);
  assert.deepEqual(delta.changeSet.fog, [{ sceneId: 'scene', dirtyBounds: null }]);
  const projected = applyDocumentChanges(before, delta.changes);
  assert.deepEqual(projected.preferences.worldV2, after.preferences.worldV2);
  assert.deepEqual(projected.preferences.audienceVision, after.preferences.audienceVision);
});

for (const mismatch of ['reason', 'loaded-map', 'loaded-rules', 'world', 'scene', 'rules', 'map', 'schema', 'pending', 'older-revision', 'unknown']) {
  test(`source projection ${mismatch} uncertainty retains full-import fallback`, () => {
    const before = state(), after = structuredClone(before), options = context();
    if (mismatch === 'reason') options.reason = 'permissions.changed';
    else if (mismatch === 'loaded-map') options.loadedMap.version = '2';
    else if (mismatch === 'loaded-rules') options.loadedRuleset.version = '2';
    else if (mismatch === 'world') after.preferences.worldV2.id = 'elsewhere';
    else if (mismatch === 'scene') after.preferences.worldV2.activeSceneId = 'missing';
    else if (mismatch === 'rules') after.preferences.worldV2.ruleset.version = '2';
    else if (mismatch === 'map') after.preferences.worldV2.scenes[0].mapPackage.version = '2';
    else if (mismatch === 'schema') after.preferences.worldV2.schemaVersion = 5;
    else if (mismatch === 'pending') options.sceneTransitionPending = true;
    else if (mismatch === 'older-revision') options.nextRevision = 3;
    else delete after.preferences.worldV2;
    assert.equal(sourceAudienceSnapshotChanges(before, after, options), null);
  });
}
