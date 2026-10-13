import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedWorldStore, writeManagedJson } from '../deployment/local-server/managed-worlds.mjs';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { RulesetPackageStore, buildRulesetArchive } from '../deployment/local-server/ruleset-store.mjs';
import { commitStorageUpgrade } from '../deployment/local-server/storage-upgrade.mjs';
import { buildMapArchive } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { minimalRuleset } from '../src/rulesets/minimal/index.js';
import { createDefaultActor } from '../src/actor/model.js';
import { projectWorldV2ToRuntimeState } from '../src/world/model.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-managed-world-'));
  const maps = await new MapPackageStore({ root: path.join(root, 'packages', 'maps') }).initialize();
  const map = await maps.install(buildMapArchive({ data: createMinimalReferencePackage() }));
  const rulesets = { async get(ref) {
    if (ref?.id !== ruleset.id || ref?.version !== ruleset.version) throw Object.assign(new Error('unknown_ruleset'), { code: 'unknown_ruleset' });
    return ruleset;
  } };
  const worlds = await new ManagedWorldStore({ root, maps, rulesets, validateState: assertWorldState }).initialize();
  const create = name => worlds.create({ name, ruleset: { id: ruleset.id, version: ruleset.version }, mapPackage: map });
  const snapshot = async id => JSON.parse(await readFile(path.join(worlds.worldDirectory(id), 'world.json'), 'utf8'));
  return { root, maps, map, rulesets, worlds, create, snapshot,
    async cleanup() { await rm(root, { recursive: true, force: true }); } };
}

test('managed Worlds persist Unicode names, independent identities, exact dependencies and the active selection', async () => {
  const f = await fixture();
  try {
    assert.equal(f.worlds.activeId(), null); assert.deepEqual(f.worlds.list(), []);
    const first = await f.create('兰州 / 冒险 <测试>'), second = await f.create('第二场游戏');
    assert.notEqual(first.id, second.id);
    const loaded = await f.worlds.activate(first.id);
    assert.equal(loaded.worldId, first.id);
    assert.equal(loaded.state.preferences.worldV2.id, first.id);
    assert.equal(loaded.state.preferences.worldV2.name, '兰州 / 冒险 <测试>');
    assert.deepEqual(loaded.state.preferences.worldV2.ruleset, { id: ruleset.id, version: ruleset.version });
    assert.deepEqual(loaded.state.preferences.worldV2.scenes[0].mapPackage, { id: f.map.id, version: f.map.version });
    const restarted = await new ManagedWorldStore({ root: f.root, maps: f.maps, rulesets: f.rulesets, validateState: assertWorldState }).initialize();
    assert.equal(restarted.activeId(), first.id);
    assert.deepEqual(restarted.list().map(item => item.id).sort(), [first.id, second.id].sort());
    const copy = restarted.list(); copy[0].name = 'Mutated UI';
    assert.equal(restarted.list()[0].name, '兰州 / 冒险 <测试>');
    await assert.rejects(restarted.activate('world-missing'), error => error.code === 'world_not_found');
  } finally { await f.cleanup(); }
});

test('import keeps campaign state and generates a fresh ID when the original already exists', async () => {
  const f = await fixture();
  try {
    const original = await f.create('Imported campaign'), envelope = await f.snapshot(original.id);
    const before = structuredClone(envelope);
    const imported = await f.worlds.import(envelope);
    assert.notEqual(imported.id, original.id);
    assert.equal(imported.importedFrom, original.id);
    assert.deepEqual(envelope, before, 'import must not rewrite its caller-owned input');
    const actual = await f.snapshot(imported.id);
    assert.equal(actual.worldId, imported.id);
    assert.equal(actual.state.preferences.worldV2.id, imported.id);
    assert.deepEqual(actual.state.preferences.worldV2.scenes, before.state.preferences.worldV2.scenes);
    assert.deepEqual(actual.state.preferences.worldV2.actors, before.state.preferences.worldV2.actors);
    assert.equal(actual.revision, 0, 'import starts a new authority history');
    assert.deepEqual(await f.snapshot(original.id), before, 'existing campaign is not overwritten');
    const unsafe = structuredClone(before); unsafe.state.preferences.worldV2.id = '../escape';
    await assert.rejects(f.worlds.import(unsafe));
    assert.equal(f.worlds.list().length, 2);
    await assert.rejects(f.worlds.create({ name: 'Missing map', ruleset, mapPackage: { id: f.map.id, version: '9.9.9' } }), error => error.code === 'map_package_not_found');
    await assert.rejects(f.worlds.create({ name: 'Missing rule', ruleset: { id: 'missing-rule', version: '1.0.0' }, mapPackage: f.map }), error => error.code === 'unknown_ruleset');
    assert.equal(f.worlds.list().length, 2);
  } finally { await f.cleanup(); }
});

test('backup restore preserves content and access, creates a recovery point, and removes abandoned WAL history', async () => {
  const f = await fixture();
  try {
    const descriptor = await f.create('Restore campaign'), original = await f.snapshot(descriptor.id);
    const access = { schemaVersion: 1, users: [{ id: 'gm', role: 'gm', credentialHash: 'fixture-hash' }] };
    const backup = await f.worlds.backup({ worldId: descriptor.id, snapshot: original, access, reason: 'before-map-reset', sceneId: original.state.preferences.worldV2.activeSceneId });
    const changed = structuredClone(original); changed.revision = 14; changed.state.preferences.worldV2.name = 'Changed campaign';
    await writeManagedJson(path.join(f.worlds.worldDirectory(descriptor.id), 'world.json'), changed);
    await writeFile(path.join(f.worlds.worldDirectory(descriptor.id), 'world.operations.ndjson'), '{"revision":15}\n');
    await f.worlds.restore({ worldId: descriptor.id, backupId: backup.id });
    assert.deepEqual(await f.snapshot(descriptor.id), original);
    const restoredAccess = JSON.parse(await readFile(path.join(f.worlds.worldDirectory(descriptor.id), 'users.json'), 'utf8'));
    assert.deepEqual(restoredAccess, access);
    assert.equal(await readFile(path.join(f.worlds.worldDirectory(descriptor.id), 'world.operations.ndjson'), 'utf8'), '');
    const backups = await f.worlds.backups(descriptor.id);
    assert.equal(backups.length, 2);
    const rollback = backups.find(item => item.record.reason === 'before-restore');
    assert.deepEqual(rollback.record.snapshot, changed, 'restore itself remains recoverable');
  } finally { await f.cleanup(); }
});

test('tampered backups cannot be restored or bypass package reference safeguards', async () => {
  const f = await fixture();
  try {
    const descriptor = await f.create('Checksum campaign'), before = await f.snapshot(descriptor.id);
    const backup = await f.worlds.backup({ worldId: descriptor.id });
    const file = path.join(f.root, 'backups', `${backup.id}.json`), stored = JSON.parse(await readFile(file, 'utf8'));
    stored.record.snapshot.state.preferences.worldV2.name = 'Tampered';
    await writeManagedJson(file, stored);
    await assert.rejects(f.worlds.restore({ worldId: descriptor.id, backupId: backup.id }), error => error.code === 'backup_checksum_invalid');
    assert.deepEqual(await f.snapshot(descriptor.id), before);
    await assert.rejects(f.worlds.references(f.map), error => error.code === 'backup_checksum_invalid');
    assert.equal(f.maps.get(f.map).id, f.map.id);
  } finally { await f.cleanup(); }
});

test('references cover all Scenes, exact map versions, active snapshots and backups before uninstall', async () => {
  const f = await fixture();
  try {
    const other = await f.maps.install(buildMapArchive({ data: { ...createMinimalReferencePackage(), version: '1.3.0' } }));
    const unused = await f.maps.install(buildMapArchive({ data: { ...createMinimalReferencePackage(), version: '1.4.0' } }));
    const descriptor = await f.create('Multi-map campaign'), envelope = await f.snapshot(descriptor.id);
    const scene = structuredClone(envelope.state.preferences.worldV2.scenes[0]);
    scene.id = 'second-map-scene'; scene.name = 'Second map'; scene.mapPackage = { id: other.id, version: other.version };
    envelope.state.preferences.worldV2.scenes.push(scene);
    await writeManagedJson(path.join(f.worlds.worldDirectory(descriptor.id), 'world.json'), envelope);
    const backup = await f.worlds.backup({ worldId: descriptor.id });
    const firstRefs = await f.worlds.references(f.map), otherRefs = await f.worlds.references(other);
    assert.equal(firstRefs.length, 2); assert.equal(otherRefs.length, 2);
    assert.ok(otherRefs.some(ref => ref.sceneId === scene.id && ref.backupId === backup.id));
    await assert.rejects(f.maps.remove(other, { references: otherRefs }), error => error.code === 'map_package_in_use');
    const active = structuredClone(envelope); active.state.preferences.worldV2.scenes = [active.state.preferences.worldV2.scenes[0]];
    const retained = await f.worlds.references(other, { activeSnapshot: active });
    assert.equal(retained.length, 1); assert.equal(retained[0].backupId, backup.id);
    await assert.rejects(f.maps.remove(other, { references: retained }), error => error.code === 'map_package_in_use');
    assert.equal((await f.worlds.references(ruleset, { type: 'ruleset' })).length, 2);
    assert.deepEqual(await f.worlds.references(unused), []);
    await f.maps.remove(unused, { references: await f.worlds.references(unused) });
    assert.throws(() => f.maps.get(unused), error => error.code === 'map_package_not_found');
  } finally { await f.cleanup(); }
});

test('concurrent World creation retains every successful campaign in the durable catalog', async () => {
  const f = await fixture();
  try {
    const created = await Promise.all([f.create('First simultaneous campaign'), f.create('Second simultaneous campaign')]);
    assert.equal(f.worlds.list().length, 2);
    const restarted = await new ManagedWorldStore({ root: f.root, maps: f.maps, rulesets: f.rulesets, validateState: assertWorldState }).initialize();
    assert.deepEqual(restarted.list().map(item => item.id).sort(), created.map(item => item.id).sort());
    for (const descriptor of created) assert.equal((await restarted.activate(descriptor.id)).worldId, descriptor.id);
  } finally { await f.cleanup(); }
});

test('activation never adopts another campaign identity from a misplaced snapshot file', async () => {
  const f = await fixture();
  try {
    const first = await f.create('Original campaign'), second = await f.create('Different campaign');
    await f.worlds.activate(first.id);
    await writeManagedJson(path.join(f.worlds.worldDirectory(second.id), 'world.json'), await f.snapshot(first.id));
    await assert.rejects(f.worlds.activate(second.id));
    assert.equal(f.worlds.activeId(), first.id, 'a mismatched snapshot cannot change active campaign');
  } finally { await f.cleanup(); }
});

test('automatic World checkpoints protect their exact map and rule dependencies after the current campaign changes', async () => {
  const f = await fixture();
  try {
    const rules = await new RulesetPackageStore({ root: path.join(f.root, 'packages', 'rulesets') }).initialize();
    const entry = await readFile(new URL('../src/rulesets/minimal/index.js', import.meta.url), 'utf8');
    const oldRule = await rules.install(buildRulesetArchive({ ruleset: minimalRuleset, entry }));
    const newRule = await rules.install(buildRulesetArchive({ ruleset: { ...minimalRuleset, version: '1.1.0' }, entry: entry.replace("version: '1.0.0'", "version: '1.1.0'") }));
    const newMap = await f.maps.install(buildMapArchive({ data: { ...createMinimalReferencePackage(), version: '1.3.0' } }));
    const worlds = await new ManagedWorldStore({ root: f.root, maps: f.maps, rulesets: rules, validateState: assertWorldState }).initialize();
    const descriptor = await worlds.create({ name: 'Retained checkpoint', ruleset: oldRule, mapPackage: f.map });
    const before = await f.snapshot(descriptor.id), current = structuredClone(before);
    current.state.preferences.worldV2.ruleset = { id: newRule.id, version: newRule.version };
    current.state.preferences.worldV2.scenes[0].mapPackage = { id: newMap.id, version: newMap.version };
    await worlds.validateDependencies(current.state);
    await writeManagedJson(path.join(worlds.worldDirectory(descriptor.id), 'backups', 'world.backup.fixture.json'), before);
    await writeManagedJson(path.join(worlds.worldDirectory(descriptor.id), 'world.json'), current);
    const mapRefs = await worlds.references(f.map), ruleRefs = await worlds.references(oldRule, { type: 'ruleset' });
    assert.equal(mapRefs.length, 1); assert.equal(ruleRefs.length, 1);
    assert.ok(mapRefs[0].backupId.startsWith('automatic:'));
    assert.equal(mapRefs[0].worldId, descriptor.id);
    await assert.rejects(f.maps.remove(f.map, { references: mapRefs }), error => error.code === 'map_package_in_use');
    await assert.rejects(rules.remove(oldRule, { references: ruleRefs }), error => error.code === 'ruleset_package_in_use');
    await rm(path.join(worlds.worldDirectory(descriptor.id), 'backups', 'world.backup.fixture.json'));
    assert.deepEqual(await worlds.references(f.map), []);
    assert.deepEqual(await worlds.references(oldRule, { type: 'ruleset' }), []);
    await f.maps.remove(f.map); await rules.remove(oldRule);
    assert.equal((await worlds.activate(descriptor.id)).state.preferences.worldV2.ruleset.version, '1.1.0');
  } finally { await f.cleanup(); }
});

test('storage upgrade rollback sets protect old map, rule and image dependencies and reject tampered recovery bytes', async () => {
  const f = await fixture();
  try {
    const rules = await new RulesetPackageStore({ root: path.join(f.root, 'packages', 'rulesets') }).initialize();
    const entry = await readFile(new URL('../src/rulesets/minimal/index.js', import.meta.url), 'utf8');
    const oldRule = await rules.install(buildRulesetArchive({ ruleset: minimalRuleset, entry }));
    const newRule = await rules.install(buildRulesetArchive({ ruleset: { ...minimalRuleset, version: '1.1.0' }, entry: entry.replace("version: '1.0.0'", "version: '1.1.0'") }));
    const newMap = await f.maps.install(buildMapArchive({ data: { ...createMinimalReferencePackage(), version: '1.3.0' } }));
    const worlds = await new ManagedWorldStore({ root: f.root, maps: f.maps, rulesets: rules, validateState: assertWorldState }).initialize();
    const descriptor = await worlds.create({ name: 'Upgrade rollback', ruleset: oldRule, mapPackage: f.map });
    const before = await f.snapshot(descriptor.id), current = structuredClone(before);
    const reference = `asset:${'a'.repeat(64)}`;
    const actor = createDefaultActor({ id: 'old-image-actor', ruleset: await rules.get(oldRule) }); actor.img = reference;
    const historicalWorld = structuredClone(before.state.preferences.worldV2); historicalWorld.actors = [actor];
    before.state = projectWorldV2ToRuntimeState(before.state, historicalWorld, { mapPackage: f.maps.get(f.map), ruleset: await rules.get(oldRule) });
    await worlds.validateDependencies(before.state);
    await writeManagedJson(path.join(worlds.worldDirectory(descriptor.id), 'world.json'), before);
    current.state.preferences.worldV2.ruleset = { id: newRule.id, version: newRule.version };
    current.state.preferences.worldV2.scenes[0].mapPackage = { id: newMap.id, version: newMap.version };
    const receipt = await commitStorageUpgrade(worlds.restoreLayout(descriptor.id), { 'world.json': Buffer.from(JSON.stringify(current)) });
    const mapRefs = await worlds.references(f.map), ruleRefs = await worlds.references(oldRule, { type: 'ruleset' });
    assert.equal(mapRefs.length, 1); assert.equal(ruleRefs.length, 1);
    assert.ok(mapRefs[0].backupId.startsWith('upgrade:') && mapRefs[0].backupId.endsWith('/before'));
    await assert.rejects(f.maps.remove(f.map, { references: mapRefs }), error => error.code === 'map_package_in_use');
    await assert.rejects(rules.remove(oldRule, { references: ruleRefs }), error => error.code === 'ruleset_package_in_use');
    assert.equal(await worlds.retainsContent(reference), true);
    await writeFile(path.join(receipt.backupDirectory, 'before', 'world.json'), JSON.stringify(current));
    await assert.rejects(worlds.references(f.map), error => error.code === 'backup_checksum_invalid');
    await assert.rejects(worlds.references(oldRule, { type: 'ruleset' }), error => error.code === 'backup_checksum_invalid');
  } finally { await f.cleanup(); }
});
