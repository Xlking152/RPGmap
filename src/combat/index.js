import { createCombatController } from './controller.js';

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
  return createCombatController(options);
}
