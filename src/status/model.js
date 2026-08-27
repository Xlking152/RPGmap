import {
  HEALTH_MODE_WOUND_TRACK,
  defaultHealthMode,
  normalizeHealthRuntime,
  resolveHealth,
} from '../health/model.js';

export const STATUS_SCHEMA_VERSION = 3;
export const MAX_STACKS = 99;

const STATUS_SCOPES = new Set(['actor', 'token']);
const STATUS_CATEGORIES = new Set(['buff', 'debuff', 'trait', 'status']);
const STATUS_CHANGE_MODES = new Set(['add', 'set', 'multiply', 'min', 'max']);
const BOOLEAN_CAPABILITIES = Object.freeze(['canMove', 'canInteract', 'canActInCombat']);
const BUILTIN_IDS = new Set(['status-spirit', 'status-rooted', 'status-incapacitated']);
export const STATUS_ICON_NAMES = new Set([
  'activity', 'anchor', 'ban', 'bomb', 'building', 'building-2', 'circle-alert',
  'circle-dot', 'circle-slash', 'door-closed', 'droplet', 'eye', 'eye-off',
  'flame', 'footprints', 'ghost', 'heart-pulse', 'lock', 'lock-keyhole', 'moon',
  'shield', 'shield-alert', 'skull', 'snowflake', 'sparkles', 'swords',
  'star', 'triangle-alert', 'unlock', 'unlock-keyhole', 'waves',
]);
const MAX_DEFINITIONS = 128;
const MAX_EFFECTS_PER_TARGET = 64;
const MAX_BATCH_OPERATIONS = 64;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const BUILTIN_STATUS_DEFINITIONS = deepFreeze([
  {
    id: 'status-spirit', name: '灵体', label: '灵体',
    description: '可穿越结构类碰撞，但不会绕过地图边界或其他未声明的阻挡。',
    icon: 'ghost', color: '#6f57a5', category: 'trait', scopes: ['actor', 'token'], maxStacks: 1,
    changes: [], capabilities: { collisionBypassGroups: ['structure'] }, builtIn: true,
  },
  {
    id: 'status-rooted', name: '定身', label: '定身',
    description: '无法移动，但仍可进行交互与战斗行动。',
    icon: 'anchor', color: '#b96c24', category: 'debuff', scopes: ['actor', 'token'], maxStacks: 1,
    changes: [], capabilities: { canMove: false }, builtIn: true,
  },
  {
    id: 'status-incapacitated', name: '失能', label: '失能',
    description: '无法移动、交互或进行战斗行动。',
    icon: 'circle-slash', color: '#a83f3f', category: 'debuff', scopes: ['actor', 'token'], maxStacks: 1,
    changes: [], capabilities: { canMove: false, canInteract: false, canActInCombat: false }, builtIn: true,
  },
]);
const BUILTIN_BY_ID = new Map(BUILTIN_STATUS_DEFINITIONS.map(definition => [definition.id, definition]));

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function finite(value, fallback = 0) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function integer(value, fallback = 1, minimum = 1, maximum = MAX_STACKS) {
  return Math.max(minimum, Math.min(maximum, Math.floor(finite(value, fallback))));
}
function cleanText(value, fallback = '', maximum = 4_000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : fallback;
}
function safeColor(value, fallback = '#64748b') {
  const color = cleanText(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}
function safeIcon(value, fallback = 'circle-dot') {
  const icon = cleanText(value).toLowerCase();
  return STATUS_ICON_NAMES.has(icon) ? icon : fallback;
}
function normalizeScopes(value, fallback = ['actor']) {
  const source = Array.isArray(value) ? value : value ? [value] : fallback;
  return [...new Set(source.map(String).filter(scope => STATUS_SCOPES.has(scope)))];
}
function normalizeChanges(value, { token = false } = {}) {
  if (token || !Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(change => {
    if (!plainObject(change)) return [];
    const target = cleanText(change.target, '', 240);
    const mode = STATUS_CHANGE_MODES.has(String(change.mode || 'add')) ? String(change.mode || 'add') : 'add';
    const amount = Number(change.value);
    return target && Number.isFinite(amount) ? [{ target, mode, value: amount }] : [];
  });
}
function normalizeCapabilities(value) {
  const source = plainObject(value) ? value : {};
  const capabilities = {};
  for (const key of BOOLEAN_CAPABILITIES) if (typeof source[key] === 'boolean') capabilities[key] = source[key];
  if (Array.isArray(source.collisionBypassGroups) && source.collisionBypassGroups.includes('structure')) capabilities.collisionBypassGroups = ['structure'];
  return capabilities;
}

export function normalizeStatusDefinition(value, { fallbackScopes = ['actor'], tokenOnly = false } = {}) {
  if (!plainObject(value)) return null;
  const id = cleanText(value.id || value.definitionId, '', 160);
  if (!id || BUILTIN_IDS.has(id)) return null;
  const scopes = normalizeScopes(value.scopes ?? value.allowedScopes ?? value.scope, fallbackScopes);
  if (!scopes.length) return null;
  const changes = normalizeChanges(value.changes, { token: tokenOnly || scopes.every(scope => scope === 'token') });
  const requestedMax = integer(value.maxStacks, 1);
  const maxStacks = requestedMax > 1 && changes.some(change => change.mode !== 'add') ? 1 : requestedMax;
  const categoryValue = String(value.category || 'status');
  return {
    id,
    name: cleanText(value.name || value.label, id, 120),
    description: cleanText(value.description),
    icon: safeIcon(value.icon),
    color: safeColor(value.color),
    category: STATUS_CATEGORIES.has(categoryValue) ? categoryValue : 'status',
    scopes,
    maxStacks,
    changes,
    capabilities: normalizeCapabilities(value.capabilities),
    builtIn: false,
  };
}

function definitionView(definition) {
  return { ...clone(definition), label: cleanText(definition?.label || definition?.name, definition?.id || ''), builtIn: Boolean(definition?.builtIn) };
}

export function getStatusDefinitions(entityState) {
  const custom = Array.isArray(entityState?.statusDefinitions)
    ? entityState.statusDefinitions.map(definition => normalizeStatusDefinition(definition)).filter(Boolean)
    : [];
  const seen = new Set(BUILTIN_STATUS_DEFINITIONS.map(definition => definition.id));
  return [
    ...BUILTIN_STATUS_DEFINITIONS.map(definitionView),
    ...custom.filter(definition => {
      if (seen.has(definition.id)) return false;
      seen.add(definition.id);
      return true;
    }).map(definitionView),
  ];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}
function stableStringify(value) { return JSON.stringify(stableValue(value)); }
function stableHash(value) {
  const source = typeof value === 'string' ? value : stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) { hash ^= source.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function idSlug(value) {
  return cleanText(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'legacy';
}

// Schema-v2 inline effects are a persisted status-format migration only. Runtime
// identity is already canonical Actor/Token before this normalizer is called.
function legacyDefinition(effect, scope, forcedId = '') {
  const name = cleanText(effect?.name || effect?.label, '旧版效果');
  const changes = normalizeChanges(effect?.changes, { token: scope === 'token' });
  const capabilities = normalizeCapabilities(effect?.capabilities);
  const maxStacks = changes.every(change => change.mode === 'add') ? integer(effect?.maxStacks, 1) : 1;
  const semantic = {
    name, description: cleanText(effect?.description), icon: safeIcon(effect?.icon), color: safeColor(effect?.color),
    category: STATUS_CATEGORIES.has(String(effect?.category)) ? String(effect.category) : 'status',
    scopes: [scope], maxStacks, changes, capabilities,
  };
  const supplied = cleanText(forcedId);
  const id = supplied && !BUILTIN_IDS.has(supplied) ? supplied : `status-legacy-${idSlug(name)}-${stableHash(semantic)}`;
  return { id, ...semantic, builtIn: false };
}

function ensureUniqueInstanceId(candidate, targetId, definitionId, index, usedIds) {
  const base = cleanText(candidate) || `effect-${stableHash({ targetId: String(targetId || ''), definitionId, index })}`;
  let id = base; let suffix = 2;
  while (usedIds.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  usedIds.add(id);
  return id;
}
function normalizeInstance(effect, { definition, scope, targetId, index, usedIds }) {
  const instance = {
    id: ensureUniqueInstanceId(effect?.id, targetId, definition.id, index, usedIds),
    definitionId: definition.id,
    stacks: integer(effect?.stacks, 1, 1, Number(definition.maxStacks) || 1),
    enabled: effect?.enabled !== false,
    note: cleanText(effect?.note),
  };
  if (plainObject(effect?.source)) instance.source = clone(effect.source);
  if (cleanText(effect?.createdAt)) instance.createdAt = cleanText(effect.createdAt);
  if (scope === 'actor' && definition.changes?.length) instance.changes = clone(definition.changes);
  return instance;
}

export function normalizeEntityStatusState(raw) {
  const source = plainObject(raw) ? raw : {};
  const definitions = [];
  const definitionsById = new Map(BUILTIN_BY_ID);
  for (const candidate of (Array.isArray(source.statusDefinitions) ? source.statusDefinitions : []).slice(0, MAX_DEFINITIONS)) {
    const definition = normalizeStatusDefinition(candidate);
    if (!definition || definitionsById.has(definition.id)) continue;
    definitions.push(definition);
    definitionsById.set(definition.id, definition);
  }
  let migratedEffects = 0;
  const normalizeTargets = (targets, scope) => (Array.isArray(targets) ? targets : []).filter(Boolean).flatMap(target => {
    const targetId = cleanText(String(target?.id ?? ''), '', 160);
    if (!targetId) return [];
    const usedIds = new Set();
    const byDefinition = new Map();
    const effects = [];
    for (const [index, effect] of (Array.isArray(target.effects) ? target.effects.filter(Boolean).slice(0, MAX_EFFECTS_PER_TARGET) : []).entries()) {
      let definitionId = cleanText(effect?.definitionId || effect?.statusId);
      let definition = definitionId ? definitionsById.get(definitionId) : null;
      const inlineLegacy = !definitionId;
      if (!definition) {
        definition = legacyDefinition(effect, scope, definitionId);
        definitionId = definition.id;
        const existing = definitionsById.get(definitionId);
        if (existing) definition = existing;
        else { definitions.push(definition); definitionsById.set(definition.id, definition); }
        migratedEffects += 1;
      }
      if (!definition.scopes?.includes(scope)) {
        if (!definition.builtIn && (scope !== 'token' || !(definition.changes || []).length)) {
          definition.scopes = [...new Set([...(definition.scopes || []), scope])];
        } else {
          const scoped = legacyDefinition(effect, scope);
          definition = definitionsById.get(scoped.id) || scoped;
          if (!definitionsById.has(scoped.id)) { definitions.push(scoped); definitionsById.set(scoped.id, scoped); }
          definitionId = definition.id;
          migratedEffects += 1;
        }
      }
      if (scope === 'token' && (definition.changes || []).length) continue;
      const normalized = normalizeInstance(effect, { definition, scope, targetId, index, usedIds });
      const duplicate = byDefinition.get(definitionId);
      if (duplicate) {
        duplicate.stacks = Math.min(Number(definition.maxStacks) || 1, duplicate.stacks + normalized.stacks);
        duplicate.enabled = duplicate.enabled || normalized.enabled;
        if (!duplicate.note && normalized.note) duplicate.note = normalized.note;
      } else {
        byDefinition.set(definitionId, normalized);
        effects.push(normalized);
      }
      if (inlineLegacy) migratedEffects += 1;
    }
    return [{ ...clone(target), id: targetId, effects }];
  });
  return {
    ...clone(source),
    schemaVersion: STATUS_SCHEMA_VERSION,
    statusDefinitions: definitions.map(clone),
    actors: normalizeTargets(source.actors, 'actor'),
    tokens: normalizeTargets(source.tokens, 'token'),
    migratedEffects,
  };
}

function targetContext(entityState, context = {}) {
  const actors = Array.isArray(entityState?.actors) ? entityState.actors : [];
  const tokens = Array.isArray(entityState?.tokens) ? entityState.tokens : [];
  const tokenId = context?.tokenId ?? context?.token?.id ?? null;
  const token = context?.token || (tokenId == null ? null : tokens.find(item => String(item?.id) === String(tokenId))) || null;
  const actorId = context?.actorId ?? context?.actor?.id ?? token?.actorId ?? null;
  const actor = context?.actor || (actorId == null ? null : actors.find(item => String(item?.id) === String(actorId))) || null;
  return { actor, token };
}
function resolvedInstance(instance, definition, scope, targetId) {
  return {
    ...definitionView(definition), ...clone(instance), definitionId: definition.id, label: definition.name,
    scope, targetId: String(targetId), stacks: integer(instance?.stacks, 1, 1, Number(definition.maxStacks) || 1),
    enabled: instance?.enabled !== false, derived: false, readOnly: false,
  };
}
function resolveTargetEffects(target, scope, definitionsById) {
  if (!target) return [];
  return (Array.isArray(target.effects) ? target.effects : []).flatMap(instance => {
    if (!instance) return [];
    const definition = definitionsById.get(String(instance.definitionId || instance.statusId || ''));
    if (!definition || !definition.scopes?.includes(scope)) return [];
    return [resolvedInstance(instance, definition, scope, target.id)];
  });
}

function applyChange(current, change, stacks) {
  const amount = finite(change?.value);
  if (change?.mode === 'set') return amount;
  if (change?.mode === 'multiply') return current * amount;
  if (change?.mode === 'min') return Math.min(current, amount);
  if (change?.mode === 'max') return Math.max(current, amount);
  return current + amount * stacks;
}
function resolveActorHealthForStatuses(actor, actorStatuses) {
  if (!actor) return null;
  const forms = Array.isArray(actor.forms) ? actor.forms : [];
  const form = forms.find(item => String(item?.id) === String(actor.currentFormId)) || forms[0] || null;
  const hpBase = form?.resourceBases?.hp;
  const hpRuntime = actor.runtime?.resources?.hp;
  const healthRuntime = actor.runtime?.health;
  if (!hpBase && !hpRuntime && !healthRuntime) return null;
  let max = Math.max(0, finite(hpRuntime?.maxOverride ?? hpBase?.baseMax));
  let current = finite(hpRuntime?.current, max);
  for (const status of actorStatuses.filter(item => item?.enabled !== false)) {
    for (const change of status.changes || []) {
      if (change.target === 'resources.hp.max') max = applyChange(max, change, status.stacks);
      if (change.target === 'resources.hp.current') current = applyChange(current, change, status.stacks);
    }
  }
  max = Math.max(0, max);
  const runtime = normalizeHealthRuntime(healthRuntime, { defaultMode: defaultHealthMode(form?.source?.type), max, simpleCurrent: current });
  return resolveHealth(runtime, { max, simpleCurrent: current });
}
function derivedStatus(definitionId, label, stacks, options = {}) {
  return {
    id: `${definitionId}:derived`, definitionId, name: label, label,
    description: options.description || '', icon: options.icon || '', color: options.color || '#64748b',
    category: 'derived', scope: 'derived', targetId: options.targetId == null ? null : String(options.targetId),
    stacks: integer(stacks, 1), maxStacks: MAX_STACKS, enabled: true, derived: true, readOnly: true, readonly: true,
    capabilities: normalizeCapabilities(options.capabilities), changes: [], builtIn: true,
  };
}
function deriveBadStatusThresholds(actor) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  const form = forms.find(item => String(item?.id) === String(actor?.currentFormId)) || forms[0] || null;
  const currentById = actor?.runtime?.badStatuses || {};
  const targetId = actor?.id;
  return (Array.isArray(form?.badStatuses) ? form.badStatuses : []).flatMap(status => {
    const current = Math.max(0, finite(currentById?.[status?.id]));
    const thresholds = [
      { key: 'destruction', label: '毁灭', icon: 'skull', color: '#8f3333' },
      { key: 'severe', label: '重度', icon: 'triangle-alert', color: '#b35e2e' },
      { key: 'light', label: '轻度', icon: 'circle-alert', color: '#a47a22' },
    ];
    const level = thresholds.find(entry => finite(status?.[entry.key]) > 0 && current >= finite(status?.[entry.key]));
    if (!level) return [];
    const statusId = String(status?.id || 'unknown');
    const name = cleanText(status?.name, '不良状态');
    return [derivedStatus(`derived-bad-${statusId}-${level.key}`, `${name} · ${level.label}`, current || 1, {
      targetId, icon: level.icon, color: level.color, description: `当前 ${current} 点，已达到${level.label}阈值。`,
    })];
  });
}
export function deriveActorStatuses(actor, actorStatuses = []) {
  const health = resolveActorHealthForStatuses(actor, actorStatuses);
  const badStatusThresholds = deriveBadStatusThresholds(actor);
  if (!health) return badStatusThresholds;
  const targetId = actor?.id;
  const disabled = { canMove: false, canInteract: false, canActInCombat: false };
  const statuses = [];
  if (health.dead) statuses.push(derivedStatus('derived-dead', '死亡', 1, { targetId, icon: 'skull', color: '#762d2d', description: '生命状态自动派生，不可手动移除。', capabilities: disabled }));
  else if (health.unconscious) statuses.push(derivedStatus('derived-unconscious', '昏迷', 1, { targetId, icon: 'moon', color: '#495c78', description: '生命状态自动派生，不可手动移除。', capabilities: disabled }));
  if (health.mode === HEALTH_MODE_WOUND_TRACK) {
    if (health.bashing > 0) statuses.push(derivedStatus('derived-wound-b', 'B 伤势', health.bashing, { targetId, icon: 'B', color: '#6d7780' }));
    if (health.lethal > 0) statuses.push(derivedStatus('derived-wound-l', 'L 伤势', health.lethal, { targetId, icon: 'L', color: '#a05a32' }));
    if (health.aggravated > 0) statuses.push(derivedStatus('derived-wound-a', 'A 伤势', health.aggravated, { targetId, icon: 'A', color: '#8f3333' }));
  }
  return [...statuses, ...badStatusThresholds];
}

export function resolveStatusCapabilities(statuses = []) {
  const enabled = statuses.filter(status => status && status.enabled !== false);
  const capabilities = { canMove: true, canInteract: true, canActInCombat: true, collisionBypassGroups: [], reasons: [] };
  for (const key of BOOLEAN_CAPABILITIES) {
    if (enabled.some(status => status.capabilities?.[key] === false)) capabilities[key] = false;
    else if (enabled.some(status => status.capabilities?.[key] === true)) capabilities[key] = true;
  }
  const bypass = new Set();
  for (const status of enabled) {
    if (BOOLEAN_CAPABILITIES.some(key => status.capabilities?.[key] === false)) {
      const reason = cleanText(status.label || status.name || status.definitionId, '状态限制');
      if (reason && !capabilities.reasons.includes(reason)) capabilities.reasons.push(reason);
    }
    for (const group of status.capabilities?.collisionBypassGroups || []) if (group === 'structure') bypass.add(group);
  }
  capabilities.collisionBypassGroups = [...bypass];
  return capabilities;
}

export function resolveStatuses(rawEntityState, context = {}) {
  const entityState = normalizeEntityStatusState(rawEntityState);
  const definitions = getStatusDefinitions(entityState);
  const definitionsById = new Map(definitions.map(definition => [definition.id, definition]));
  const { actor, token } = targetContext(entityState, context);
  const actorStatuses = resolveTargetEffects(actor, 'actor', definitionsById);
  const tokenStatuses = resolveTargetEffects(token, 'token', definitionsById);
  const derivedStatuses = deriveActorStatuses(actor, actorStatuses);
  const statuses = [...actorStatuses, ...tokenStatuses, ...derivedStatuses].filter(status => status?.enabled !== false);
  const statusVersion = stableHash({
    definitions: definitions.map(definition => ({ id: definition.id, capabilities: definition.capabilities, changes: definition.changes, maxStacks: definition.maxStacks })),
    actorId: actor?.id || null, actorEffects: actor?.effects || [], tokenId: token?.id || null, tokenEffects: token?.effects || [],
    health: actor?.runtime?.health || null, hp: actor?.runtime?.resources?.hp || null,
    badStatuses: actor?.runtime?.badStatuses || null, currentFormId: actor?.currentFormId || null,
  });
  return { statuses, actorStatuses, tokenStatuses, derivedStatuses, capabilities: resolveStatusCapabilities(statuses), statusVersion };
}

function statusError(message, code = 'invalid_status') { const error = new Error(message); error.code = code; return error; }
function requiredId(value, label) { const result = cleanText(value); if (!result) throw statusError(`${label} is required`); return result; }
function strictDefinition(value) {
  if (!plainObject(value)) throw statusError('definition must be an object');
  const id = requiredId(value.id, 'definition.id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw statusError('definition.id contains unsupported characters', 'invalid_status_id');
  if (BUILTIN_IDS.has(id)) throw statusError('Built-in status definitions are read-only', 'status_builtin_readonly');
  if (!cleanText(value.name || value.label)) throw statusError('definition.name is required');
  if (value.icon !== undefined && !STATUS_ICON_NAMES.has(cleanText(value.icon).toLowerCase())) throw statusError('definition.icon is not an allowed Lucide icon', 'status_icon_invalid');
  const rawScopes = normalizeScopes(value.scopes ?? value.scope, []);
  if (!rawScopes.length) throw statusError('definition.scopes must include actor or token');
  const rawChanges = Array.isArray(value.changes) ? value.changes : [];
  if (rawChanges.some(change => !plainObject(change) || !cleanText(change.target) || !STATUS_CHANGE_MODES.has(String(change.mode || 'add')) || !Number.isFinite(Number(change.value)))) throw statusError('definition.changes contains an invalid change');
  if (rawScopes.includes('token') && rawChanges.length) throw statusError('Definitions usable by Token cannot modify Actor numeric values', 'status_scope_forbidden');
  const requestedMax = integer(value.maxStacks, 1);
  if (requestedMax > 1 && rawChanges.some(change => String(change.mode || 'add') !== 'add')) throw statusError('Stacking definitions may only use additive changes', 'status_stacking_invalid');
  const allowedCapabilityKeys = new Set([...BOOLEAN_CAPABILITIES, 'collisionBypassGroups']);
  if (plainObject(value.capabilities)) {
    for (const key of Object.keys(value.capabilities)) if (!allowedCapabilityKeys.has(key)) throw statusError(`definition.capabilities.${key} is not allowed`);
    for (const key of BOOLEAN_CAPABILITIES) if (value.capabilities[key] !== undefined && typeof value.capabilities[key] !== 'boolean') throw statusError(`definition.capabilities.${key} must be boolean`);
    const bypass = value.capabilities.collisionBypassGroups;
    if (bypass !== undefined && (!Array.isArray(bypass) || bypass.some(group => group !== 'structure'))) throw statusError('collisionBypassGroups may only contain structure');
  }
  return normalizeStatusDefinition({ ...value, id, scopes: rawScopes });
}
function targetForOperation(entityState, message) {
  const target = plainObject(message?.target) ? message.target : message;
  const scope = String(target?.scope || '');
  if (!STATUS_SCOPES.has(scope)) throw statusError('status scope must be actor or token');
  const targetId = requiredId(target?.targetId ?? target?.id, 'targetId');
  const collection = scope === 'actor' ? entityState.actors : entityState.tokens;
  const entry = collection.find(item => String(item?.id) === targetId);
  if (!entry) throw statusError(`${scope} target does not exist: ${targetId}`, 'status_target_not_found');
  entry.effects ||= [];
  return { scope, targetId: String(entry.id), target: entry };
}
function reducerId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `effect-${random}`;
}
function applySingleOperation(entityState, message, context) {
  const type = String(message?.type || '');
  if (type === 'status.definition.upsert') {
    const definition = strictDefinition(message.definition);
    const index = entityState.statusDefinitions.findIndex(item => String(item?.id) === definition.id);
    if (index < 0) {
      if (entityState.statusDefinitions.length >= MAX_DEFINITIONS) throw statusError('Too many status definitions', 'status_limit');
      entityState.statusDefinitions.push(definition);
    } else {
      const inUse = [...entityState.actors, ...entityState.tokens].flatMap(target => target.effects || []).filter(effect => String(effect.definitionId) === definition.id);
      const usedByToken = entityState.tokens.some(token => (token.effects || []).some(effect => String(effect.definitionId) === definition.id));
      if (usedByToken && definition.changes.length) throw statusError('Token statuses cannot gain Actor numeric changes', 'status_scope_forbidden');
      if (Math.max(1, ...inUse.map(effect => Number(effect.stacks) || 1)) > definition.maxStacks) throw statusError('maxStacks is lower than an applied stack count', 'status_definition_in_use');
      entityState.statusDefinitions[index] = definition;
      for (const actor of entityState.actors) for (const effect of actor.effects || []) if (String(effect.definitionId) === definition.id) {
        if (definition.changes.length) effect.changes = clone(definition.changes); else delete effect.changes;
      }
    }
    return { action: 'definition.upsert', definitionId: definition.id };
  }
  if (type === 'status.definition.delete') {
    const definitionId = requiredId(message.definitionId ?? message.statusId, 'definitionId');
    if (BUILTIN_IDS.has(definitionId)) throw statusError('Built-in status definitions are read-only', 'status_builtin_readonly');
    const index = entityState.statusDefinitions.findIndex(item => String(item?.id) === definitionId);
    if (index < 0) throw statusError(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
    const referenced = [...entityState.actors, ...entityState.tokens].some(target => (target.effects || []).some(effect => String(effect.definitionId) === definitionId));
    if (referenced) throw statusError('Status definition is still in use', 'status_definition_in_use');
    entityState.statusDefinitions.splice(index, 1);
    return { action: 'definition.delete', definitionId };
  }
  const { scope, targetId, target } = targetForOperation(entityState, message);
  const definitionId = requiredId(message.statusId ?? message.definitionId, 'statusId');
  const definition = new Map(getStatusDefinitions(entityState).map(item => [item.id, item])).get(definitionId);
  if (!definition) throw statusError(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
  if (!definition.scopes.includes(scope)) throw statusError(`Status cannot be applied to ${scope}`, 'status_scope_forbidden');
  if (scope === 'token' && definition.changes.length) throw statusError('Token statuses cannot modify Actor numeric values', 'status_scope_forbidden');
  const index = target.effects.findIndex(effect => String(effect?.definitionId) === definitionId);
  if (type === 'status.apply') {
    const amount = integer(message.stacks, 1);
    if (index >= 0) {
      target.effects[index].stacks = Math.min(definition.maxStacks, (Number(target.effects[index].stacks) || 1) + amount);
      target.effects[index].enabled = true;
      if (message.note !== undefined) target.effects[index].note = cleanText(message.note);
    } else {
      if (target.effects.length >= MAX_EFFECTS_PER_TARGET) throw statusError('Target has too many statuses', 'status_limit');
      const instance = {
        id: cleanText(message.instanceId) || (context.idFactory?.() || reducerId()), definitionId,
        stacks: Math.min(definition.maxStacks, amount), enabled: true, note: cleanText(message.note),
        source: plainObject(message.source) ? clone(message.source) : clone(context.source || { role: 'offline' }),
        createdAt: cleanText(context.now) || new Date().toISOString(),
      };
      if (scope === 'actor' && definition.changes.length) instance.changes = clone(definition.changes);
      target.effects.push(instance);
    }
    return { action: 'apply', scope, targetId, definitionId };
  }
  if (type === 'status.remove') { if (index >= 0) target.effects.splice(index, 1); return { action: 'remove', scope, targetId, definitionId }; }
  if (type === 'status.setStacks') {
    if (index < 0) throw statusError('Status is not applied to this target', 'status_not_applied');
    target.effects[index].stacks = integer(message.stacks, 1, 1, definition.maxStacks);
    if (message.enabled !== undefined) { if (typeof message.enabled !== 'boolean') throw statusError('enabled must be boolean'); target.effects[index].enabled = message.enabled; }
    if (message.note !== undefined) target.effects[index].note = cleanText(message.note);
    return { action: 'setStacks', scope, targetId, definitionId };
  }
  throw statusError(`Unsupported status operation: ${type}`, 'unknown_message');
}

export function reduceStatusOperation(rawEntityState, message, context = {}) {
  const state = normalizeEntityStatusState(rawEntityState);
  let results;
  if (message?.type === 'status.batch') {
    if (!Array.isArray(message.operations) || !message.operations.length) throw statusError('status.batch.operations cannot be empty');
    if (message.operations.length > MAX_BATCH_OPERATIONS) throw statusError('status.batch.operations exceeds maximum length', 'status_limit');
    results = message.operations.map(operation => {
      if (!['status.apply', 'status.remove', 'status.setStacks'].includes(String(operation?.type))) throw statusError('status.batch only accepts apply/remove/setStacks operations');
      return applySingleOperation(state, operation, context);
    });
  } else results = [applySingleOperation(state, message, context)];
  delete state.migratedEffects;
  return { state, results };
}

export function statusStateFingerprint(rawEntityState) {
  const state = normalizeEntityStatusState(rawEntityState);
  return stableHash({
    definitions: state.statusDefinitions,
    actors: state.actors.map(actor => ({ id: actor.id, effects: actor.effects, currentFormId: actor.currentFormId, health: actor.runtime?.health || null, hp: actor.runtime?.resources?.hp || null })),
    tokens: state.tokens.map(token => ({ id: token.id, actorId: token.actorId, actorLink: token.actorLink !== false, actorDelta: token.actorDelta || null, effects: token.effects })),
  });
}

export { BUILTIN_IDS as BUILTIN_STATUS_IDS };
