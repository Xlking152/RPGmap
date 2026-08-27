import { createEmptyEntityState, normalizeEntityState } from './model.js';
import { STATUS_SCHEMA_VERSION } from '../status/model.js';

const PREFERENCE_KEY = 'entitySystem';

function entityContentChanged(raw, normalized) {
  const before = {
    statusDefinitions: Array.isArray(raw?.statusDefinitions) ? raw.statusDefinitions : [],
    actors: Array.isArray(raw?.actors) ? raw.actors : [],
    tokens: Array.isArray(raw?.tokens) ? raw.tokens : [],
  };
  const after = {
    statusDefinitions: normalized.statusDefinitions || [],
    actors: normalized.actors || [],
    tokens: normalized.tokens || [],
  };
  return JSON.stringify(before) !== JSON.stringify(after);
}

export class EntityStore {
  constructor(api, { canonicalTokenReads = false } = {}) {
    this.api = api;
    this.state = createEmptyEntityState();
    this.compatTokens = [];
    this.canonicalTokenReadView = canonicalTokenReads === true;
    this.saving = false;
  }

  mutableTokens() {
    return this.canonicalTokenReadView ? this.compatTokens : this.state.tokens;
  }

  replaceMutableTokens(tokens) {
    const next = Array.isArray(tokens) ? tokens : [];
    if (this.canonicalTokenReadView) this.compatTokens = next;
    else this.state.tokens = next;
    return next;
  }

  canonicalTokens() {
    if (!this.canonicalTokenReadView) return this.state.tokens;
    const tokens = this.api.tokens?.list?.();
    return Array.isArray(tokens) ? tokens : this.compatTokens;
  }

  installCanonicalTokenReadView(state) {
    this.compatTokens = Array.isArray(state?.tokens) ? state.tokens : [];
    Object.defineProperty(state, 'tokens', {
      configurable: true,
      enumerable: true,
      get: () => this.canonicalTokens(),
      set: value => { this.compatTokens = Array.isArray(value) ? value : []; },
    });
    this.state = state;
    return state;
  }

  materializeState() {
    if (!this.canonicalTokenReadView) return structuredClone(this.state);
    return structuredClone({ ...this.state, tokens: this.canonicalTokens() });
  }

  load({ migrateLegacy = true, dropMarkers = true } = {}) {
    const appState = this.api.getState();
    const raw = appState.preferences?.[PREFERENCE_KEY];
    const normalized = normalizeEntityState(raw);
    let changed = entityContentChanged(raw, normalized)
      || (migrateLegacy && Number(raw?.schemaVersion) !== STATUS_SCHEMA_VERSION);

    if (this.canonicalTokenReadView) this.installCanonicalTokenReadView(normalized);
    else {
      this.state = normalized;
      this.compatTokens = this.state.tokens;
    }

    let droppedMarkers = 0;
    if (dropMarkers && Array.isArray(appState.markers) && appState.markers.length) {
      droppedMarkers = appState.markers.length;
      appState.markers = [];
      for (const area of appState.attackAreas || []) {
        if (area.anchor?.type === 'marker') area.anchor = { type: 'free', markerId: null };
      }
      changed = true;
    }
    if (changed) this.persist({ appState });
    return { migratedCharacters: 0, migratedTokenLocations: 0, blockedTokenLocations: 0, droppedMarkers };
  }

  snapshot() { return this.materializeState(); }

  persist({ appState = null, source = 'entities', render = false, immediate = false } = {}) {
    const nextApp = appState || this.api.getState();
    nextApp.preferences ||= {};
    nextApp.preferences[PREFERENCE_KEY] = this.materializeState();
    this.saving = true;
    try {
      if (typeof this.api.commitState === 'function') this.api.commitState(nextApp, { source, render });
      else this.api.importState(nextApp);
      if (immediate) this.api.persistNow?.();
    } finally {
      queueMicrotask(() => { this.saving = false; });
    }
    return true;
  }

  actor(id) { return this.state.actors.find(actor => String(actor.id) === String(id)) || null; }

  token(id) {
    if (this.canonicalTokenReadView) {
      return this.api.tokens?.get?.(id)
        || this.compatTokens.find(token => String(token.id) === String(id))
        || null;
    }
    return this.state.tokens.find(token => String(token.id) === String(id)) || null;
  }

  actorForToken(tokenId) {
    const token = this.token(tokenId);
    return token ? this.actor(token.actorId) : null;
  }

  removeToken(tokenId) {
    this.replaceMutableTokens(this.mutableTokens().filter(token => String(token.id) !== String(tokenId)));
  }

  removeActor(actorId) {
    this.state.actors = this.state.actors.filter(actor => String(actor.id) !== String(actorId));
    this.replaceMutableTokens(this.mutableTokens().filter(token => String(token.actorId) !== String(actorId)));
  }
}
