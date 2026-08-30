function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInitiative(value) {
  return value === '' || value == null ? null : finite(value);
}

function elevation(value) {
  return Math.max(0, finite(value) ?? 0);
}

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${value}`;
}

export function createEmptyCombatState() {
  return { schemaVersion: 2, combat: null };
}

function normalizeTurnOrigin(raw, combat) {
  if (combat?.state !== 'active' || !combat.combatants.length || !raw || typeof raw !== 'object') return null;
  const x = finite(raw.x);
  const y = finite(raw.y);
  return x === null || y === null ? null : { x, y, elevationFt: elevation(raw.elevationFt) };
}

export function normalizeCombatState(raw) {
  if (!raw || typeof raw !== 'object' || !raw.combat) return createEmptyCombatState();
  const source = raw.combat;
  const combatants = Array.isArray(source.combatants)
    ? source.combatants.filter(item => item?.tokenId).map((item, index) => ({
        id: String(item.id || `combatant-${item.tokenId}`),
        tokenId: String(item.tokenId),
        actorId: item.actorId == null ? null : String(item.actorId),
        initiative: finiteInitiative(item.initiative),
        order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      }))
    : [];
  const state = source.state === 'active' ? 'active' : 'setup';
  const turnIndex = Math.max(0, Math.min(combatants.length ? combatants.length - 1 : 0, Number(source.turnIndex) || 0));
  const combat = {
    id: String(source.id || uid('combat')),
    state,
    round: state === 'active' ? Math.max(1, Number(source.round) || 1) : 0,
    turnIndex,
    combatants,
    turnOrigin: null,
  };
  combat.turnOrigin = normalizeTurnOrigin(source.turnOrigin, combat);
  return { schemaVersion: 2, combat };
}

export function createCombat(tokenRefs = []) {
  return {
    id: uid('combat'),
    state: 'setup',
    round: 0,
    turnIndex: 0,
    combatants: tokenRefs.map((item, index) => ({
      id: `combatant-${item.tokenId}`,
      tokenId: String(item.tokenId),
      actorId: item.actorId == null ? null : String(item.actorId),
      initiative: null,
      order: index,
    })),
    turnOrigin: null,
  };
}

export function currentCombatant(combat) {
  if (!combat?.combatants?.length) return null;
  return combat.combatants[Math.max(0, Math.min(combat.combatants.length - 1, combat.turnIndex || 0))] || null;
}

export function setCombatTurnOrigin(combat, point) {
  if (combat?.state !== 'active' || !currentCombatant(combat)) return null;
  const x = finite(point?.x);
  const y = finite(point?.y);
  if (x === null || y === null) return combat.turnOrigin = null;
  return combat.turnOrigin = { x, y, elevationFt: elevation(point?.elevationFt) };
}

function preserveCurrent(combat, mutate) {
  const currentId = combat?.state === 'active' ? currentCombatant(combat)?.id : null;
  mutate();
  if (currentId) {
    const index = combat.combatants.findIndex(item => item.id === currentId);
    combat.turnIndex = index >= 0 ? index : Math.min(combat.turnIndex || 0, Math.max(0, combat.combatants.length - 1));
    if (index < 0) combat.turnOrigin = null;
  } else {
    combat.turnIndex = 0;
  }
  return combat;
}

export function sortCombatantsByInitiative(combat) {
  if (!combat) return combat;
  return preserveCurrent(combat, () => {
    combat.combatants.sort((a, b) => {
      const aValue = finiteInitiative(a.initiative);
      const bValue = finiteInitiative(b.initiative);
      if (aValue == null && bValue == null) return a.order - b.order;
      if (aValue == null) return 1;
      if (bValue == null) return -1;
      if (bValue !== aValue) return bValue - aValue;
      return a.order - b.order;
    });
    combat.combatants.forEach((item, index) => { item.order = index; });
  });
}

export function setCombatantInitiative(combat, combatantId, value) {
  const item = combat?.combatants?.find(entry => entry.id === combatantId);
  if (!item) return false;
  item.initiative = finiteInitiative(value);
  sortCombatantsByInitiative(combat);
  return true;
}

export function addCombatants(combat, tokenRefs = []) {
  if (!combat) return 0;
  const existing = new Set(combat.combatants.map(item => String(item.tokenId)));
  let added = 0;
  for (const ref of tokenRefs) {
    const tokenId = String(ref?.tokenId || '');
    if (!tokenId || existing.has(tokenId)) continue;
    combat.combatants.push({
      id: `combatant-${tokenId}`,
      tokenId,
      actorId: ref.actorId == null ? null : String(ref.actorId),
      initiative: null,
      order: combat.combatants.length,
    });
    existing.add(tokenId);
    added += 1;
  }
  return added;
}

export function removeCombatant(combat, combatantId) {
  if (!combat) return false;
  const currentId = combat.state === 'active' ? currentCombatant(combat)?.id : null;
  const index = combat.combatants.findIndex(item => item.id === combatantId);
  if (index < 0) return false;
  combat.combatants.splice(index, 1);
  combat.combatants.forEach((item, order) => { item.order = order; });
  if (!combat.combatants.length) {
    combat.turnIndex = 0;
    combat.turnOrigin = null;
    return true;
  }
  if (currentId) {
    const nextIndex = combat.combatants.findIndex(item => item.id === currentId);
    combat.turnIndex = nextIndex >= 0 ? nextIndex : Math.min(index, combat.combatants.length - 1);
    if (nextIndex < 0) combat.turnOrigin = null;
  } else {
    combat.turnIndex = 0;
  }
  return true;
}

export function moveCombatant(combat, combatantId, targetCombatantId) {
  if (!combat || combatantId === targetCombatantId) return false;
  const from = combat.combatants.findIndex(item => item.id === combatantId);
  const to = combat.combatants.findIndex(item => item.id === targetCombatantId);
  if (from < 0 || to < 0) return false;
  const currentId = combat.state === 'active' ? currentCombatant(combat)?.id : null;
  const [item] = combat.combatants.splice(from, 1);
  combat.combatants.splice(to, 0, item);
  combat.combatants.forEach((entry, index) => { entry.order = index; });
  if (currentId) combat.turnIndex = Math.max(0, combat.combatants.findIndex(entry => entry.id === currentId));
  return true;
}

export function startCombat(combat) {
  if (!combat?.combatants?.length) return false;
  combat.state = 'active';
  combat.round = 1;
  combat.turnIndex = 0;
  combat.turnOrigin = null;
  return true;
}

export function nextTurn(combat) {
  if (combat?.state !== 'active' || !combat.combatants.length) return null;
  combat.turnIndex += 1;
  if (combat.turnIndex >= combat.combatants.length) {
    combat.turnIndex = 0;
    combat.round = Math.max(1, Number(combat.round) || 1) + 1;
  }
  combat.turnOrigin = null;
  return currentCombatant(combat);
}
