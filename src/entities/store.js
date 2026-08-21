import { createEmptyEntityState, migrateLegacyCharacters, normalizeEntityState, currentForm } from './model.js';

const PREFERENCE_KEY = 'entitySystem';

export class EntityStore {
  constructor(api) {
    this.api = api;
    this.state = createEmptyEntityState();
    this.saving = false;
  }

  load({ migrateLegacy = true, dropMarkers = true } = {}) {
    const appState = this.api.getState();
    const raw = appState.preferences?.[PREFERENCE_KEY];
    const migrated = migrateLegacy ? migrateLegacyCharacters(raw, appState.characters || []) : { state: normalizeEntityState(raw), migrated: 0 };
    this.state = migrated.state;
    let changed = migrated.migrated > 0 || !raw;
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
    return { migratedCharacters: migrated.migrated, droppedMarkers };
  }

  snapshot() { return structuredClone(this.state); }

  persist({ appState = null, syncTokens = true } = {}) {
    const nextApp = appState || this.api.getState();
    nextApp.preferences ||= {};
    nextApp.preferences[PREFERENCE_KEY] = structuredClone(this.state);
    if (syncTokens) this.syncCharacters(nextApp);
    this.saving = true;
    try {
      this.api.importState(nextApp);
    } finally {
      queueMicrotask(() => { this.saving = false; });
    }
    return true;
  }

  syncCharacters(appState) {
    const characterMap = new Map((appState.characters || []).map(character => [String(character.id), character]));
    for (const token of this.state.tokens) {
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
  token(id) { return this.state.tokens.find(token => String(token.id) === String(id) || String(token.characterId) === String(id)) || null; }
  actorForToken(tokenId) { const token = this.token(tokenId); return token ? this.actor(token.actorId) : null; }

  bindToken(actorId, characterId) {
    const existing = this.token(characterId);
    if (existing) existing.actorId = actorId;
    else this.state.tokens.push({ id: String(characterId), characterId: String(characterId), actorId: String(actorId), size: 1, rotation: 0, hidden: false, locked: false, showName: true });
    return this.token(characterId);
  }

  removeToken(characterId) {
    this.state.tokens = this.state.tokens.filter(token => String(token.characterId) !== String(characterId));
  }
}
