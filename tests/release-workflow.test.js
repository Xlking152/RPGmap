import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish-local-server-release.yml', import.meta.url),
  'utf8',
);
const packageSource = readFileSync(new URL('../scripts/package-local-server.mjs', import.meta.url), 'utf8');
const verifierSource = readFileSync(new URL('../scripts/verify-package.mjs', import.meta.url), 'utf8');
const lanSmokeSource = readFileSync(new URL('../scripts/lan-vision-smoke.mjs', import.meta.url), 'utf8');

test('release publishing declares the repository without requiring a checkout', () => {
  assert.match(
    workflow,
    /gh release create[\s\S]*?--repo "\$GITHUB_REPOSITORY"[\s\S]*?--target/,
  );
  assert.match(workflow, /Prepare release notes from changelog/);
  assert.match(workflow, /Source Commit/);
  assert.match(workflow, /--notes-file/);
});

test('release package closes every local server module inside the ZIP root', () => {
  assert.match(packageSource, /'http-runtime\.mjs'/);
  assert.match(packageSource, /'websocket-runtime\.mjs'/);
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
