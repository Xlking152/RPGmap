import { createEmptyEntityState, migrateLegacyCharacters, normalizeEntityState, currentForm } from './model.js';
import { STATUS_SCHEMA_VERSION } from '../status/model.js';

const PREFERENCE_KEY = 'entitySystem';
let canonicalEntityUiStoreDepth = 0;

/**
 * Construct an EntityStore for the editor while marking only that instance as
 * a canonical Token reader. Reducer/controller stores created elsewhere must
 * retain mutable draft Token objects so atomic ActorDelta/health writes persist.
 */
export function withCanonicalEntityTokenReadView(callback) {
  canonicalEntityUiStoreDepth += 1;
  try { return callback(); }
  finally { canonicalEntityUiStoreDepth -= 1; }
}

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

function migrateTokenLocationsToGrid(appState, entityState, mapPackage, api, sourceSchemaVersion = 0) {
  if (Number(sourceSchemaVersion) >= 2) return { migrated: 0, blocked: 0 };
  const width = Number(mapPackage?.width);
  const height = Number(mapPackage?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return { migrated: 0, blocked: 0 };
  const linked = new Set((entityState?.tokens || []).map(token => String(token.characterId || token.id)));
  let migrated = 0;
  let blocked = 0;
  for (const character of appState.characters || []) {
    if (character?.location?.type !== 'map' || !linked.has(String(character.id))) continue;
    const x = Math.max(0.5, Math.min(width - 0.5, Math.floor(Number(character.location.x)) + 0.5));
    const y = Math.max(0.5, Math.min(height - 0.5, Math.floor(Number(character.location.y)) + 0.5));
    // A bad legacy coordinate must never be silently moved into a wall. Keep
    // it intact and surface a GM-only re-placement action instead.
    const inspection = api?.inspectTokenPlacement?.(character.id, { x, y });
    if (inspection && inspection.valid === false) { blocked += 1; continue; }
    if (character.location.x === x && character.location.y === y) continue;
    character.location = { type: 'map', x, y };
    migrated += 1;
  }
  return { migrated, blocked };
}

export class EntityStore {
  constructor(api) {
    this.api = api;
    this.state = createEmptyEntityState();
    this.compatTokens = [];
    this.canonicalTokenReadView = canonicalEntityUiStoreDepth > 0;
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
    this.canonicalTokenReadView = true;
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
    return structuredClone({
      ...this.state,
      // Entity UI reads the live active-Scene Token catalog. Persisting Actor
      // edits carries that same catalog into the temporary Entity projection
      // instead of reviving a stale editor snapshot.
      tokens: this.canonicalTokens(),
    });
  }

  load({ migrateLegacy = true, dropMarkers = true } = {}) {
    const appState = this.api.getState();
    const raw = appState.preferences?.[PREFERENCE_KEY];
    const migrated = migrateLegacy ? migrateLegacyCharacters(raw, appState.characters || []) : { state: normalizeEntityState(raw), migrated: 0 };
    const tokenLocationMigration = migrateTokenLocationsToGrid(appState, migrated.state, this.api.mapPackage, this.api, raw?.schemaVersion);
    const migratedTokenLocations = tokenLocationMigration.migrated;
    const blockedTokenLocations = tokenLocationMigration.blocked;
    // Read-only subsystem stores may normalize an otherwise canonical v2
    // snapshot in memory. Do not create a standalone "entities" commit merely
    // for that version number; the next real mutation persists v3 naturally.
    // The primary Entity System load still commits a schema-only migration.
    let changed = migrated.migrated > 0
      || migratedTokenLocations > 0
      || entityContentChanged(raw, migrated.state)
      || (migrateLegacy && Number(raw?.schemaVersion) !== STATUS_SCHEMA_VERSION);

    if (this.canonicalTokenReadView) this.installCanonicalTokenReadView(migrated.state);
    else {
      this.state = migrated.state;
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
    return { migratedCharacters: migrated.migrated, migratedTokenLocations, blockedTokenLocations, droppedMarkers };
  }

  snapshot() { return this.materializeState(); }

  persist({ appState = null, syncTokens = true, source = 'entities', render = false, immediate = false } = {}) {
    const nextApp = appState || this.api.getState();
    nextApp.preferences ||= {};
    nextApp.preferences[PREFERENCE_KEY] = this.materializeState();
    if (syncTokens) this.syncCharacters(nextApp);
    this.saving = true;
    try {
      // Entity changes are ordinary in-memory World mutations. They must not
      // enter the external-save import path: that path broadcasts state:import
      // to every runtime system and made placing one Token re-import the whole
      // map while its click handler was still running.
      if (typeof this.api.commitState === 'function') this.api.commitState(nextApp, { source, render });
      else this.api.importState(nextApp);
      if (immediate) this.api.persistNow?.();
    } finally {
      queueMicrotask(() => { this.saving = false; });
    }
    return true;
  }

  syncCharacters(appState) {
    const characterMap = new Map((appState.characters || []).map(character => [String(character.id), character]));
    const tokens = this.canonicalTokenReadView ? this.canonicalTokens() : this.state.tokens;
    for (const token of tokens) {
      const character = characterMap.get(String(token.characterId || token.id));
      const actor = this.state.actors.find(item => String(item.id) === String(token.actorId));
      const form = currentForm(actor);
      if (!character || !actor || !form) continue;
      character.name = actor.name;
      character.avatarDataUrl = form.avatarDataUrl || null;
      character.color = form.tokenAppearance?.color || character.color || '#3d9b63';
      character.visible = !token.hidden;
    }
  }

  actor(id) { return this.state.actors.find(actor => String(actor.id) === String(id)) || null; }
  token(id) {
    if (this.canonicalTokenReadView) {
      return this.api.tokens?.get?.(id)
        || this.compatTokens.find(token => String(token.id) === String(id) || String(token.characterId) === String(id))
        || null;
    }
    return this.state.tokens.find(token => (
      String(token.id) === String(id) || String(token.characterId) === String(id)
    )) || null;
  }
  actorForToken(tokenId) {
    const token = this.token(tokenId);
    return token ? this.actor(token.actorId) : null;
  }

  bindToken(actorId, characterId) {
    // Compatibility-only for the Entity UI store. Other reducer stores retain
    // the original mutable draft behavior through mutableTokens().
    const tokens = this.mutableTokens();
    let existing = tokens.find(token => (
      String(token.id) === String(characterId) || String(token.characterId) === String(characterId)
    ));
    if (existing) {
      existing.actorId = actorId;
      existing.effects ||= [];
    } else {
      existing = {
        id: String(characterId),
        characterId: String(characterId),
        actorId: String(actorId),
        diameterMeters: 1,
        rotation: 0,
        elevationFt: 0,
        hidden: false,
        locked: false,
        showName: true,
        effects: [],
      };
      tokens.push(existing);
    }
    return this.canonicalTokenReadView ? (this.token(characterId) || existing) : existing;
  }

  removeToken(characterId) {
    this.replaceMutableTokens(this.mutableTokens().filter(token => (
      String(token.characterId || token.id) !== String(characterId)
    )));
  }

  removeActor(actorId) {
    this.state.actors = this.state.actors.filter(actor => String(actor.id) !== String(actorId));
    this.replaceMutableTokens(this.mutableTokens().filter(token => String(token.actorId) !== String(actorId)));
  }
}
