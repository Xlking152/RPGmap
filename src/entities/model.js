import { normalizeElevationFt, normalizeTokenDiameterMeters } from '../elevation/model.js';
import { normalizeEntityStatusState, STATUS_SCHEMA_VERSION } from '../status/model.js';
import { getActiveRuleset } from '../ruleset/index.js';
import { normalizeCharacterCard } from './schema.js';

// Compatibility exports for code that still imports these names from entities.
// New code should query getActiveRuleset().actor instead.
const CORE_RESOURCE_DEFS = Object.freeze(getActiveRuleset().actor.resourceDefinitions.map(def => ({ ...def })));
const BAD_STATUS_DEFS = Object.freeze(getActiveRuleset().actor.badStatusDefinitions.map(def => ({ ...def })));

function activeResourceDefs() {
  return getActiveRuleset().actor.resourceDefinitions;
}

function activeBadStatusDefs() {
  return getActiveRuleset().actor.badStatusDefinitions;
}

function defaultHealthMode(sourceType) {
  return getActiveRuleset().health.defaultModeForSource(sourceType);
}

function healthRules() {
  return getActiveRuleset().health;
}

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
  return activeBadStatusDefs().map(def => ({ id: def.id, name: def.name, light: 0, severe: 0, destruction: 0 }));
}

function migrateBadStatuses(form) {
  if (Array.isArray(form?.badStatuses) && form.badStatuses.length) return clone(form.badStatuses);
  const legacySaves = Array.isArray(form?.checks?.saves) ? form.checks.saves : [];
  const legacyThresholds = legacySaves.filter(item =>
    Number.isFinite(Number(item?.light)) && Number.isFinite(Number(item?.severe)) && Number.isFinite(Number(item?.devastating))
  );
  if (!legacyThresholds.length) return emptyBadStatuses();
  return activeBadStatusDefs().map(def => {
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
  return { schemaVersion: STATUS_SCHEMA_VERSION, statusDefinitions: [], actors: [], tokens: [] };
}

export function createFormFromImport(imported, { id = uid('form'), name } = {}) {
  const normalized = normalizeCharacterCard(imported);
  const resourceBases = {};
  for (const def of activeResourceDefs()) {
    resourceBases[def.id] = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      baseMax: Math.max(0, finite(normalized.resources?.[def.id]?.max ?? normalized.resources?.[def.id], 0)),
    };
  }
  return {
    id,
    name: text(name ?? normalized.formName, '默认形态'),
    avatarDataUrl: normalized.avatarDataUrl || null,
    identity: clone(normalized.identity),
    description: clone(normalized.description),
    resourceBases,
    attributes: clone(normalized.attributes),
    checks: {
      skills: clone(normalized.checks.skills || []),
      saves: clone(normalized.checks.saves || []),
    },
    badStatuses: normalized.badStatuses.length ? clone(normalized.badStatuses) : emptyBadStatuses(),
    combat: clone(normalized.combat),
    tokenAppearance: {
      color: normalized.tokenAppearance.color || '#3d9b63',
      scale: finite(normalized.tokenAppearance.scale, 1) || 1,
    },
    source: clone(normalized.source),
  };
}

export function createActorFromImport(imported, { id = uid('actor'), formId, formName } = {}) {
  const normalized = normalizeCharacterCard(imported);
  const form = createFormFromImport(normalized, { id: formId || uid('form'), name: formName || normalized.formName });
  const resources = {};
  for (const def of activeResourceDefs()) {
    const maximum = form.resourceBases[def.id]?.baseMax || 0;
    resources[def.id] = { current: maximum, maxOverride: null, policy: 'preserve' };
  }
  const badStatuses = Object.fromEntries((form.badStatuses || []).map(status => [status.id, 0]));
  return {
    id,
    name: text(normalized.identity.name, '未命名角色'),
    currentFormId: form.id,
    forms: [form],
    runtime: {
      resources,
      customResources: [],
      attributeAdjustments: {},
      badStatuses,
      health: healthRules().createRuntime({
        mode: defaultHealthMode(normalized.source.type),
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

/** Legacy SaveV2 migration helper only. */
export function createLegacyActor(character, { actorId = uid('actor') } = {}) {
  const imported = {
    formName: '默认形态',
    identity: { name: character.name || '未命名角色' },
    avatarDataUrl: character.avatarDataUrl || null,
    resources: Object.fromEntries(activeResourceDefs().map(def => [def.id, 0])),
    attributes: [],
    checks: { skills: [], saves: [] },
    badStatuses: emptyBadStatuses(),
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: character.color || '#3d9b63', scale: 1 },
    source: { type: 'legacy-character', legacyId: character.id },
  };
  return createActorFromImport(imported, { id: actorId, formName: '默认形态' });
}

export function createTokenForActor(actorId, tokenId, overrides = {}) {
  return {
    id: String(tokenId),
    actorId: String(actorId),
    diameterMeters: normalizeTokenDiameterMeters(overrides.diameterMeters ?? overrides.size, 1),
    rotation: finite(overrides.rotation, 0),
    elevationFt: normalizeElevationFt(overrides.elevationFt, 0),
    hidden: Boolean(overrides.hidden),
    locked: Boolean(overrides.locked),
    showName: overrides.showName !== false,
    effects: Array.isArray(overrides.effects) ? clone(overrides.effects) : [],
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
        health: healthRules().normalizeRuntime(actor.runtime?.health, {
          defaultMode: defaultHealthMode(activeForm?.source?.type),
          max: hpMax,
          simpleCurrent: hpCurrent,
        }),
      },
      effects: Array.isArray(actor.effects) ? clone(actor.effects) : [],
    };
  }) : [];
  const actorIds = new Set(actors.map(actor => String(actor.id)));
  const tokens = Array.isArray(raw.tokens)
    ? raw.tokens
      .filter(token => token && actorIds.has(String(token.actorId)))
      .map(token => {
        const next = clone(token);
        next.id = String(next.id ?? next.characterId ?? '');
        delete next.characterId;
        const diameterMeters = normalizeTokenDiameterMeters(next.diameterMeters ?? next.size, 1);
        delete next.size;
        return { ...next, diameterMeters, elevationFt: normalizeElevationFt(next.elevationFt, 0) };
      })
      .filter(token => token.id)
    : [];
  const normalizedStatuses = normalizeEntityStatusState({
    schemaVersion: raw.schemaVersion,
    statusDefinitions: raw.statusDefinitions,
    actors,
    tokens,
  });
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    statusDefinitions: normalizedStatuses.statusDefinitions,
    actors: normalizedStatuses.actors,
    tokens: normalizedStatuses.tokens.map(token => {
      const next = clone(token);
      delete next.characterId;
      return next;
    }),
  };
}

/**
 * Explicit import boundary for pre-World saves. Modern runtime code must never
 * call this after WorldSystem has hydrated the canonical Actor/Token graph.
 */
export function migrateLegacyCharacters(entityState, characters = []) {
  const next = normalizeEntityState(entityState);
  const linkedIds = new Set(next.tokens.map(token => String(token.id)));
  let migrated = 0;
  for (const character of characters || []) {
    if (!character?.id || linkedIds.has(String(character.id))) continue;
    const actor = createLegacyActor(character);
    next.actors.push(actor);
    next.tokens.push(createTokenForActor(actor.id, character.id));
    linkedIds.add(String(character.id));
    migrated += 1;
  }
  return { state: next, migrated };
}

export function actorForToken(entityState, tokenId) {
  const token = entityState.tokens.find(item => String(item.id) === String(tokenId));
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
  for (const def of activeResourceDefs()) {
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
