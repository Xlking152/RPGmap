import net from 'node:net';

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function isTcpPortOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  const targetPort = Math.max(1, Number(port) || 30000);
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port: targetPort });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function inspectServerPort(port, {
  host = '127.0.0.1',
  timeoutMs = 900,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetPort = Math.max(1, Number(port) || 30000);
  const occupied = await isTcpPortOpen(targetPort, host, Math.min(timeoutMs, 700));
  if (!occupied) return { occupied: false, rpgmap: false, health: null };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://${host}:${targetPort}/api/health`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const health = await response.json();
      const rpgmap = response.ok && health?.status === 'ok' && health?.app === 'RPGmap';
      return { occupied: true, rpgmap, health: rpgmap ? health : null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { occupied: true, rpgmap: false, health: null };
  }
}

export function describePortConflict(result, port) {
  const targetPort = Math.max(1, Number(port) || 30000);
  if (!result?.occupied) return '';
  if (!result.rpgmap) {
    return `Port ${targetPort} is already in use by another program. Close that program or choose another PORT before starting RPGmap.`;
  }
  const multiplayer = result.health?.multiplayer || {};
  const mode = multiplayer.publicMode ? 'Internet/Public' : 'Local/LAN';
  const version = result.health?.version ? ` v${result.health.version}` : '';
  return `RPGmap${version} ${mode} Server is already running on port ${targetPort}. Local/LAN and Internet launchers must not be started at the same time. Close the existing RPGmap server window first.`;
}
