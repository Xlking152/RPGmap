export const ACTOR_PERMISSION_LEVELS = Object.freeze({
  NONE: 'none', LIMITED: 'limited', OBSERVER: 'observer', OWNER: 'owner', GM: 'gm',
});

const LEVELS = new Set(Object.values(ACTOR_PERMISSION_LEVELS));

export function normalizeSheetPermissionLevel(value) {
  const level = String(value || '').toLowerCase();
  return LEVELS.has(level) ? level : ACTOR_PERMISSION_LEVELS.NONE;
}

export function createSheetContext({
  permissionLevel = 'none', mode = 'play', target = 'template',
  canRuntimeEdit = false, canTokenEdit = false,
} = {}) {
  const level = normalizeSheetPermissionLevel(permissionLevel);
  const owner = level === ACTOR_PERMISSION_LEVELS.OWNER || level === ACTOR_PERMISSION_LEVELS.GM;
  const interactionMode = mode === 'edit' && owner && target === 'template' ? 'edit' : 'play';
  return Object.freeze({
    level, mode: interactionMode, target,
    visible: level !== ACTOR_PERMISSION_LEVELS.NONE,
    limited: level === ACTOR_PERMISSION_LEVELS.LIMITED,
    observable: [ACTOR_PERMISSION_LEVELS.OBSERVER, ACTOR_PERMISSION_LEVELS.OWNER, ACTOR_PERMISSION_LEVELS.GM].includes(level),
    owner,
    editable: owner && interactionMode === 'edit' && target === 'template',
    runtimeInteractive: owner && canRuntimeEdit === true,
    tokenEditable: canTokenEdit === true,
    canToggleMode: owner && target === 'template',
  });
}
