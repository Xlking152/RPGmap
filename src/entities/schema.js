function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function uid(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

/**
 * Normalize imported character cards before they enter the entity runtime.
 * Invalid/empty cards are converted into safe placeholders instead of
 * propagating undefined fields into token creation.
 */
export function normalizeCharacterCard(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: source.id || uid('character'),
    formName: text(source.formName, '默认形态'),
    identity: {
      ...(source.identity || {}),
      name: text(source.identity?.name, '未命名角色'),
    },
    description: source.description && typeof source.description === 'object'
      ? source.description
      : {},
    resources: source.resources && typeof source.resources === 'object'
      ? source.resources
      : { hp: { max: 0 }, stamina: { max: 0 }, willpower: { max: 0 } },
    attributes: Array.isArray(source.attributes) ? source.attributes : [],
    checks: source.checks && typeof source.checks === 'object'
      ? source.checks
      : { skills: [], saves: [] },
    badStatuses: Array.isArray(source.badStatuses) ? source.badStatuses : [],
    combat: source.combat && typeof source.combat === 'object'
      ? source.combat
      : { attacks: [], defenses: [] },
    tokenAppearance: source.tokenAppearance && typeof source.tokenAppearance === 'object'
      ? source.tokenAppearance
      : { color: '#3d9b63', scale: 1 },
    source: source.source || { type: 'normalized-import' },
    avatarDataUrl: source.avatarDataUrl || null,
  };
}

export function isValidEntityState(state) {
  return Boolean(state && typeof state === 'object' && Array.isArray(state.actors) && Array.isArray(state.tokens));
}

export function safeEntityState(state) {
  return isValidEntityState(state) ? state : { schemaVersion: 1, actors: [], tokens: [] };
}
