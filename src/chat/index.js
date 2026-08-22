import { createChatController } from './controller.js';

export * from './model.js';
export { ChatStore } from './store.js';

export function createChatSystem(options = {}) {
  const controller = createChatController(options);
  return {
    register(api) {
      controller.register(api);
      if (!api.chat) return;
      api.chat.addSystem = api.chat.system;
      api.chat.addCombat = api.chat.combat;
      api.chat.addDamage = api.chat.damage;
      api.chat.addHealing = api.chat.healing;
      api.chat.addRoll = api.chat.roll;
      api.chat.open = api.chat.activate;
    },
  };
}
