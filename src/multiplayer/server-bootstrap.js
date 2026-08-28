export async function readRpgMapServerBootstrap({
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
  location = globalThis.location,
} = {}) {
  if (typeof fetchImpl !== 'function') return { serverRuntime: false, health: null, world: null };
  const protocol = location?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return { serverRuntime: false, health: null, world: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/health', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { serverRuntime: false, health: null, world: null };
    const health = await response.json();
    const serverRuntime = health?.status === 'ok'
      && health?.app === 'RPGmap'
      && health?.multiplayer?.enabled === true;
    return {
      serverRuntime,
      health: serverRuntime ? health : null,
      world: serverRuntime ? health.world || null : null,
    };
  } catch {
    return { serverRuntime: false, health: null, world: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function detectRpgMapServer(options = {}) {
  return (await readRpgMapServerBootstrap(options)).serverRuntime;
}
