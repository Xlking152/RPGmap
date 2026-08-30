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
  setCombatTurnOrigin,
  clearCombatTurnOrigin,
  combatTurnOriginMoved,
  startCombat,
  nextTurn,
} from './model.js';
export { captureCurrentTurnOrigin } from './controller.js';
export { createCombatTurnOriginRenderer } from './turn-origin-renderer.js';
export { CombatStore } from './store.js';

export function createCombatSystem(options = {}) {
  return {
    register(api) {
      createCombatController(options).register(api);
      createCombatTurnOriginRenderer().register(api);
    },
  };
}
