import { createCombatController } from './controller.js';
import { createCombatTurnOriginRenderer } from './turn-origin-renderer.js';

export {
  createEmptyCombatState,
  normalizeCombatState,
  createCombat,
  currentCombatant,
  sortCombatantsByInitiative,
  setCombatantInitiative,
  addCombatants,
  removeCombatant,
  moveCombatant,
  startCombat,
  nextTurn,
} from './model.js';
export { CombatStore } from './store.js';

export function createCombatSystem(options = {}) {
  return {
    register(api) {
      createCombatController(options).register(api);
      createCombatTurnOriginRenderer().register(api);
    },
  };
}
