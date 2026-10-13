import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { startBenchmarkServer, stopBenchmarkServer, GM_SECRET, JOIN_CODE } from './lan-benchmark-support.mjs';

const argument = key => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const root = process.cwd(), packageRoot = path.resolve(argument('package') || 'artifact/desktop-stage/resources');
const mapArchive = argument('map') || process.env.RPGMAP_BENCHMARK_MAP_PACKAGE;
if (!mapArchive) throw new Error('Pass --map=the delivered Lanzhou .rpgmap archive');
const runtime = await startBenchmarkServer(root, { packageRoot, mapArchive, env: {
  NODE_ENV: 'production', RPGMAP_TEST_ALLOW_MISSING_ORIGIN: '0',
} });
try {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/lan-vision-smoke.mjs', runtime.httpUrl, GM_SECRET, JOIN_CODE, runtime.mapDir], {
      cwd: root, windowsHide: true, env: { ...process.env, RPGMAP_SMOKE_PACKAGE_ROOT: packageRoot }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Packaged ruins failed (${code}): ${errors}\n${runtime.stderr()}`)));
  });
  const report = { ...result, importedMapArchive: runtime.mapPackageEvidence,
    scope: 'Actual delivered backend and independent .rpgmap; loopback GM/Player sockets, permissions, fsynced WAL, reconnection and restart. No Canvas/FPS or VPN measurement.' };
  if (argument('output')) {
    const target = path.resolve(argument('output')); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await stopBenchmarkServer(runtime); }
