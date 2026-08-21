const CORE_RESOURCE_DEFS = Object.freeze([
  { id: 'hp', name: '生命', kind: 'hp' },
  { id: 'stamina', name: '精力', kind: 'stamina' },
  { id: 'willpower', name: '意志', kind: 'willpower' },
]);

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${value}`;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function clone(value) {
  return structuredClone(value);
}

export function createEmptyEntityState() {
  return { schemaVersion: 1, actors: [], tokens: [] };
}

export function createFormFromImport(imported, { id = uid('form'), name = imported.formName || '默认形态' } = {}) {
  const resourceBases = {};
  for (const def of CORE_RESOURCE_DEFS) {
    resourceBases[def.id] = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      baseMax: Math.max(0, finite(imported.resources?.[def.id]?.max ?? imported.resources?.[def.id], 0)),
    };
  }
  return {
    id,
    name: text(name, '默认形态'),
    avatarDataUrl: imported.avatarDataUrl || null,
    identity: clone(imported.identity || {}),
    description: clone(imported.description || {}),
    resourceBases,
    attributes: clone(imported.attributes || []),
    checks: {
      skills: clone(imported.checks?.skills || []),
      saves: clone(imported.checks?.saves || []),
    },
    combat: clone(imported.combat || { attacks: [], defenses: [] }),
    tokenAppearance: {
      color: imported.tokenAppearance?.color || '#3d9b63',
      scale: finite(imported.tokenAppearance?.scale, 1) || 1,
    },
    source: clone(imported.source || null),
  };
}

export function createActorFromImport(imported, { id = uid('actor'), formId, formName } = {}) {
  const form = createFormFromImport(imported, { id: formId || uid('form'), name: formName || imported.formName });
  const resources = {};
  for (const def of CORE_RESOURCE_DEFS) {
    const maximum = form.resourceBases[def.id]?.baseMax || 0;
    resources[def.id] = { current: maximum, maxOverride: null, policy: 'preserve' };
  }
  return {
    id,
    name: text(imported.identity?.name, '未命名角色'),
    currentFormId: form.id,
    forms: [form],
    runtime: {
      resources,
      customResources: [],
      attributeAdjustments: {},
    },
    effects: [],
    notes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function createLegacyActor(character, { actorId = uid('actor') } = {}) {
  const imported = {
    formName: '默认形态',
    identity: { name: character.name || '未命名角色' },
    avatarDataUrl: character.avatarDataUrl || null,
    resources: { hp: 0, stamina: 0, willpower: 0 },
    attributes: [],
    checks: { skills: [], saves: [] },
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: character.color || '#3d9b63', scale: 1 },
    source: { type: 'legacy-character', characterId: character.id },
  };
  return createActorFromImport(imported, { id: actorId, formName: '默认形态' });
}

export function createTokenForActor(actorId, characterId, overrides = {}) {
  return {
    id: String(characterId),
    actorId: String(actorId),
    characterId: String(characterId),
    size: finite(overrides.size, 1) || 1,
    rotation: finite(overrides.rotation, 0),
    hidden: Boolean(overrides.hidden),
    locked: Boolean(overrides.locked),
    showName: overrides.showName !== false,
  };
}

export function normalizeEntityState(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyEntityState();
  const actors = Array.isArray(raw.actors) ? raw.actors.filter(Boolean).map(actor => ({
    ...clone(actor),
    forms: Array.isArray(actor.forms) ? clone(actor.forms) : [],
    runtime: {
      resources: clone(actor.runtime?.resources || {}),
      customResources: Array.isArray(actor.runtime?.customResources) ? clone(actor.runtime.customResources) : [],
      attributeAdjustments: clone(actor.runtime?.attributeAdjustments || {}),
    },
    effects: Array.isArray(actor.effects) ? clone(actor.effects) : [],
  })) : [];
  const actorIds = new Set(actors.map(actor => String(actor.id)));
  const tokens = Array.isArray(raw.tokens) ? raw.tokens.filter(token => token && actorIds.has(String(token.actorId))).map(clone) : [];
  return { schemaVersion: 1, actors, tokens };
}

export function migrateLegacyCharacters(entityState, characters = []) {
  const next = normalizeEntityState(entityState);
  const linkedCharacterIds = new Set(next.tokens.map(token => String(token.characterId || token.id)));
  let migrated = 0;
  for (const character of characters || []) {
    if (!character?.id || linkedCharacterIds.has(String(character.id))) continue;
    const actor = createLegacyActor(character);
    next.actors.push(actor);
    next.tokens.push(createTokenForActor(actor.id, character.id));
    linkedCharacterIds.add(String(character.id));
    migrated += 1;
  }
  return { state: next, migrated };
}

export function actorForToken(entityState, tokenId) {
  const token = entityState.tokens.find(item => String(item.id) === String(tokenId) || String(item.characterId) === String(tokenId));
  if (!token) return null;
  return entityState.actors.find(actor => String(actor.id) === String(token.actorId)) || null;
}

export function currentForm(actor) {
  if (!actor?.forms?.length) return null;
  return actor.forms.find(form => form.id === actor.currentFormId) || actor.forms[0];
}

export function addFormToActor(actor, imported, options = {}) {
  const form = createFormFromImport(imported, options);
  actor.forms.push(form);
  actor.currentFormId = form.id;
  actor.updatedAt = new Date().toISOString();
  for (const def of CORE_RESOURCE_DEFS) {
    actor.runtime.resources[def.id] ||= {
      current: form.resourceBases[def.id]?.baseMax || 0,
      maxOverride: null,
      policy: 'preserve',
    };
  }
  return form;
}

export { CORE_RESOURCE_DEFS };
