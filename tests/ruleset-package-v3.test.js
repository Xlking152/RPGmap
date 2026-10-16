import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRulesetArchive, inspectRulesetArchive, RulesetPackageStore } from '../deployment/local-server/ruleset-store.mjs';
import { readMapArchiveFiles, writeMapArchiveFiles } from '../src/packages/map-archive.js';
import { RulesetRegistry } from '../src/ruleset/registry.js';
import { minimalRuleset } from '../src/rulesets/minimal/index.js';

const entry = (version = '1.0.0', suffix = '') => `export default {id:'rpgmap-minimal-test',title:'最小测试规则',version:'${version}',apiVersion:1,
actor:{createDefault:()=>({name:'Counter',system:{counter:5}})},movement:{describe:()=>({walk:true,swim:false})}};${suffix}`;
const archive = (version = '1.0.0', suffix = '') => buildRulesetArchive({ ruleset: { ...minimalRuleset, version }, entry: entry(version, suffix) });

test('trusted ruleset archives validate all hashes and contract compatibility before executing modules', async () => {
  const bytes = archive(), inspected = inspectRulesetArchive(bytes);
  assert.equal(inspected.manifest.entry, 'entry.mjs');
  assert.equal(inspected.manifest.formatVersion, 1);
  const files = readMapArchiveFiles(bytes, { validateFile: () => {} });
  files.set('entry.mjs', Buffer.from('throw new Error("should not execute")'));
  assert.throws(() => inspectRulesetArchive(writeMapArchiveFiles(files)), error => error.code === 'ruleset_archive_corrupt');
  const manifest = JSON.parse(inspected.files.get('manifest.json'));
  manifest.apiVersion = 99; inspected.files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => inspectRulesetArchive(writeMapArchiveFiles(inspected.files)), error => error.code === 'ruleset_archive_incompatible');
  manifest.apiVersion = 1; delete manifest.files[0].sha256;
  inspected.files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  assert.throws(() => inspectRulesetArchive(writeMapArchiveFiles(inspected.files)), error => error.code === 'ruleset_archive_corrupt');
});

test('ruleset installation loads an independent module, survives restart and preserves exact versions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-rules-'));
  try {
    const store = new RulesetPackageStore({ root }); await store.initialize();
    const first = await store.install(archive()), second = await store.install(archive('1.1.0'));
    assert.equal(first.reused, false);
    assert.equal((await store.install(archive())).reused, true);
    const repacked = buildRulesetArchive({ ruleset: minimalRuleset, entry: entry(),
      metadata: { sourceCommit: 'later-release', generatedAt: '2026-10-14T00:00:00Z' } });
    assert.equal(inspectRulesetArchive(repacked).fingerprint, first.fingerprint);
    assert.equal((await store.install(repacked)).reused, true);
    assert.match(first.entryUrl, /\/api\/packages\/rulesets\/rpgmap-minimal-test\/1.0.0\/files\/entry.mjs$/);
    const loaded = await store.get(first);
    assert.equal(loaded.actor.createDefault().system.counter, 5);
    assert.equal(loaded.movement.describe().swim, false);
    assert.equal((await store.get(second)).version, '1.1.0');
    await assert.rejects(store.get({ id: second.id, version: '9.9.9' }), error => error.code === 'ruleset_version_incompatible');
    await assert.rejects(store.install(archive('1.0.0', '// changed')), error => error.code === 'ruleset_package_version_conflict');
    const restarted = new RulesetPackageStore({ root }); await restarted.initialize();
    assert.equal((await restarted.get(first)).actor.createDefault().system.counter, 5);
    await assert.rejects(store.remove(first, { references: [{ ruleset: { id: first.id, version: first.version }, worldId: 'saved-world' }] }), error => error.code === 'ruleset_package_in_use');
    await store.remove(second); assert.equal(store.list().length, 1);
    await writeFile(store.file(first, 'entry.mjs'), 'export default {}');
    await assert.rejects(new RulesetPackageStore({ root }).initialize(), error => error.code === 'ruleset_archive_corrupt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an external package cannot replace or uninstall the application built-in ruleset version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-built-in-rule-'));
  try {
    const store = await new RulesetPackageStore({ root, builtins: [minimalRuleset] }).initialize();
    assert.equal(store.list()[0].builtIn, true);
    await assert.rejects(store.install(archive()), error => error.code === 'rule_builtin_version' && error.message.includes('已由应用内置'));
    await assert.rejects(store.install(archive('1.0.0', '// changed content')), error => error.code === 'rule_builtin_version');
    assert.equal((await store.get(minimalRuleset)).actor.createDefault().system.counter, 0);
    await assert.rejects(store.remove(minimalRuleset), error => error.code === 'rule_builtin_version');
    await assert.rejects(store.remove(minimalRuleset, { references: [{ ...minimalRuleset, worldId: 'saved-world' }] }), error => error.code === 'ruleset_package_in_use');
    const newer = await store.install(archive('1.1.0'));
    assert.equal((await store.get(newer)).actor.createDefault().system.counter, 5);
    assert.equal((await store.get(minimalRuleset)).actor.createDefault().system.counter, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uninstall preserves immutable version receipts across restarts while permitting the original content to be reimported', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-rule-version-receipt-'));
  try {
    const store = await new RulesetPackageStore({ root }).initialize(), first = await store.install(archive());
    await assert.rejects(store.remove(first, { references: [{ id: first.id, version: '9.0.0' }, { id: first.id, version: first.version, backupId: 'recovery-point' }] }),
      error => error.code === 'ruleset_package_in_use' && error.details.length === 1 && error.details[0].backupId === 'recovery-point');
    await store.remove(first, { references: [{ id: first.id, version: '9.0.0' }] });
    assert.equal(store.list().length, 0);
    const restarted = await new RulesetPackageStore({ root }).initialize();
    await assert.rejects(restarted.install(archive('1.0.0', '// changed')), error => error.code === 'ruleset_package_version_conflict');
    assert.equal(restarted.list().length, 0);
    assert.equal((await restarted.install(archive())).fingerprint, first.fingerprint);
    assert.equal((await restarted.get(first)).actor.createDefault().system.counter, 5);
    const history = JSON.parse(await readFile(path.join(root, '.versions.json'), 'utf8'));
    assert.equal(history.versions.length, 1);
    assert.equal(history.versions[0].fingerprint, first.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a rejected entry cannot poison a later module graph through Node import caching', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-rule-module-cache-'));
  const graphArchive = (title, valid) => buildRulesetArchive({ ruleset: { ...minimalRuleset, title },
    entry: `import {title} from './modules/shared.mjs'; export default {id:'${valid ? minimalRuleset.id : 'wrong-identity'}',title,version:'1.0.0',apiVersion:1};`,
    files: { 'modules/shared.mjs': Buffer.from(`export const title=${JSON.stringify(title)};`) } });
  try {
    const store = await new RulesetPackageStore({ root }).initialize();
    await assert.rejects(store.install(graphArchive('Rejected old dependency', false)), error => error.code === 'ruleset_package_identity_mismatch');
    assert.deepEqual(store.list(), []);
    const installed = await store.install(graphArchive('Accepted new dependency', true));
    assert.equal((await store.get(installed)).title, 'Accepted new dependency');
    assert.ok(store.file(installed, 'entry.mjs').includes(`content-${installed.fingerprint}`));
    assert.ok(store.file(installed, 'modules/shared.mjs').includes(`content-${installed.fingerprint}`));
    const restarted = await new RulesetPackageStore({ root }).initialize();
    assert.equal((await restarted.get(installed)).title, 'Accepted new dependency');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy flat package installations stay readable and cannot override a built-in version on restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-rule-flat-install-'));
  try {
    const bytes = archive(), inspected = inspectRulesetArchive(bytes), directory = path.join(root, minimalRuleset.id, minimalRuleset.version);
    await mkdir(directory, { recursive: true });
    for (const [name, payload] of inspected.files) await writeFile(path.join(directory, name), payload);
    await writeFile(path.join(directory, 'package.rpgrules'), bytes);
    const store = await new RulesetPackageStore({ root }).initialize();
    assert.equal((await store.get(minimalRuleset)).actor.createDefault().system.counter, 5);
    await assert.rejects(new RulesetPackageStore({ root, builtins: [minimalRuleset] }).initialize(), error => error.code === 'rule_builtin_version');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid executable entry never becomes an installed usable ruleset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-bad-rule-'));
  try {
    const store = new RulesetPackageStore({ root }); await store.initialize();
    const wrongIdentity = buildRulesetArchive({ ruleset: minimalRuleset, entry: entry('2.0.0') });
    await assert.rejects(store.install(wrongIdentity), error => error.code === 'ruleset_package_identity_mismatch');
    assert.equal(store.list().length, 0);
    assert.equal((await store.install(archive())).id, minimalRuleset.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ruleset registry preserves existing ID lookup and resolves World references by exact version', () => {
  const registry = new RulesetRegistry([minimalRuleset]);
  registry.register({ ...minimalRuleset, version: '1.1.0' });
  assert.equal(registry.require(minimalRuleset.id).version, '1.1.0');
  assert.equal(registry.resolveReference(minimalRuleset).version, '1.0.0');
  assert.equal(registry.resolveReference({ id: minimalRuleset.id, version: '1.1.0' }).version, '1.1.0');
  assert.throws(() => registry.resolveReference({ id: minimalRuleset.id, version: '9.0.0' }), error => error.code === 'ruleset_version_incompatible');
  assert.throws(() => registry.resolveReference({ id: 'unknown', version: '1.0.0' }), error => error.code === 'unknown_ruleset');
  registry.unregister(minimalRuleset); assert.equal(registry.has(minimalRuleset.id, '1.0.0'), false);
});
