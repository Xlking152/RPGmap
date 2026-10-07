import { types } from 'node:util';

const MAX_PARTIES = 8;
const rowKey = key => Number.isSafeInteger(Number(key)) && Number(key) >= 0 && String(Number(key)) === key;
const fail = () => { throw new Error('Exploration Worker Fog version is missing or invalid'); };

// A Worker receives authoritative/pending Fog, never its own speculative
// output as confirmed history. Only accepted immutable row arrays can omit a
// transfer; mutable rows are sent again even when their identity is unchanged.
export function createExplorationFogSender(isCanonicalData) {
  const entries = new Map();
  let sequence = 0;
  return {
    prepare(key, rows) {
      if (!rows || typeof rows !== 'object' || types.isProxy(rows)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(rows))) {
        entries.delete(key); return { exploredRows: rows, fogResetKey: key };
      }
      const keys = Reflect.ownKeys(rows), values = {};
      for (const name of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(rows, name);
        if (typeof name !== 'string' || !rowKey(name) || !descriptor?.enumerable
          || !Object.hasOwn(descriptor, 'value') || !Array.isArray(descriptor.value)) {
          entries.delete(key); return { exploredRows: rows, fogResetKey: key };
        }
        values[name] = descriptor.value;
      }
      const previous = entries.get(key), next = {}, changed = {}, removed = [];
      for (const name of keys) {
        const spans = values[name];
        const immutable = typeof isCanonicalData === 'function' && isCanonicalData(spans) === true;
        if (!immutable || !previous || previous.rows[name] !== spans) changed[name] = spans;
        next[name] = immutable ? spans : null;
      }
      if (previous) for (const name of Object.keys(previous.rows)) if (!Object.hasOwn(values, name)) removed.push(name);
      const version = ++sequence;
      entries.delete(key); entries.set(key, { version, rows: next });
      if (entries.size > MAX_PARTIES) entries.delete(entries.keys().next().value);
      return { fogUpdate: { key, version, baseVersion: previous?.version ?? null, rows: changed, removed } };
    },
    clear() { entries.clear(); },
    size() { return entries.size; },
  };
}

export function createExplorationFogReceiver() {
  const entries = new Map();
  return {
    receive(message) {
      if (!message.fogUpdate) {
        if (typeof message.fogResetKey === 'string') entries.delete(message.fogResetKey);
        return message.exploredRows || {};
      }
      const update = message.fogUpdate;
      if (typeof update.key !== 'string' || !Number.isSafeInteger(update.version) || update.version < 1
        || !update.rows || typeof update.rows !== 'object' || Array.isArray(update.rows)
        || !Array.isArray(update.removed)) fail();
      const previous = entries.get(update.key);
      if (update.baseVersion !== null && (!previous || previous.version !== update.baseVersion
        || update.version <= previous.version)) fail();
      const rows = update.baseVersion === null ? {} : { ...previous.rows };
      for (const name of update.removed) {
        if (typeof name !== 'string' || !rowKey(name)) fail();
        delete rows[name];
      }
      for (const [name, spans] of Object.entries(update.rows)) {
        if (!rowKey(name) || !Array.isArray(spans)) fail();
        rows[name] = spans;
      }
      entries.delete(update.key); entries.set(update.key, { version: update.version, rows });
      if (entries.size > MAX_PARTIES) entries.delete(entries.keys().next().value);
      return rows;
    },
    clear() { entries.clear(); },
    size() { return entries.size; },
  };
}
