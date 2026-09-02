const STORAGE_PREFIX = 'rpgmap:multiplayer:';

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
