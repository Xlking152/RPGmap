const RETIRED_CHARACTER_API = Object.freeze([
  'placeCharacter',
  'repositionCharacter',
  'selectCharacter',
  'focusCharacter',
  'planCharacterMove',
  'commitCharacterMove',
  'cancelCharacterMove',
  'deleteCharacter',
  'enterBuilding',
  'exitBuilding',
]);

function legacyEntityToken(state, characterId) {
  const target = String(characterId ?? '').trim();
  if (!target) return null;
  return (state?.preferences?.entitySystem?.tokens || []).find(token => (
    String(token?.id ?? token?.characterId ?? '') === target
  )) || null;
}

/**
 * Compile-time compatibility for the retired AppCore shell only.
 *
 * Modern movement/elevation code must never call this function. AppCore still
 * participates in the bundle while it owns SaveV2 migration, so its historical
 * import needs a small adapter until that shell is removed. The adapter reads
 * only the compatibility Token projection and deliberately does not resolve
 * Actor/status mechanics; authoritative movement is handled by Token Runtime.
 */
export function legacyAppCoreMoverContext(state, characterId) {
  const id = characterId == null ? null : String(characterId);
  const token = id ? legacyEntityToken(state, id) : null;
  const elevation = Number(token?.elevationFt);
  const diameter = Number(token?.diameterMeters ?? token?.size);
  return Object.freeze({
    characterId: id,
    tokenId: token?.id == null ? null : String(token.id),
    elevationFt: Number.isFinite(elevation) && elevation >= 0 ? elevation : 0,
    diameterMeters: [1, 5, 10, 20].includes(diameter) ? diameter : 1,
    statusVersion: 'retired-appcore',
    collisionBypassGroups: Object.freeze([]),
  });
}

/**
 * Final V1.5 retirement boundary.
 *
 * AppCore still contains the SaveV2 Character parser/render shell so old saves
 * can be migrated without a second loader. By the time this system registers,
 * every live workflow is canonical World/Scene/Actor/Token. Remove the old
 * public mutation/selection surface and detach its Leaflet pane so no plugin or
 * later runtime module can accidentally revive Character as a document type.
 */
export function createCharacterRetirementSystem() {
  return Object.freeze({
    register(api) {
      if (!api || api.characterRuntimeRetired === true) return;

      for (const key of RETIRED_CHARACTER_API) {
        if (Object.prototype.hasOwnProperty.call(api, key)) delete api[key];
      }

      // Multiplayer used to expose a Character-id convenience alias for Token
      // ownership. Runtime movement now falls back to the canonical Actor gate
      // once this alias is removed.
      if (api.multiplayer && Object.prototype.hasOwnProperty.call(api.multiplayer, 'canControlCharacter')) {
        delete api.multiplayer.canControlCharacter;
      }

      const pane = api.map?.getPane?.('characterPane');
      if (pane) {
        pane.replaceChildren?.();
        pane.style.visibility = 'hidden';
        pane.style.pointerEvents = 'none';
        pane.setAttribute?.('aria-hidden', 'true');
        pane.remove?.();
      }

      const statusPane = api.map?.getPane?.('statusBadgePane');
      if (statusPane) {
        statusPane.replaceChildren?.();
        statusPane.style.visibility = 'hidden';
        statusPane.style.pointerEvents = 'none';
        statusPane.setAttribute?.('aria-hidden', 'true');
        statusPane.remove?.();
      }

      api.characterRuntimeRetired = true;
      api.legacyMigration = Object.freeze({
        characterSaveV2Input: true,
        runtimeCharacterDocuments: false,
      });
      api.emit?.('runtime:character-retired', {
        canonical: 'World.scenes[].tokens[]',
        migrationOnly: true,
      });
    },
  });
}
