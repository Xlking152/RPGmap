const DEFAULT_MAP_ID = 'northern-song-lanzhou-1104';

function validateMapPackage(mapPackage) {
  if (!mapPackage || typeof mapPackage !== 'object') throw new Error('地图包格式无效');
  if (!mapPackage.id) throw new Error('地图包缺少 id');
  if (!(Number(mapPackage.width) > 0) || !(Number(mapPackage.height) > 0)) throw new Error('地图包尺寸无效');
  if (typeof mapPackage.svg !== 'string' || !mapPackage.svg.includes('<svg')) throw new Error('地图包缺少有效 SVG');
  if (!Array.isArray(mapPackage.features)) throw new Error('地图包缺少 features');
  return mapPackage;
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`地图资源读取失败：${url} · HTTP ${response.status}`);
  return response.json();
}

async function loadExternalMapPackage() {
  let mapId = DEFAULT_MAP_ID;
  try {
    const registry = await fetchJson('/maps/index.json');
    if (registry?.defaultMapId) mapId = String(registry.defaultMapId);
  } catch {
    // Older packages may not have a registry yet. Fall back to the built-in default ID.
  }
  const mapPackage = await fetchJson(`/maps/${encodeURIComponent(mapId)}/map.json`);
  return validateMapPackage(mapPackage);
}

async function loadDevelopmentFallback() {
  const [{ createLanzhouMapPackage }, { cleanMapPackagePresentation }] = await Promise.all([
    import('./lanzhou.js'),
    import('./presentation-cleanup.js'),
  ]);
  const source = cleanMapPackagePresentation(createLanzhouMapPackage());
  return source;
}

export async function loadRuntimeMapPackage() {
  try {
    return await loadExternalMapPackage();
  } catch (error) {
    if (import.meta.env?.DEV) {
      console.warn('[RPGmap] external MapPackage unavailable in Vite dev mode; using source fallback.', error);
      return loadDevelopmentFallback();
    }
    throw error;
  }
}
