import { setActiveMoverContext } from './runtime-context.js';

export const GROUND_PLACEMENT_MOVER_CONTEXT = Object.freeze({
  characterId: null,
  elevationFt: 0,
});

export function isCharacterPlacementControl(target) {
  const control = target?.closest?.('[data-action="place-character"]');
  return Boolean(control);
}

/**
 * V1.5 compatibility guard for the historical app shell.
 *
 * The old app handles the Place Character button through its private setTool()
 * function, so the public api.setTool wrapper used by Elevation cannot observe
 * that one UI transition. Capture the button activation before the legacy app
 * click handler runs and reset Navigation to a ground mover. Programmatic
 * api.setTool('character-place') is already handled by the main Elevation
 * adapter and does not depend on this guard.
 */
export function createPlacementContextGuard() {
  return {
    register(api) {
      const mapElement = api.map?.getContainer?.();
      const shell = mapElement?.closest?.('.app-shell') || mapElement?.parentElement || null;
      if (!shell?.addEventListener) return;

      const onClickCapture = (event) => {
        if (!isCharacterPlacementControl(event.target)) return;
        setActiveMoverContext(GROUND_PLACEMENT_MOVER_CONTEXT);
      };

      shell.addEventListener('click', onClickCapture, true);

      api.on?.('app:destroy', () => {
        shell.removeEventListener('click', onClickCapture, true);
      });
    },
  };
}
