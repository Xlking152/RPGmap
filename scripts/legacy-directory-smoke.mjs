import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { RulesetPackageStore } from '../deployment/local-server/ruleset-store.mjs';
import { ManagedWorldStore } from '../deployment/local-server/managed-worlds.mjs';
import { importLegacyDirectory } from '../deployment/local-server/legacy-import.mjs';
import { normalizeAccessState } from '../deployment/local-server/access-control.mjs';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { applyWorldOperationPatch } from '../deployment/local-server/world-operations.mjs';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = key => process.argv.find(value => value.startsWith(`${key}=`))?.slice(key.length + 1);
if (!option('--legacy-root') || !option('--map')) throw new Error('Expected --legacy-root=<v2.5.5 directory> and --map=<rpgmap>');
const legacyRoot = path.resolve(option('--legacy-root')), source = path.join(legacyRoot, 'map');
const mapFile = path.resolve(option('--map'));
const evidenceRoot = path.join(root, 'artifact', 'real-legacy-smoke');
await mkdir(evidenceRoot, { recursive: true });
const dataRoot = await mkdtemp(path.join(evidenceRoot, 'UserData-'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'source links are not supported');
    const name = path.posix.join(prefix, entry.name), file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await files(file, name));
    else result[name] = hash(await readFile(file));
  }
  return result;
}
const before = await files(source);
const version = JSON.parse(await readFile(path.join(legacyRoot, 'VERSION.json'), 'utf8'));
assert.equal(version.version, '2.5.5');
const maps = await new MapPackageStore({ root: path.join(dataRoot, 'packages', 'maps') }).initialize();
const map = await maps.install(await readFile(mapFile));
const rulesets = await new RulesetPackageStore({ root: path.join(dataRoot, 'packages', 'rulesets'), builtins: [infiniteHorrorRuleset] }).initialize();
const worlds = await new ManagedWorldStore({ root: dataRoot, maps, rulesets, validateState: assertWorldState }).initialize();
const imported = await importLegacyDirectory({ directory: source, root: dataRoot, worlds, rulesets });
const original = path.join(imported.receiptDirectory, 'original');
assert.deepEqual(await files(original), before, 'all original files have a byte-identical recovery copy');
const envelope = JSON.parse(await readFile(path.join(original, 'world.json'), 'utf8'));
const replayed = await createWorldWal({ filePath: path.join(original, 'world.operations.ndjson'),
  applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false, acceptedSchemaVersions: [3, 4] })
}).replay(envelope, { repairTail: false });
const stored = JSON.parse(await readFile(path.join(worlds.worldDirectory(imported.id), 'world.json'), 'utf8'));
const expectedWorld = structuredClone(replayed.state.preferences.worldV2); expectedWorld.id = imported.id;
assert.deepEqual(stored.state.preferences.worldV2, expectedWorld, 'current authority data survives WAL replay and import');
const originalAccess = normalizeAccessState(JSON.parse(await readFile(path.join(original, 'users.json'), 'utf8')));
assert.deepEqual(JSON.parse(await readFile(path.join(worlds.worldDirectory(imported.id), 'users.json'), 'utf8')), originalAccess);
if (replayed.exploration) {
  const expected = structuredClone(replayed.exploration); expected.worldEpoch = stored.exploration.worldEpoch;
  for (const job of Object.values(expected.jobs || {})) job.worldEpoch = expected.worldEpoch;
  assert.deepEqual(stored.exploration, expected);
}
await worlds.activate(imported.id);
const child = spawn(process.execPath, [path.join(root, 'deployment', 'local-server', 'server.mjs')], {
  env: { ...process.env, RPGMAP_DATA_DIR: dataRoot, RPGMAP_WORLD_ID: imported.id, PORT: '0',
    RPGMAP_MANAGER_SECRET: 'legacy-smoke-manager', RPGMAP_GM_SECRET: 'legacy-smoke-gm' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let stdout = '', stderr = '';
child.stderr.on('data', bytes => { stderr += bytes; });
const exited = new Promise(resolve => child.once('exit', resolve));
try {
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Imported server startup timeout')), 30000);
    child.stdout.on('data', bytes => { stdout += bytes; const match = /Local\s+: http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Imported server exited ${code}; ${stderr.slice(-500)}`)); });
  });
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then(response => response.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.world.worldId, imported.id);
  const installed = await fetch(`http://127.0.0.1:${port}/api/packages/maps/${map.id}/${map.version}`).then(response => response.json());
  assert.equal(installed.fingerprint, map.fingerprint);
  assert.deepEqual(await files(source), before, 'the user-provided source is untouched');
  const authority = stored.state.preferences.worldV2;
  await writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify({
    sourceVersion: version.version, sourceCommit: version.commit, sourceDirectory: source,
    sourceFileHashes: before, originalRevision: envelope.revision, replayedRevision: replayed.revision,
    map: { id: map.id, version: map.version, fingerprint: map.fingerprint },
    counts: { actors: authority.actors.length, scenes: authority.scenes.length,
      tokens: authority.scenes.reduce((total, scene) => total + scene.tokens.length, 0), users: originalAccess.users.length,
      acceptedExplorationJobs: Object.keys(stored.exploration?.jobs || {}).length },
    originalUnchanged: true, recoveryCopyVerified: true, authorityPreserved: true, accessPreserved: true,
    explorationPreserved: true, importedServerStarted: true, installedMapResolved: true,
    limitation: 'This checks actual user data with the source server on the development host; it is not a clean Windows or VPN test.',
  }, null, 2));
  console.log('Actual v2.5.5 import, WAL, permissions, recovery copy and server startup passed.');
} finally {
  if (child.connected) child.send('rpgmap.shutdown');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Imported server shutdown timeout')), 10000))]);
}
