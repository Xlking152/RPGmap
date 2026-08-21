import { createHealthController } from './controller.js';
import { createHealthSheetExtension } from './sheet-extension.js';

export * from './model.js';
export * from './actor.js';

export function createHealthSystem() {
  const controller = createHealthController();
  const sheet = createHealthSheetExtension();
  return {
    register(api) {
      controller.register(api);
      sheet.register(api);
    },
  };
}
