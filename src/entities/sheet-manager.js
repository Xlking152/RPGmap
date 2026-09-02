const DEFAULT_STORAGE_KEY = 'rpgmap.ui.actor-sheets.v1';
const BASE_Z_INDEX = 4210;
const Z_INDEX_SPAN = 70;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function geometryFrom(value = {}) {
  const left = finite(value.left);
  const top = finite(value.top);
  const width = finite(value.width);
  const height = finite(value.height);
  return {
    left: left == null ? null : Math.max(0, left),
    top: top == null ? null : Math.max(0, top),
    width: width == null ? null : Math.max(320, width),
    height: height == null ? null : Math.max(240, height),
  };
}

function preferenceFrom(value = {}) {
  return {
    tab: String(value.tab || '').trim() || null,
    ...geometryFrom(value),
  };
}

function readPreferences(storage, storageKey) {
  if (!storage?.getItem) return {};
  try {
    const parsed = JSON.parse(storage.getItem(storageKey) || '{}');
    if (parsed?.version !== 1 || !parsed.windows || typeof parsed.windows !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed.windows).map(([key, value]) => [String(key), preferenceFrom(value)]));
  } catch {
    return {};
  }
}

function writePreferences(storage, storageKey, preferences) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(storageKey, JSON.stringify({ version: 1, windows: preferences }));
  } catch {
    // UI preferences must never block gameplay when storage is unavailable.
  }
}

export function actorSheetWindowKey(actorId) {
  const id = String(actorId || '').trim();
  return id ? `actor:${id}` : '';
}

export function tokenSheetWindowKey(tokenId) {
  const id = String(tokenId || '').trim();
  return id ? `token:${id}` : '';
}

export function createActorSheetManager({
  storage = null,
  storageKey = DEFAULT_STORAGE_KEY,
  baseZIndex = BASE_Z_INDEX,
} = {}) {
  const records = new Map();
  const preferences = readPreferences(storage, storageKey);
  const zBase = Math.max(1, Number(baseZIndex) || BASE_Z_INDEX);
  let zCounter = zBase;
  let activeKey = null;

  function persist() {
    writePreferences(storage, storageKey, preferences);
  }

  function get(key) {
    return records.get(String(key || '')) || null;
  }

  function nextZ() {
    if (zCounter >= zBase + Z_INDEX_SPAN) {
      zCounter = zBase;
      for (const record of [...records.values()].sort((a, b) => a.zIndex - b.zIndex)) record.zIndex = ++zCounter;
    }
    return ++zCounter;
  }

  function activate(key) {
    const record = get(key);
    if (!record) return null;
    record.zIndex = nextZ();
    activeKey = record.key;
    return record;
  }

  function remember(record) {
    if (!record) return;
    preferences[record.key] = preferenceFrom(record);
    persist();
  }

  function open({ actorId, tokenId = null, tab = null } = {}) {
    const normalizedActorId = String(actorId || '').trim();
    const normalizedTokenId = String(tokenId || '').trim() || null;
    if (!normalizedActorId) return { record: null, created: false };
    const key = normalizedTokenId ? tokenSheetWindowKey(normalizedTokenId) : actorSheetWindowKey(normalizedActorId);
    const existing = get(key);
    if (existing) {
      if (tab != null && String(tab).trim()) existing.tab = String(tab);
      remember(existing);
      return { record: activate(key), created: false };
    }

    const saved = preferenceFrom(preferences[key]);
    const cascade = records.size % 7;
    const record = {
      key,
      actorId: normalizedActorId,
      tokenId: normalizedTokenId,
      tab: String(tab || saved.tab || 'overview'),
      left: saved.left ?? 24 + cascade * 26,
      top: saved.top ?? 72 + cascade * 22,
      width: saved.width,
      height: saved.height,
      zIndex: nextZ(),
    };
    records.set(key, record);
    activeKey = key;
    remember(record);
    return { record, created: true };
  }

  function update(key, patch = {}) {
    const record = get(key);
    if (!record) return null;
    if (patch.tab != null && String(patch.tab).trim()) record.tab = String(patch.tab);
    const geometry = geometryFrom({ ...record, ...patch });
    Object.assign(record, geometry);
    remember(record);
    return record;
  }

  function capture(key, rect = {}) {
    return update(key, {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    });
  }

  function close(key = activeKey) {
    const record = get(key);
    if (!record) return null;
    remember(record);
    records.delete(record.key);
    if (activeKey === record.key) {
      const next = [...records.values()].sort((a, b) => b.zIndex - a.zIndex)[0] || null;
      activeKey = next?.key || null;
    }
    return record;
  }

  function closeMissing(predicate) {
    const removed = [];
    for (const record of [...records.values()]) {
      if (predicate(record)) continue;
      removed.push(close(record.key));
    }
    return removed.filter(Boolean);
  }

  return Object.freeze({
    get,
    open,
    update,
    capture,
    activate,
    close,
    closeMissing,
    active() { return get(activeKey); },
    activeKey() { return activeKey; },
    list() { return [...records.values()].sort((a, b) => a.zIndex - b.zIndex); },
    size() { return records.size; },
  });
}
