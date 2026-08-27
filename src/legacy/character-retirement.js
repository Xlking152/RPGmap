const RETIRED_CHARACTER_API = Object.freeze([
  'placeCharacter',
  'repositionCharacter',
  'selectCharacter',
  'planCharacterMove',
  'commitCharacterMove',
  'cancelCharacterMove',
  'deleteCharacter',
  'enterBuilding',
  'exitBuilding',
]);

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

      const pane = api.map?.getPane?.('characterPane');
      if (pane) {
        pane.replaceChildren?.();
        pane.style.visibility = 'hidden';
        pane.style.pointerEvents = 'none';
        pane.setAttribute?.('aria-hidden', 'true');
        // Detach the legacy DOM pane after all canonical render systems have
        // registered. AppCore's Character layer remains empty because World V2
        // projects an empty Character tombstone.
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
