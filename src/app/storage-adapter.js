export function createBrowserStorage() {
  return {
    get(key) { return localStorage.getItem(key); },
    set(key, value) { localStorage.setItem(key, value); },
    remove(key) { localStorage.removeItem(key); },
  };
}

export function createMemoryStorage() {
  const values = new Map();
  return {
    get(key) { return values.get(String(key)) ?? null; },
    set(key, value) { values.set(String(key), String(value)); },
    remove(key) { values.delete(String(key)); },
  };
}
