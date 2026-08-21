import { createAppShellUi as createShellUi } from './app-shell.js';
import { createLegacyUiBridge } from './legacy-bridge.js';

export { UI_CONTEXT_PANELS, entityStateFromApp, findSelectedEntity, isMovementStatus, selectionStatus } from './model.js';
export { createLegacyUiBridge } from './legacy-bridge.js';

export function createAppShellUi() {
  const shell = createShellUi();
  const bridge = createLegacyUiBridge();
  return {
    register(api) {
      shell.register(api);
      bridge.register(api);
    },
  };
}
