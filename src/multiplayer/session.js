const STORAGE_PREFIX = 'rpgmap:multiplayer:';
const SCENE_RELOAD_KEY = `${STORAGE_PREFIX}scene-reload`;

// One tab and one World only. Credentials leave neither sessionStorage nor the
// existing authenticated hello exchange; a new Runtime requests a full snapshot.
export function stageSceneReloadConnection(storage, worldId, options, now = Date.now()) {
  if (!worldId || !options || !['gm', 'player'].includes(options.requestedRole)) return false;
  try {
    storage.setItem(SCENE_RELOAD_KEY, JSON.stringify({ worldId: String(worldId), at: now, options }));
    return true;
  } catch { return false; }
}

export function consumeSceneReloadConnection(storage, worldId, localHost, now = Date.now()) {
  try {
    const raw = storage?.getItem(SCENE_RELOAD_KEY);
    storage?.removeItem(SCENE_RELOAD_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw), options = value?.options;
    if (!worldId || value.worldId !== String(worldId) || !Number.isFinite(value.at)
      || now < value.at || now - value.at > 120_000
      || !options || !['gm', 'player'].includes(options.requestedRole)
      || (options.requestedRole === 'gm' && (!localHost || !options.gmSecret))) return null;
    return { name: sanitizeReloadValue(options.name), requestedRole: options.requestedRole,
      joinCode: sanitizeReloadValue(options.joinCode), gmSecret: options.requestedRole === 'gm' ? sanitizeReloadValue(options.gmSecret) : '',
      playerKey: options.requestedRole === 'player' ? sanitizeReloadValue(options.playerKey) : '' };
  } catch { return null; }
}

function sanitizeReloadValue(value) { return typeof value === 'string' ? value : ''; }

export function clearSceneReloadConnection(storage) {
  try { storage?.removeItem(SCENE_RELOAD_KEY); } catch {}
}

export function createMultiplayerSessionStorage(storage = globalThis.localStorage) {
  return Object.freeze({
    get(key, fallback = '') {
      try { return storage?.getItem(`${STORAGE_PREFIX}${key}`) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { storage?.setItem(`${STORAGE_PREFIX}${key}`, String(value)); } catch {}
    },
    remove(key) {
      try { storage?.removeItem(`${STORAGE_PREFIX}${key}`); } catch {}
    },
    clearIdentity() {
      for (const key of ['userId', 'authToken', 'playerKey']) this.remove(key);
    },
  });
}
