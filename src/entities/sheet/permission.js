export const ACTOR_PERMISSION_LEVELS = Object.freeze({
  NONE: 'NONE',
  LIMITED: 'LIMITED',
  OBSERVER: 'OBSERVER',
  OWNER: 'OWNER',
});

const ORDER = Object.freeze({
  NONE: 0,
  LIMITED: 1,
  OBSERVER: 2,
  OWNER: 3,
});

function normalize(value) {
  const key = String(value || '').toUpperCase();
  return ACTOR_PERMISSION_LEVELS[key] || ACTOR_PERMISSION_LEVELS.NONE;
}

export function actorPermissionLevel(actor, userId) {
  const id = String(userId || '').trim();
  if (!id) return ACTOR_PERMISSION_LEVELS.NONE;
  return normalize(actor?.ownership?.users?.[id] || actor?.permission?.users?.[id]);
}

export function hasActorPermission(actor, userId, required) {
  return ORDER[actorPermissionLevel(actor, userId)] >= ORDER[normalize(required)];
}

export function createSheetContext({ actor, userId, mode = 'play' } = {}) {
  const level = actorPermissionLevel(actor, userId);
  return Object.freeze({
    level,
    mode,
    editable: level === ACTOR_PERMISSION_LEVELS.OWNER && mode === 'edit',
    interactive: level === ACTOR_PERMISSION_LEVELS.OWNER,
    limited: level === ACTOR_PERMISSION_LEVELS.LIMITED,
    observable: level >= ACTOR_PERMISSION_LEVELS.OBSERVER,
  });
}
