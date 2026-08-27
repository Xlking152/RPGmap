import { createAppShellUiV2 } from './app-shell-v2.js';

export { UI_CONTEXT_PANELS, entityStateFromApp, findSelectedEntity, isMovementStatus, selectionStatus } from './model.js';
export { createAppShellUiV2 } from './app-shell-v2.js';

export function createAppShellUi() {
  return createAppShellUiV2();
}
