import { createHealthController } from './controller.js';
import { createHealthSheetExtension } from './sheet-extension.js';
import { createHealthTokenBarsV2 } from './token-bars-v2.js';
import { createHealthInstanceUi } from './instance-ui.js';

export * from './model.js';
export { createHealthSelectionHud } from './selection-hud.js';

export function createHealthSystem() {
  const controller = createHealthController();
  const sheet = createHealthSheetExtension();
  const tokenBars = createHealthTokenBarsV2();
  const instanceUi = createHealthInstanceUi();
  return {
    register(api) {
      controller.register(api);
      sheet.register(api);
      tokenBars.register(api);
      instanceUi.register(api);
    },
  };
}
