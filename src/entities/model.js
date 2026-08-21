import { createHealthRuntime, defaultHealthMode, normalizeHealthRuntime } from '../health/model.js';
const CORE_RESOURCE_DEFS = Object.freeze([
  { id: 'hp', name: '生命', kind: 'hp' },
  { id: 'stamina', name: '精力', kind: 'stamina' },
  { id: 'willpower', name: '意志', kind: 'willpower' },
]);

const BAD_STATUS_DEFS = Object.freeze([
  { id: 'bad-status-32', name: '冻结点数', group: 0 },
  { id: 'bad-status-33', name: '失速点数', group: 0 },
  { id: 'bad-status-34', name: '燃烧点数', group: 0 },
  { id: 'bad-status-35', name: '纠缠点数', group: 0 },
  { id: 'bad-status-36', name: '恶心点数', group: 1 },
  { id: 'bad-status-37', name: '晶化点数', group: 1 },
  { id: 'bad-status-38', name: '麻痹点数', group: 1 },
  { id: 'bad-status-39', name: '剧痛点数', group: 1 },
  { id: 'bad-status-40', name: '眩晕点数', group: 1 },
  { id: 'bad-status-41', name: '肢体妨碍', group: 2 },
  { id: 'bad-status-42', name: '流血点数', group: 2 },
  { id: 'bad-status-43', name: '疲乏点数', group: 2 },
  { id: 'bad-status-44', name: '耳鸣点数', group: 3 },
  { id: 'bad-status-45', name: '目眩点数', group: 3 },
  { id: 'bad-status-46', name: '沮丧点数', group: 4 },
  { id: 'bad-status-47', name: '亢奋点数', group: 4 },
  { id: 'bad-status-48', name: '恐惧点数', group: 4 },
  { id: 'bad-status-49', name: '仇恨点数', group: 4 },
  { id: 'bad-status-50', name: '欲眠点数', group: 4 },
  { id: 'bad-status-51', name: '精神束缚', group: 4 },
  { id: 'bad-status-52', name: '魅惑点数', group: 5 },
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

function emptyBadStatuses() {
  return BAD_STATUS_DEFS.map(def => ({ id: def.id, name: def.name, light: 0, severe: 0, destruction: 0 }));
}

function migrateBadStatuses(form) {
  if (Array.isArray(form?.badStatuses) && form.badStatuses.length) return clone(form.badStatuses);
  const legacySaves = Array.isArray(form?.checks?.saves) ? form.checks.saves : [];
  const legacyThresholds = legacySaves.filter(item =>
    Number.isFinite(Number(item?.light)) && Number.isFinite(Number(item?.severe)) && Number.isFinite(Number(item?.devastating))
  );
  if (!legacyThresholds.length) return emptyBadStatuses();
  return BAD_STATUS_DEFS.map(def => {
    const threshold = legacyThresholds[def.group] || {};
    return {
      id: def.id,
      name: def.name,
      light: Math.max(0, finite(threshold.light)),
      severe: Math.max(0, finite(threshold.severe)),
      destruction: Math.max(0, finite(threshold.devastating)),
    };
  });
}

function normalizeForm(form) {
  const next = clone(form || {});
  const legacySaves = Array.isArray(next.checks?.saves) ? next.checks.saves : [];
  const savesWereThresholds = legacySaves.some(item => item && 'light' in item && 'severe' in item && 'devastating' in item);
  next.checks = {
    skills: Array.isArray(next.checks?.skills) ? clone(next.checks.skills) : [],
    saves: savesWereThresholds ? [] : clone(legacySaves),
  };
  next.badStatuses = migrateBadStatuses(form);
  return next;
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
    badStatuses: Array.isArray(imported.badStatuses) && imported.badStatuses.length ? clone(imported.badStatuses) : emptyBadStatuses(),
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
  const badStatuses = Object.fromEntries((form.badStatuses || []).map(status => [status.id, 0]));
  return {
    id,
    name: text(imported.identity?.name, '未命名角色'),
    currentFormId: form.id,
    forms: [form],
    runtime: {
      resources,
      customResources: [],
      attributeAdjustments: {},
      badStatuses,
      health: createHealthRuntime({
        mode: defaultHealthMode(imported.source?.type),
        max: form.resourceBases.hp?.baseMax || 0,
        simpleCurrent: resources.hp?.current ?? form.resourceBases.hp?.baseMax ?? 0,
      }),
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
    badStatuses: emptyBadStatuses(),
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
  const actors = Array.isArray(raw.actors) ? raw.actors.filter(Boolean).map(actor => {
    const forms = Array.isArray(actor.forms) ? actor.forms.map(normalizeForm) : [];
    const badStatuses = clone(actor.runtime?.badStatuses || {});
    for (const form of forms) {
      for (const status of form.badStatuses || []) {
        if (badStatuses[status.id] === undefined) badStatuses[status.id] = 0;
      }
    }
    const resources = clone(actor.runtime?.resources || {});
    const activeForm = forms.find(form => form.id === actor.currentFormId) || forms[0] || null;
    const hpMax = Math.max(0, finite(activeForm?.resourceBases?.hp?.baseMax));
    const hpCurrent = finite(resources?.hp?.current, hpMax);
    return {
      ...clone(actor),
      forms,
      runtime: {
        resources,
        customResources: Array.isArray(actor.runtime?.customResources) ? clone(actor.runtime.customResources) : [],
        attributeAdjustments: clone(actor.runtime?.attributeAdjustments || {}),
        badStatuses,
        health: normalizeHealthRuntime(actor.runtime?.health, {
          defaultMode: defaultHealthMode(activeForm?.source?.type),
          max: hpMax,
          simpleCurrent: hpCurrent,
        }),
      },
      effects: Array.isArray(actor.effects) ? clone(actor.effects) : [],
    };
  }) : [];
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
  actor.runtime.badStatuses ||= {};
  for (const status of form.badStatuses || []) {
    if (actor.runtime.badStatuses[status.id] === undefined) actor.runtime.badStatuses[status.id] = 0;
  }
  return form;
}

export { CORE_RESOURCE_DEFS, BAD_STATUS_DEFS };
