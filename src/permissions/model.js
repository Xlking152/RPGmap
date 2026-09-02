export const ACCESS_SCHEMA_VERSION = 4;

export const ACTOR_ACCESS = Object.freeze({
  NONE: 'none',
  LIMITED: 'limited',
  OBSERVER: 'observer',
  OWNER: 'owner',
});

const ACCESS_RANK = Object.freeze({ none: 0, limited: 1, observer: 2, owner: 3 });

export function normalizeActorAccessLevel(value) {
  const level = String(value || '').toLowerCase();
  return Object.hasOwn(ACCESS_RANK, level) ? level : ACTOR_ACCESS.NONE;
}

export function actorAccessAtLeast(value, minimum) {
  return ACCESS_RANK[normalizeActorAccessLevel(value)] >= ACCESS_RANK[normalizeActorAccessLevel(minimum)];
}

function tokenControlled(token, actor, context) {
  if (context.role === 'gm') return true;
  const userId = String(context.userId || '');
  if (userId && (token?.controllerUserIds || []).map(String).includes(userId)) return true;
  return actor?.type === 'pc' && normalizeActorAccessLevel(context.actorAccess) === ACTOR_ACCESS.OWNER;
}

export function canPermission(action, context = {}) {
  if (context.role === 'gm') return true;
  const actorAccess = normalizeActorAccessLevel(context.actorAccess);
  const controlled = tokenControlled(context.token, context.actor, { ...context, actorAccess });
  switch (String(action || '')) {
    case 'actor.list':
    case 'actor.viewLimited':
      return actorAccessAtLeast(actorAccess, ACTOR_ACCESS.LIMITED) || context.publicActor === true;
    case 'actor.view': return actorAccessAtLeast(actorAccess, ACTOR_ACCESS.OBSERVER);
    case 'actor.edit':
    case 'actor.delete': return actorAccess === ACTOR_ACCESS.OWNER;
    case 'token.view': return context.tokenVisible !== false;
    case 'token.control': return controlled;
    case 'token.move':
      return controlled && context.token?.locked !== true
        && context.statusCapabilities?.canMove !== false
        && (!context.activeCombatTokenId || String(context.activeCombatTokenId) === String(context.token?.id));
    case 'token.editHealth':
    case 'token.editStatus': return controlled;
    case 'token.editAccess': return false;
    case 'token.useVision':
      return controlled || (context.token?.vision?.overrideUserIds || []).map(String).includes(String(context.userId || ''));
    default: return false;
  }
}
