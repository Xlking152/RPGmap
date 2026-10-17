import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import config, { developmentWatchIgnored } from '../vite.config.js';

const normalize = value => String(value).replaceAll('\\', '/');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('development watcher excludes only repository-root generated directories', () => {
  const root = normalize(fileURLToPath(new URL('../', import.meta.url))).replace(/\/$/, '');
  const ignored = config({ command: 'serve' }).server.watch.ignored;
  const names = ['output', 'artifact', 'release', 'releases', 'release-check', 'coverage',
    'test-results', 'playwright-report', '.playwright-cli', 'dist'];
  assert.deepEqual(ignored, names.map(name => `${root}/${name}/**`));
  assert.deepEqual(developmentWatchIgnored('C:\\owned\\project\\'), names.map(name => `C:/owned/project/${name}/**`));
  assert.ok(ignored.every(pattern => !pattern.startsWith('**/')), 'no broad source-directory exclusions');
});

test('Vite ignores generated package trees while src, maps and scripts still emit hot-update events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-watch-test-'));
  const sources = ['src/probe.js', 'src/output/probe.js', 'maps/probe.json', 'scripts/probe.js'];
  let server;
  try {
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Watcher test</title>');
    for (const name of sources) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), '{}');
    }
    await mkdir(path.join(root, 'output', 'stage', 'assets'), { recursive: true });
    await writeFile(path.join(root, 'output', 'stage', 'assets', 'probe.txt'), 'owned package fixture');
    server = await createServer({ configFile: false, root, logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, watch: { ignored: developmentWatchIgnored(root) } } });
    const updates = new Set();
    server.watcher.on('change', file => updates.add(normalize(file)));
    await server.listen();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !sources.every(name => Object.keys(server.watcher.getWatched())
      .some(directory => normalize(directory) === normalize(path.dirname(path.join(root, name)))))) await sleep(20);
    for (const name of sources) await writeFile(path.join(root, name), '{"updated":true}');
    while (Date.now() < deadline && !sources.every(name => updates.has(normalize(path.join(root, name))))) await sleep(20);
    assert.deepEqual([...updates].sort(), sources.map(name => normalize(path.join(root, name))).sort());
    const generated = normalize(path.join(root, 'output'));
    assert.equal(Object.keys(server.watcher.getWatched()).some(directory => normalize(directory) === generated
      || normalize(directory).startsWith(generated + '/')), false);
    await rename(path.join(root, 'output', 'stage'), path.join(root, 'output', 'installed'));
  } finally {
    await server?.close();
    const absolute = path.resolve(root);
    assert(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('rpgmap-watch-test-'));
    await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
