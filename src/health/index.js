import { createHealthController } from './controller.js';
import { createHealthSheetExtension } from './sheet-extension.js';
import { createHealthTokenBars } from './token-bars.js';

export * from './model.js';

export function createHealthSystem() {
  const controller = createHealthController();
  const sheet = createHealthSheetExtension();
  const tokenBars = createHealthTokenBars();
  return {
    register(api) {
      controller.register(api);
      sheet.register(api);
      tokenBars.register(api);
    },
  };
}
