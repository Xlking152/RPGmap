export function multiplayerSocketUrl(locationLike = globalThis.location) {
  const protocol = locationLike?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = locationLike?.host || '127.0.0.1:30000';
  return `${protocol}//${host}/ws`;
}

export function isLocalHost(locationLike = globalThis.location) {
  const hostname = String(locationLike?.hostname || '').toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export function sanitizeMultiplayerName(value, fallback = 'Player') {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return text || fallback;
}

export function normalizeRequestedRole(value) {
  return value === 'gm' ? 'gm' : 'player';
}
