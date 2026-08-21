import test from 'node:test';
import assert from 'node:assert/strict';
import { createInternetCredentials, parseQuickTunnelUrl } from '../deployment/local-server/internet-launcher.mjs';

test('parseQuickTunnelUrl extracts Cloudflare Quick Tunnel URL from mixed logs', () => {
  const log = [
    '2026-08-21T14:20:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
    '2026-08-21T14:20:01Z INF https://receiving-acquisition-ferry-bent.trycloudflare.com',
    '2026-08-21T14:20:02Z INF Registered tunnel connection',
  ].join('\n');
  assert.equal(
    parseQuickTunnelUrl(log),
    'https://receiving-acquisition-ferry-bent.trycloudflare.com',
  );
});

test('parseQuickTunnelUrl returns null before URL is available', () => {
  assert.equal(parseQuickTunnelUrl('INF Requesting new quick Tunnel...'), null);
});

test('createInternetCredentials creates player join code and GM secret', () => {
  const first = createInternetCredentials();
  const second = createInternetCredentials();
  assert.match(first.joinCode, /^\d{6}$/);
  assert.match(first.gmSecret, /^[0-9A-F]{16}$/);
  assert.notEqual(first.gmSecret, second.gmSecret);
});
