import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish-local-server-release.yml', import.meta.url),
  'utf8',
);
const packageSource = readFileSync(new URL('../scripts/package-local-server.mjs', import.meta.url), 'utf8');
const verifierSource = readFileSync(new URL('../scripts/verify-package.mjs', import.meta.url), 'utf8');
const lanSmokeSource = readFileSync(new URL('../scripts/lan-vision-smoke.mjs', import.meta.url), 'utf8');
const lanBenchmarkSource = readFileSync(new URL('../scripts/lan-performance-benchmark.mjs', import.meta.url), 'utf8');
const lanBenchmarkSupport = readFileSync(new URL('../scripts/lan-benchmark-support.mjs', import.meta.url), 'utf8');
const occlusionLanSource = readFileSync(new URL('../scripts/occlusion-lan-benchmark.mjs', import.meta.url), 'utf8');
const browserBenchmarkSource = readFileSync(new URL('../scripts/browser-performance-benchmark.mjs', import.meta.url), 'utf8');

test('release publishing declares the repository without requiring a checkout', () => {
  assert.match(
    workflow,
    /gh release create[\s\S]*?--repo "\$GITHUB_REPOSITORY"[\s\S]*?--target/,
  );
  assert.match(workflow, /Prepare release notes from changelog/);
  assert.match(workflow, /Source Commit/);
  assert.match(workflow, /--notes-file/);
});

test('release LAN benchmark isolates hosted-runner disk jitter without relaxing budgets', () => {
  assert.match(
    workflow,
    /Assert LAN WebSocket performance budget[\s\S]*?RPGMAP_BENCHMARK_TMPDIR:\s*\/dev\/shm[\s\S]*?npm run benchmark:lan -- --assert/,
  );
  assert.match(lanBenchmarkSupport, /process\.env\.RPGMAP_BENCHMARK_TMPDIR/);
  assert.match(lanBenchmarkSource, /for \(const type of \['move', 'status', 'chat', 'aggregate'\]\)/);
  assert.match(lanBenchmarkSource, /ackMeasurement\[type\]\.p95Ms > 60/);
  assert.match(lanBenchmarkSource, /measurement\[type\]\.p95Ms > 60/);
  assert.match(lanBenchmarkSource, /moveBytes\.requestMax > 4096 \|\| moveBytes\.responseMax > 4096/);
});

test('automatic v2.5.4 publishing gates the exact Windows ZIP on large-range LAN and Chrome performance', () => {
  const windowsJob = workflow.replaceAll('\r\n', '\n').split('\n  windows-smoke:')[1]?.split('\n  publish:')[0];
  assert.ok(windowsJob, 'Windows package verification job must exist before publication');
  const step = name => {
    const marker = `      - name: ${name}\n`;
    const start = windowsJob.indexOf(marker);
    assert.notEqual(start, -1, `${name} must run in the Windows gate job`);
    const remainder = windowsJob.slice(start + marker.length);
    const end = remainder.indexOf('\n      - name:');
    return end < 0 ? remainder : remainder.slice(0, end);
  };
  const gate = step('Determine v2.5.4 performance gates');
  const lan = step('Assert large-range LAN performance on the candidate ZIP');
  const browser = step('Assert seven-session Chrome performance on the candidate ZIP');
  assert.match(gate, /id: occlusion_gates/);
  assert.match(gate, /\[version\]\$version -ge \[version\]'2\.5\.4'/);
  for (const check of [lan, browser]) {
    assert.match(check, /if: steps\.occlusion_gates\.outputs\.required == 'true'/);
    assert.match(check, /release\/unpacked\/RPGmap-v\$version/);
    assert.match(check, /\$LASTEXITCODE -ne 0/);
  }
  assert.match(lan, /occlusion-lan-benchmark\.mjs "--package=\$packageRoot" --rounds=5 --warmup-rounds=1 --assert/);
  assert.match(browser, /RPGMAP_BENCHMARK_BROWSER: chrome/);
  assert.match(browser, /RPGMAP_BROWSER_BENCHMARK_HEADLESS: '1'/);
  assert.match(browser, /RPGMAP_BROWSER_BENCHMARK_SECONDS: '60'/);
  assert.match(browser, /RPGMAP_BROWSER_BENCHMARK_TOKENS: '500'/);
  assert.match(browser, /RPGMAP_BROWSER_BENCHMARK_SESSIONS: '7'/);
  assert.match(browser, /\$env:RPGMAP_BENCHMARK_PACKAGE = \(Resolve-Path/);
  assert.match(browser, /browser-performance-benchmark\.mjs --assert/);
  assert.match(workflow, /publish:\s*\n\s*needs: \[candidate, windows-smoke\]/);
  assert.match(occlusionLanSource, /result\.movementAck\.p95Ms > 60 \|\| result\.allClientFanout\.p95Ms > 60/);
  assert.match(browserBenchmarkSource, /input\.p95 > 16\.7/);
  assert.match(browserBenchmarkSource, /session\.diagnostics\.averageFps < 58 \|\| frame\.p95 > 20/);
  assert.match(browserBenchmarkSource, /recoveredMs > 13_000/);
});

test('release package closes every local server module inside the ZIP root', () => {
  assert.match(packageSource, /'http-runtime\.mjs'/);
  assert.match(packageSource, /'websocket-runtime\.mjs'/);
  assert.match(packageSource, /'world-checkpoint\.mjs'/);
  assert.match(verifierSource, /'world-checkpoint\.mjs'/);
  assert.match(packageSource, /bundleServerModule\('src\/permissions\/model\.js', 'permissions-model\.mjs'\)/);
  assert.match(packageSource, /bundleServerModule\('deployment\/local-server\/status-operations\.mjs', 'status-operations\.mjs'\)/);
  assert.match(verifierSource, /imports outside the package root/);
  assert.match(verifierSource, /imports missing package module/);
});

test('packaged LAN smoke speaks the current protocol without legacy snapshot requests', () => {
  assert.match(lanSmokeSource, /operationSchema: WORLD_OPERATION_SCHEMA_VERSION/);
  assert.match(lanSmokeSource, /statusSchema: STATUS_SCHEMA_VERSION/);
  assert.match(lanSmokeSource, /accessSchema: ACCESS_SCHEMA_VERSION/);
  assert.match(lanSmokeSource, /type: 'world\.snapshot\.request'/);
  assert.doesNotMatch(lanSmokeSource, /type: 'world\.request'/);
});

test('v2.5.4 publication requires large-range LAN and complete browser gates for the exact ZIP', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'rpgmap-release-validation-'));
  const version = '2.5.4', commit = 'a'.repeat(40), archive = Buffer.from('validated candidate');
  const checks = Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'chrome',
    'visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark'].map(check => [check, 'passed']));
  const validation = { version, commit, sha256: createHash('sha256').update(archive).digest('hex'), checks };
  const verify = () => execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-local-validation.mjs', import.meta.url)),
    directory, version, commit], { stdio: 'pipe', windowsHide: true });
  const save = () => writeFileSync(path.join(directory, 'local-validation.json'), JSON.stringify(validation));
  try {
    writeFileSync(path.join(directory, `RPGmap-v${version}.zip`), archive);
    for (const check of ['visionBenchmark', 'occlusionLanBenchmark', 'browserBenchmark']) {
      validation.checks[check] = 'failed'; save();
      assert.throws(verify, error => error.stderr.toString().includes(`Local check missing: ${check}`));
      validation.checks[check] = 'passed';
    }
    // Passing labels alone must not promote a fake archive or substitute for
    // the v2.5.4 raw package-bound performance evidence.
    save(); assert.throws(verify, error => error.stderr.toString().includes('Candidate ZIP directory missing'));
    writeFileSync(path.join(directory, `RPGmap-v${version}.zip`), 'different candidate');
    assert.throws(verify, error => error.stderr.toString().includes('ZIP checksum mismatch'));
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('rpgmap-release-validation-')) throw new Error('Unexpected validation temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
});
