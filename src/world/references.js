import { normalizeCombatState, removeCombatant } from '../combat/model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function id(value) {
  return String(value ?? '').trim();
}

/**
 * Remove runtime references that became invalid because a canonical World
 * structural mutation removed Actors or active-Scene Tokens.
 *
 * This runs on the projected compatibility state immediately before the World
 * commit reaches Local/LAN authority. It deliberately does not mutate World V2
 * itself: Combat remains a runtime subsystem until its own World document
 * migration lands.
 */
export function pruneProjectedWorldReferences(state) {
  const next = clone(state || {});
  const preferences = next.preferences;
  const combatRaw = preferences?.combatSystem;
  if (!preferences || combatRaw === undefined) return next;

  const entity = preferences.entitySystem || {};
  const actorIds = new Set(array(entity.actors).map(actor => id(actor?.id)).filter(Boolean));
  const tokenIds = new Set(array(entity.tokens).map(token => id(token?.id)).filter(Boolean));
  const normalized = normalizeCombatState(combatRaw);
  const combat = normalized.combat;
  if (!combat?.combatants?.length) {
    preferences.combatSystem = normalized;
    return next;
  }

  for (const combatant of [...combat.combatants]) {
    const tokenValid = tokenIds.has(id(combatant.tokenId));
    const actorValid = combatant.actorId == null || actorIds.has(id(combatant.actorId));
    if (tokenValid && actorValid) continue;
    removeCombatant(combat, combatant.id);
  }

  if (!combat.combatants.length) normalized.combat = null;
  preferences.combatSystem = normalized;
  return next;
}
