import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_ROOTS = ['src', 'deployment/local-server'];

function javascriptFiles(relativeRoot) {
  const root = path.join(ROOT, relativeRoot);
  const files = [];
  const visit = directory => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (/\.(?:js|mjs)$/.test(name)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

test('live Status code cannot restore the retired inline addEffect API', () => {
  const offenders = [];
  for (const root of LIVE_ROOTS) {
    for (const file of javascriptFiles(root)) {
      const source = readFileSync(file, 'utf8');
      if (/\baddEffect\b/.test(source)) offenders.push(relative(file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('live Status code cannot write Definition changes back onto Effect instances', () => {
  const offenders = [];
  const effectChangeAssignment = /\b(?:effect|instance|effects\s*\[[^\]]+\])\.changes\s*=/g;
  for (const root of LIVE_ROOTS) {
    for (const file of javascriptFiles(root)) {
      const source = readFileSync(file, 'utf8');
      if (effectChangeAssignment.test(source)) offenders.push(relative(file));
      effectChangeAssignment.lastIndex = 0;
    }
  }
  assert.deepEqual(offenders, []);
});

test('client normalizer and LAN validator share the runtime-only EffectInstance boundary', () => {
  const client = readFileSync(path.join(ROOT, 'src/status/model.js'), 'utf8');
  const server = readFileSync(path.join(ROOT, 'deployment/local-server/status-operations.mjs'), 'utf8');
  for (const field of [
    'name', 'label', 'description', 'icon', 'color', 'category', 'scope', 'scopes',
    'maxStacks', 'capabilities', 'statusId', 'changes',
  ]) {
    assert.match(client, new RegExp(`['\"]${field}['\"]`), `client boundary missing ${field}`);
    assert.match(server, new RegExp(`['\"]${field}['\"]`), `server boundary missing ${field}`);
  }
  assert.match(server, /status_instance_rule_data_forbidden/);
});
