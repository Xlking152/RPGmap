import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConnectionInfo,
  createInternetCredentials,
  parseQuickTunnelUrl,
} from '../deployment/local-server/internet-launcher.mjs';

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

test('buildConnectionInfo keeps player invite and GM secret visibly separated', () => {
  const lines = buildConnectionInfo({
    publicUrl: 'https://example-room.trycloudflare.com',
    joinCode: '123456',
    gmSecret: 'ABCDEF0123456789',
    version: '1.4.0',
    port: 30000,
  });
  const text = lines.join('\n');
  assert.match(text, /RPGmap Multiplayer Connection Info\s+\|\s+1\.4\.0/);
  assert.match(text, /Public URL\s+: https:\/\/example-room\.trycloudflare\.com/);
  assert.match(text, /Join Code\s+: 123456/);
  assert.match(text, /GM Secret\s+: ABCDEF0123456789/);
  assert.match(text, /PLAYER SHARE ONLY/);
  assert.match(text, /Do not send it to Players/);
});
