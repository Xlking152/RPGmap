import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { RulesetPackageStore } from '../deployment/local-server/ruleset-store.mjs';
import { ManagedWorldStore } from '../deployment/local-server/managed-worlds.mjs';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { serverRuleset } from '../deployment/local-server/ruleset-authority.mjs';
import { readUiReviewOptions } from './ui-review-options.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { artReview, mapVersion, sessionName, archiveDirectory } = readUiReviewOptions(process.argv.slice(2));
const output = path.join(root, 'output', sessionName);
const appDirectory = artReview ? path.join(output, 'app') : path.join(root, 'dist');
const dataRoot = path.join(output, 'data');
await mkdir(output, { recursive: true });
await readFile(path.join(appDirectory, 'index.html'));
const maps = await new MapPackageStore({ root: path.join(dataRoot, 'packages', 'maps') }).initialize();
const mapReference = { id: 'northern-song-lanzhou-1104', version: mapVersion };
if (!maps.list().some(map => map.id === mapReference.id && map.version === mapReference.version)) {
  const archive = artReview ? path.join(root, 'output', archiveDirectory, `北宋兰州城-${mapVersion}.rpgmap`)
    : path.join(root, 'output', 'ui-refresh', 'content-packages', '北宋兰州城-1.1.0.rpgmap');
  await maps.install(await readFile(archive));
}
const rulesets = await new RulesetPackageStore({ root: path.join(dataRoot, 'packages', 'rulesets'), builtins: [serverRuleset] }).initialize();
const worlds = await new ManagedWorldStore({ root: dataRoot, maps, rulesets, validateState: assertWorldState }).initialize();
let world = worlds.list()[0];
if (world) {
  const saved = JSON.parse(await readFile(path.join(worlds.worldDirectory(world.id), 'world.json'), 'utf8')).state?.preferences?.worldV2;
  const reference = saved?.scenes?.find(scene => scene.id === saved.activeSceneId)?.mapPackage;
  if (reference?.id !== mapReference.id || reference?.version !== mapReference.version) {
    throw new Error('The existing review World uses another map; its data will not be replaced');
  }
}
if (!world) {
  world = await worlds.create({ name: artReview ? '兰州城 · 美术样板' : '新版界面试玩 · 独立世界', ruleset: { id: serverRuleset.id, version: serverRuleset.version }, mapPackage: mapReference });
}
await worlds.activate(world.id);
const gmSecret = randomBytes(32).toString('hex');
const managerSecret = randomBytes(32).toString('hex');
const joinCode = String(randomInt(100000, 1000000));
const child = spawn(process.execPath, [path.join(root, 'deployment', 'local-server', 'server.mjs')], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0',
    RPGMAP_DATA_DIR: dataRoot, RPGMAP_WORLD_ID: world.id,
    RPGMAP_PUBLIC_DIR: appDirectory, RPGMAP_STATIC_DIR: appDirectory,
    RPGMAP_GM_SECRET: gmSecret, RPGMAP_MANAGER_SECRET: managerSecret, RPGMAP_JOIN_CODE: joinCode,
    RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '', RPGMAP_DESKTOP: '',
  },
  windowsHide: true, stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
});
let outputBuffer = '', ready = false;
child.stdout.setEncoding('utf8');
child.stdout.on('data', async chunk => {
  process.stdout.write(chunk);
  outputBuffer += chunk;
  const port = outputBuffer.match(/Local\s+: http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
  if (ready || !port) return;
  ready = true;
  const origin = `http://127.0.0.1:${port}`;
  const hostUrl = `${origin}/#${new URLSearchParams({ 'rpgmap-host': '1', gmSecret })}`;
  await writeFile(path.join(output, 'session.json'), JSON.stringify({ origin, hostUrl, joinCode,
    dataRoot, worldId: world.id, serverPid: child.pid, controllerPid: process.pid }, null, 2));
  console.log(`UI session ready: ${origin}`);
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code || 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (child.connected) child.send('rpgmap.shutdown');
});
