import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const candidate = readFileSync(new URL('../.github/workflows/desktop-candidate.yml', import.meta.url), 'utf8');
const publish = readFileSync(new URL('../.github/workflows/publish-desktop-release.yml', import.meta.url), 'utf8');
const workflows = readdirSync(new URL('../.github/workflows/', import.meta.url));

test('main and pull requests build the Windows desktop candidate with the locked toolchain and existing gates', () => {
  assert.match(candidate, /pull_request:\s*\n\s*branches: \[main\]/);
  assert.match(candidate, /push:\s*\n\s*branches: \[main\]/);
  assert.match(candidate, /runs-on: windows-latest/);
  for (const workflow of [candidate, publish]) {
    assert.match(workflow, /node-version: '24\.19\.0'/);
    assert.match(workflow, /npm install --global npm@11\.17\.0/);
  }
  for (const command of ['npm ci --no-audit --no-fund', 'npm test', 'npm run build', 'npm run check:bundle',
    'npm run package:desktop', 'npm run check:desktop', 'npm run export:maps']) assert.ok(candidate.includes(command), command);
  assert.equal((candidate.match(/npm audit --registry=https:\/\/registry\.npmjs\.org/g) || []).length, 2);
  assert.match(candidate, /desktop-release\.mjs assemble/);
  assert.match(candidate, /--receipt=artifact\/desktop-build-receipt\.json/);
  assert.match(candidate, /artifact\/frozen\//);
  assert.match(candidate, /artifact\/desktop-stage\//);
  assert.match(candidate, /desktop-installer-smoke\.ps1 -Installer/);
  assert.match(candidate, /RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.match(candidate, /node scripts\/vision-mask-raster-check\.mjs/);
  assert.match(candidate, /RPGMAP_BENCHMARK_TMPDIR: \/dev\/shm/);
  assert.match(candidate, /npm run benchmark:lan -- --assert/);
  assert.match(candidate, /benchmark:lan -- --assert --package=candidate\/desktop-stage\/resources --output=artifact\/backend-local-gm\.json/);
  assert.doesNotMatch(candidate, /occlusion-lan-benchmark\.mjs|--multiplayer|continue-on-error/);
  assert.doesNotMatch(candidate, /gh release|contents: write|package:local-server|RPGmap-v\*\.zip/);
});

test('release publication only promotes an immutable successful main artifact after checking the exact four downloaded files', () => {
  assert.match(publish, /workflow_dispatch:/);
  assert.doesNotMatch(publish, /\n  push:|\n  release:/);
  assert.match(publish, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(publish, /\^\[a-f0-9\]\{40\}\$/);
  assert.match(publish, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_COMMIT"/);
  for (const field of ['head_sha', 'head_branch', 'event', 'status', 'conclusion', 'path']) assert.ok(publish.includes(`r.${field}`));
  assert.match(publish, /r\.path!=="\.github\/workflows\/desktop-candidate\.yml"/);
  assert.match(publish, /gh run download "\$CANDIDATE_RUN"/);
  assert.match(publish, /--name "RPGmap-desktop-\$RELEASE_COMMIT"/);
  assert.match(publish, /desktop-release\.mjs verify[^\n]+--directory=candidate\/frozen\/delivery/);
  assert.match(publish, /--stage=candidate\/desktop-stage/);
  assert.match(publish, /r\.assets\.map\(a=>a\.name\)\.sort\(\)/);
  assert.match(publish, /desktop-release\.mjs verify[^\n]+--directory=downloaded-draft/);
  assert.match(publish, /desktop-release\.mjs verify[^\n]+--directory=downloaded-release/);
  assert.match(publish, /gh release edit[^\n]+--draft=false --latest/);
  assert.doesNotMatch(publish, /npm run build|package:desktop|export:maps|package:local-server|unzip|\.zip/);
});

test('retired tag and ZIP workflows cannot publish a competing v3 release', () => {
  for (const retired of ['multiplayer-test-package.yml', 'publish-local-candidate.yml', 'publish-local-server-release.yml']) {
    assert.equal(workflows.includes(retired), false, retired);
  }
  assert.deepEqual(workflows.sort(), ['desktop-candidate.yml', 'publish-desktop-release.yml']);
});

test('deferring browser latency leaves the original runtime performance assertions intact', () => {
  const browser = readFileSync(new URL('../scripts/browser-performance-benchmark.mjs', import.meta.url), 'utf8');
  const lan = readFileSync(new URL('../scripts/lan-performance-benchmark.mjs', import.meta.url), 'utf8');
  const support = readFileSync(new URL('../scripts/lan-benchmark-support.mjs', import.meta.url), 'utf8');
  assert.match(browser, /!withinMillisecondsBudget\(input\.p95, 16\.7\)/);
  assert.match(browser, /session\.diagnostics\.averageFps < 58 \|\| frame\.p95 > 20/);
  assert.match(browser, /recoveredMs > 13_000/);
  assert.match(lan, /ackMeasurement\[type\]\.p95Ms > 60/);
  assert.match(lan, /measurement\[type\]\.p95Ms > 60/);
  assert.match(lan, /moveBytes\.requestMax > 4096 \|\| moveBytes\.responseMax > 4096/);
  assert.match(support, /process\.env\.RPGMAP_BENCHMARK_TMPDIR/);
  assert.match(lan, /PLAYER_COUNT = process\.argv\.includes\('--multiplayer'\) \? 6 : 0/);
  assert.match(lan, /players\.length \? players\.map\(player => player\.socket\) : \[gm\.socket\]/);
  assert.match(browser, /RPGMAP_BENCHMARK_BROWSER \|\| 'chrome'/);
  assert.match(browser, /RPGMAP_BROWSER_BENCHMARK_SESSIONS\) \|\| 1/);
  const largeRange = readFileSync(new URL('../scripts/occlusion-lan-benchmark.mjs', import.meta.url), 'utf8');
  assert.match(largeRange, /result\.movementAck\.p95Ms > 60 \|\| result\.allClientFanout\.p95Ms > 60/);
});

test('hosted LAN regression still speaks the current protocol', () => {
  const source = readFileSync(new URL('../scripts/lan-vision-smoke.mjs', import.meta.url), 'utf8');
  assert.match(source, /operationSchema: WORLD_OPERATION_SCHEMA_VERSION/);
  assert.match(source, /statusSchema: STATUS_SCHEMA_VERSION/);
  assert.match(source, /accessSchema: ACCESS_SCHEMA_VERSION/);
  assert.match(source, /type: 'world\.snapshot\.request'/);
  assert.doesNotMatch(source, /type: 'world\.request'/);
});
