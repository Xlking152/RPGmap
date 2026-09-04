import { getCompatibilityRuleset } from '../ruleset/active-compat.js';

export const STATUS_SCHEMA_VERSION = 4;
export const MAX_STACKS = 99;

const STATUS_SCOPES = new Set(['actor', 'token']);
const STATUS_TARGET_SCOPES = new Set(['actor', 'token', 'syntheticActor']);
const STATUS_CATEGORIES = new Set(['buff', 'debuff', 'neutral']);
const STATUS_CHANGE_MODES = new Set(['add', 'set', 'multiply', 'min', 'max']);
const BOOLEAN_CAPABILITIES = Object.freeze(['canMove', 'canInteract', 'canActInCombat']);
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
  if (source.visibility === 'invisible') capabilities.visibility = 'invisible';
  if (source.visionPrecision === 'vague') capabilities.visionPrecision = 'vague';
  if (Array.isArray(source.collisionBypassGroups) && source.collisionBypassGroups.includes('structure')) capabilities.collisionBypassGroups = ['structure'];
  return capabilities;
}

function normalizeDurationDefinition(value) {
  if (value == null) return null;
  if (!plainObject(value) || !['turns', 'rounds'].includes(String(value.unit))) return null;
  const amount = Math.floor(Number(value.value));
  return Number.isInteger(amount) && amount > 0 && amount <= 10_000
    ? { unit: String(value.unit), value: amount }
    : null;
}

function normalizeInstanceDuration(value, fallback = null) {
  const source = plainObject(value) ? value : null;
  const unit = String(source?.unit || fallback?.unit || '');
  if (!['turns', 'rounds'].includes(unit)) return null;
  const initial = Math.floor(Number(source?.initial ?? fallback?.value));
  const remaining = Math.floor(Number(source?.remaining ?? initial));
  if (!Number.isInteger(initial) || initial <= 0 || initial > 10_000) return null;
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > initial) return null;
  return { unit, initial, remaining };
}

export function normalizeStatusDefinition(value, { fallbackScopes = ['actor'], tokenOnly = false } = {}) {
  if (!plainObject(value)) return null;
  const id = cleanText(value.id || value.definitionId, '', 160);
  if (!id) return null;
  const scopes = normalizeScopes(value.scopes ?? value.allowedScopes ?? value.scope, fallbackScopes);
  if (!scopes.length) return null;
  const changes = normalizeChanges(value.changes, { token: tokenOnly || scopes.every(scope => scope === 'token') });
  const requestedMax = integer(value.maxStacks, 1);
  const maxStacks = requestedMax > 1 && changes.some(change => change.mode !== 'add') ? 1 : requestedMax;
  const requestedCategory = String(value.category || 'neutral');
  const categoryValue = ['trait', 'status'].includes(requestedCategory) ? 'neutral' : requestedCategory;
  return {
    ...clone(value),
    id,
    name: cleanText(value.name || value.label, id, 120),
    description: cleanText(value.description),
    icon: safeIcon(value.icon),
    color: safeColor(value.color),
    category: STATUS_CATEGORIES.has(categoryValue) ? categoryValue : 'neutral',
    scopes,
    maxStacks,
    changes,
    capabilities: normalizeCapabilities(value.capabilities),
    defaultDuration: normalizeDurationDefinition(value.defaultDuration),
    builtIn: value.builtIn === true,
  };
}

function definitionView(definition) {
  return { ...clone(definition), label: cleanText(definition?.label || definition?.name, definition?.id || ''), builtIn: Boolean(definition?.builtIn) };
}

export function getStatusDefinitions(entityState) {
  const definitions = Array.isArray(entityState?.statusDefinitions)
    ? entityState.statusDefinitions.map(definition => normalizeStatusDefinition(definition)).filter(Boolean)
    : [];
  const seen = new Set();
  return definitions.filter(definition => {
    if (seen.has(definition.id)) return false;
    seen.add(definition.id);
    return true;
  }).map(definitionView);
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
    category: ['buff', 'debuff'].includes(String(effect?.category)) ? String(effect.category) : 'neutral',
    scopes: [scope], maxStacks, changes, capabilities,
  };
  const supplied = cleanText(forcedId);
  const id = supplied || `status-legacy-${idSlug(name)}-${stableHash(semantic)}`;
  return { id, ...semantic, defaultDuration: null, builtIn: false };
}

function ensureUniqueInstanceId(candidate, targetId, definitionId, index, usedIds) {
  const base = cleanText(candidate) || `effect-${stableHash({ targetId: String(targetId || ''), definitionId, index })}`;
  let id = base; let suffix = 2;
  while (usedIds.has(id)) { id = `${base}-${suffix}`; suffix += 1; }
  usedIds.add(id);
  return id;
}
function normalizeInstance(effect, { definition, targetId, index, usedIds }) {
  const instance = {
    ...clone(effect),
    id: ensureUniqueInstanceId(effect?.id, targetId, definition.id, index, usedIds),
    definitionId: definition.id,
    stacks: integer(effect?.stacks, 1, 1, Number(definition.maxStacks) || 1),
    enabled: effect?.enabled !== false,
    note: cleanText(effect?.note),
  };
  for (const key of [
    'name', 'label', 'description', 'icon', 'color', 'category', 'scope', 'scopes',
    'maxStacks', 'capabilities', 'statusId', 'changes',
  ]) delete instance[key];
  if (plainObject(effect?.source)) instance.source = clone(effect.source);
  if (cleanText(effect?.createdAt)) instance.createdAt = cleanText(effect.createdAt);
  const duration = normalizeInstanceDuration(effect?.duration, definition.defaultDuration);
  if (duration) instance.duration = duration;
  else delete instance.duration;
  if (plainObject(effect?.expiredAt) && duration?.remaining === 0) {
    instance.expiredAt = {
      timestamp: cleanText(effect.expiredAt.timestamp, '', 80),
      round: Math.max(0, Math.floor(finite(effect.expiredAt.round, 0))),
      turn: Math.max(0, Math.floor(finite(effect.expiredAt.turn, 0))),
    };
  } else delete instance.expiredAt;
  return instance;
}

export function normalizeEntityStatusState(raw) {
  const source = plainObject(raw) ? raw : {};
  const definitions = [];
  const definitionsById = new Map();
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
      const normalized = normalizeInstance(effect, { definition, targetId, index, usedIds });
      const duplicate = byDefinition.get(definitionId);
      if (duplicate) {
        duplicate.stacks = Math.min(Number(definition.maxStacks) || 1, duplicate.stacks + normalized.stacks);
        duplicate.enabled = duplicate.enabled || normalized.enabled;
        if (!duplicate.note && normalized.note) duplicate.note = normalized.note;
      } else {
        byDefinition.set(definitionId, normalized);
        effects.push(normalized);
      }
    }
    return [{ ...clone(target), id: targetId, effects }];
  });
  const actors = normalizeTargets(source.actors, 'actor');
  const tokens = normalizeTargets(source.tokens, 'token');
  return {
    ...clone(source),
    schemaVersion: STATUS_SCHEMA_VERSION,
    statusDefinitions: definitions.map(clone),
    actors,
    tokens,
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

function definitionsMap(source) {
  const definitions = Array.isArray(source)
    ? source.map(definition => normalizeStatusDefinition(definition)).filter(Boolean).map(definitionView)
    : getStatusDefinitions(source);
  return new Map(definitions.map(definition => [definition.id, definition]));
}

export function resolveActorEffects(actor, definitionsOrState = []) {
  return resolveTargetEffects(actor, 'actor', definitionsMap(definitionsOrState));
}

export function resolveTokenEffects(token, definitionsOrState = []) {
  return resolveTargetEffects(token, 'token', definitionsMap(definitionsOrState));
}

export function deriveActorStatuses(actor, actorStatuses = [], { ruleset = getCompatibilityRuleset() } = {}) {
  const derive = ruleset?.statuses?.derive;
  return typeof derive === 'function' ? derive(actor, { statuses: actorStatuses }) : [];
}

export function resolveStatusCapabilities(statuses = []) {
  const enabled = statuses.filter(status => status && status.enabled !== false);
  const capabilities = { canMove: true, canInteract: true, canActInCombat: true, collisionBypassGroups: [], visionPrecision: 'precise', reasons: [] };
  for (const key of BOOLEAN_CAPABILITIES) {
    if (enabled.some(status => status.capabilities?.[key] === false)) capabilities[key] = false;
    else if (enabled.some(status => status.capabilities?.[key] === true)) capabilities[key] = true;
  }
  const bypass = new Set();
  if (enabled.some(status => status.capabilities?.visionPrecision === 'vague')) capabilities.visionPrecision = 'vague';
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
  const derivedStatuses = deriveActorStatuses(actor, actorStatuses, { ruleset: context.ruleset });
  const statuses = [...actorStatuses, ...tokenStatuses, ...derivedStatuses].filter(status => status?.enabled !== false);
  const statusVersion = stableHash({
    definitions: definitions.map(definition => ({ id: definition.id, capabilities: definition.capabilities, changes: definition.changes, maxStacks: definition.maxStacks })),
    actorId: actor?.id || null, actorEffects: actor?.effects || [], tokenId: token?.id || null, tokenEffects: token?.effects || [],
    system: actor?.system || null,
  });
  return { statuses, actorStatuses, tokenStatuses, derivedStatuses, capabilities: resolveStatusCapabilities(statuses), statusVersion };
}

function statusError(message, code = 'invalid_status') { const error = new Error(message); error.code = code; return error; }
function requiredId(value, label) { const result = cleanText(value); if (!result) throw statusError(`${label} is required`); return result; }
function safeChangeTarget(value) {
  const target = cleanText(value);
  if (!target || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(target)) return false;
  return !target.split('.').some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment.toLowerCase()));
}
function strictDefinition(value) {
  if (!plainObject(value)) throw statusError('definition must be an object');
  const id = requiredId(value.id, 'definition.id');
  if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(id)) throw statusError('definition.id contains unsupported characters', 'invalid_status_id');
  if (!cleanText(value.name || value.label)) throw statusError('definition.name is required');
  if (value.icon !== undefined && !STATUS_ICON_NAMES.has(cleanText(value.icon).toLowerCase())) throw statusError('definition.icon is not an allowed Lucide icon', 'status_icon_invalid');
  const rawScopes = normalizeScopes(value.scopes ?? value.scope, []);
  if (!rawScopes.length) throw statusError('definition.scopes must include actor or token');
  const rawChanges = Array.isArray(value.changes) ? value.changes : [];
  if (rawChanges.some(change => !plainObject(change) || !safeChangeTarget(change.target) || !STATUS_CHANGE_MODES.has(String(change.mode || 'add')) || !Number.isFinite(Number(change.value)))) throw statusError('definition.changes contains an invalid change');
  if (rawScopes.includes('token') && rawChanges.length) throw statusError('Definitions usable by Token cannot modify Actor numeric values', 'status_scope_forbidden');
  const requestedMax = integer(value.maxStacks, 1);
  if (requestedMax > 1 && rawChanges.some(change => String(change.mode || 'add') !== 'add')) throw statusError('Stacking definitions may only use additive changes', 'status_stacking_invalid');
  const allowedCapabilityKeys = new Set([...BOOLEAN_CAPABILITIES, 'collisionBypassGroups', 'visibility', 'visionPrecision']);
  if (plainObject(value.capabilities)) {
    for (const key of Object.keys(value.capabilities)) if (!allowedCapabilityKeys.has(key)) throw statusError(`definition.capabilities.${key} is not allowed`);
    for (const key of BOOLEAN_CAPABILITIES) if (value.capabilities[key] !== undefined && typeof value.capabilities[key] !== 'boolean') throw statusError(`definition.capabilities.${key} must be boolean`);
    if (value.capabilities.visibility !== undefined && value.capabilities.visibility !== 'invisible') throw statusError('definition.capabilities.visibility must be invisible');
    if (value.capabilities.visionPrecision !== undefined && value.capabilities.visionPrecision !== 'vague') throw statusError('definition.capabilities.visionPrecision must be vague');
    const bypass = value.capabilities.collisionBypassGroups;
    if (bypass !== undefined && (!Array.isArray(bypass) || bypass.some(group => group !== 'structure'))) throw statusError('collisionBypassGroups may only contain structure');
  }
  if (value.defaultDuration !== undefined && value.defaultDuration !== null && !normalizeDurationDefinition(value.defaultDuration)) {
    throw statusError('definition.defaultDuration must use positive turns or rounds');
  }
  return normalizeStatusDefinition({ ...value, id, scopes: rawScopes, builtIn: false });
}
function targetForOperation(entityState, message) {
  const target = plainObject(message?.target) ? message.target : message;
  const scope = String(target?.scope || '');
  if (!STATUS_TARGET_SCOPES.has(scope)) throw statusError('status scope must be actor, token, or syntheticActor');
  const targetId = requiredId(target?.targetId ?? target?.id, 'targetId');
  const collection = scope === 'actor' ? entityState.actors : entityState.tokens;
  const entry = collection.find(item => String(item?.id) === targetId);
  if (!entry) throw statusError(`${scope} target does not exist: ${targetId}`, 'status_target_not_found');
  if (scope === 'actor' && ['monster', 'npc', 'summon'].includes(String(entry.type))) {
    throw statusError('Monster, NPC, and summon statuses require a Synthetic Actor Token target', 'instance_target_required');
  }
  if (scope === 'syntheticActor') {
    if (entry.actorLink !== false) throw statusError('syntheticActor requires an unlinked Token', 'synthetic_actor_required');
    if (!plainObject(entry.actorDelta)) entry.actorDelta = {};
    if (!Array.isArray(entry.actorDelta.effects)) entry.actorDelta.effects = [];
    return { scope, targetId: String(entry.id), target: entry.actorDelta };
  }
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
    if (index >= 0 && entityState.statusDefinitions[index]?.builtIn === true) {
      throw statusError('Built-in status definitions are read-only', 'status_builtin_readonly');
    }
    if (index < 0) {
      if (entityState.statusDefinitions.length >= MAX_DEFINITIONS) throw statusError('Too many status definitions', 'status_limit');
      entityState.statusDefinitions.push(definition);
    } else {
      const inUse = [...entityState.actors, ...entityState.tokens].flatMap(target => [
        ...(target.effects || []),
        ...(target.actorDelta?.effects || []),
      ]).filter(effect => String(effect.definitionId) === definition.id);
      const usedByToken = entityState.tokens.some(token => (token.effects || []).some(effect => String(effect.definitionId) === definition.id));
      if (usedByToken && definition.changes.length) throw statusError('Token statuses cannot gain Actor numeric changes', 'status_scope_forbidden');
      if (Math.max(1, ...inUse.map(effect => Number(effect.stacks) || 1)) > definition.maxStacks) throw statusError('maxStacks is lower than an applied stack count', 'status_definition_in_use');
      entityState.statusDefinitions[index] = definition;
    }
    return { action: 'definition.upsert', definitionId: definition.id };
  }
  if (type === 'status.definition.delete') {
    const definitionId = requiredId(message.definitionId ?? message.statusId, 'definitionId');
    const index = entityState.statusDefinitions.findIndex(item => String(item?.id) === definitionId);
    if (index < 0) throw statusError(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
    if (entityState.statusDefinitions[index]?.builtIn === true) throw statusError('Built-in status definitions are read-only', 'status_builtin_readonly');
    const referenced = [...entityState.actors, ...entityState.tokens].some(target => [
      ...(target.effects || []),
      ...(target.actorDelta?.effects || []),
    ].some(effect => String(effect.definitionId) === definitionId));
    if (referenced) throw statusError('Status definition is still in use', 'status_definition_in_use');
    entityState.statusDefinitions.splice(index, 1);
    return { action: 'definition.delete', definitionId };
  }
  if (type === 'status.definition.import') {
    if (Number(message.statusSchemaVersion) !== STATUS_SCHEMA_VERSION) {
      throw statusError(`Status schema ${STATUS_SCHEMA_VERSION} is required`, 'status_schema_incompatible');
    }
    if (!Array.isArray(message.definitions) || !message.definitions.length) {
      throw statusError('definitions must be a non-empty array');
    }
    if (entityState.statusDefinitions.length + message.definitions.length > MAX_DEFINITIONS) {
      throw statusError('Too many status definitions', 'status_limit');
    }
    const imported = message.definitions.map(strictDefinition);
    const importedIds = imported.map(definition => definition.id);
    const duplicateIds = importedIds.filter((id, index) => importedIds.indexOf(id) !== index);
    const existingIds = new Set(entityState.statusDefinitions.map(definition => String(definition.id)));
    const conflicts = [...new Set([...duplicateIds, ...importedIds.filter(id => existingIds.has(id))])];
    if (conflicts.length) {
      const error = statusError(`Status definition conflicts: ${conflicts.join(', ')}`, 'status_definition_conflict');
      error.conflictIds = conflicts;
      throw error;
    }
    entityState.statusDefinitions.push(...imported);
    return { action: 'definition.import', definitionIds: importedIds };
  }
  const { scope, targetId, target } = targetForOperation(entityState, message);
  const definitionId = requiredId(message.statusId ?? message.definitionId, 'statusId');
  const definition = new Map(getStatusDefinitions(entityState).map(item => [item.id, item])).get(definitionId);
  if (!definition) throw statusError(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
  const definitionScope = scope === 'syntheticActor' ? 'actor' : scope;
  if (!definition.scopes.includes(definitionScope)) throw statusError(`Status cannot be applied to ${scope}`, 'status_scope_forbidden');
  if (scope === 'token' && definition.changes.length) throw statusError('Token statuses cannot modify Actor numeric values', 'status_scope_forbidden');
  const index = target.effects.findIndex(effect => String(effect?.definitionId) === definitionId);
  if (type === 'status.apply') {
    const amount = integer(message.stacks, 1);
    if (index >= 0) {
      target.effects[index].stacks = Math.min(definition.maxStacks, (Number(target.effects[index].stacks) || 1) + amount);
      target.effects[index].enabled = true;
      if (target.effects[index].expiredAt) {
        const reset = normalizeInstanceDuration(message.duration, definition.defaultDuration);
        if (reset) target.effects[index].duration = reset;
        delete target.effects[index].expiredAt;
      }
      if (message.note !== undefined) target.effects[index].note = cleanText(message.note);
    } else {
      if (target.effects.length >= MAX_EFFECTS_PER_TARGET) throw statusError('Target has too many statuses', 'status_limit');
      const instance = {
        id: cleanText(message.instanceId) || (context.idFactory?.() || reducerId()), definitionId,
        stacks: Math.min(definition.maxStacks, amount), enabled: true, note: cleanText(message.note),
        source: plainObject(message.source) ? clone(message.source) : clone(context.source || { role: 'offline' }),
        createdAt: cleanText(context.now) || new Date().toISOString(),
      };
      const duration = normalizeInstanceDuration(message.duration, definition.defaultDuration);
      if (duration) instance.duration = duration;
      target.effects.push(instance);
    }
    return { action: 'apply', scope, targetId, definitionId };
  }
  if (type === 'status.remove') { if (index >= 0) target.effects.splice(index, 1); return { action: 'remove', scope, targetId, definitionId }; }
  if (type === 'status.setStacks') {
    if (index < 0) throw statusError('Status is not applied to this target', 'status_not_applied');
    target.effects[index].stacks = integer(message.stacks, 1, 1, definition.maxStacks);
    if (message.enabled !== undefined) {
      if (typeof message.enabled !== 'boolean') throw statusError('enabled must be boolean');
      target.effects[index].enabled = message.enabled;
      if (message.enabled && target.effects[index].expiredAt) {
        const reset = normalizeInstanceDuration(message.duration, definition.defaultDuration);
        if (reset) target.effects[index].duration = reset;
        delete target.effects[index].expiredAt;
      }
    }
    if (message.duration !== undefined) {
      const duration = normalizeInstanceDuration(message.duration, definition.defaultDuration);
      if (!duration) throw statusError('duration must use valid turns or rounds');
      target.effects[index].duration = duration;
      delete target.effects[index].expiredAt;
    }
    if (message.note !== undefined) target.effects[index].note = cleanText(message.note);
    return { action: 'setStacks', scope, targetId, definitionId };
  }
  throw statusError(`Unsupported status operation: ${type}`, 'unknown_message');
}

function cloneStatusOperationInput(rawEntityState, message) {
  const state = {
    ...rawEntityState,
    statusDefinitions: [...(rawEntityState?.statusDefinitions || [])],
    actors: [...(rawEntityState?.actors || [])],
    tokens: [...(rawEntityState?.tokens || [])],
  };
  const operations = message?.type === 'status.batch' ? message.operations || [] : [message];
  const actorIds = new Set();
  const tokenIds = new Set();
  const syntheticIds = new Set();
  for (const operation of operations) {
    const target = plainObject(operation?.target) ? operation.target : operation;
    const scope = String(target?.scope || '');
    const targetId = String(target?.targetId || '');
    if (scope === 'actor') actorIds.add(targetId);
    else if (scope === 'token') tokenIds.add(targetId);
    else if (scope === 'syntheticActor') syntheticIds.add(targetId);
  }
  state.actors = state.actors.map(actor => actorIds.has(String(actor?.id || ''))
    ? { ...actor, effects: clone(actor.effects || []) }
    : actor);
  state.tokens = state.tokens.map(token => {
    const id = String(token?.id || '');
    if (tokenIds.has(id)) return { ...token, effects: clone(token.effects || []) };
    if (syntheticIds.has(id)) {
      return {
        ...token,
        actorDelta: {
          ...(plainObject(token.actorDelta) ? token.actorDelta : {}),
          effects: clone(token.actorDelta?.effects || []),
        },
      };
    }
    return token;
  });
  return state;
}

function statusEffectCollections(entityState) {
  return [
    ...(entityState.actors || []).map(actor => actor.effects),
    ...(entityState.tokens || []).flatMap(token => [token.effects, token.actorDelta?.effects]),
  ].filter(Array.isArray);
}

export function advanceStatusDurations(rawEntityState, {
  roundAdvanced = false,
  now = new Date().toISOString(),
  round = 0,
  turn = 0,
} = {}) {
  const state = normalizeEntityStatusState(rawEntityState);
  const expiredEffectIds = [];
  for (const effects of statusEffectCollections(state)) {
    for (const effect of effects) {
      if (effect?.enabled === false || !effect?.duration || effect.duration.remaining <= 0) continue;
      const shouldTick = effect.duration.unit === 'turns'
        || (effect.duration.unit === 'rounds' && roundAdvanced);
      if (!shouldTick) continue;
      effect.duration.remaining = Math.max(0, Number(effect.duration.remaining) - 1);
      if (effect.duration.remaining > 0) continue;
      effect.enabled = false;
      effect.expiredAt = {
        timestamp: String(now),
        round: Math.max(0, Math.floor(Number(round) || 0)),
        turn: Math.max(0, Math.floor(Number(turn) || 0)),
      };
      expiredEffectIds.push(String(effect.id));
    }
  }
  return { state, expiredEffectIds };
}

export function reduceStatusOperation(rawEntityState, message, context = {}) {
  const state = context.assumeNormalized === true
    ? cloneStatusOperationInput(rawEntityState, message)
    : normalizeEntityStatusState(rawEntityState);
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
    actors: state.actors.map(actor => ({ id: actor.id, effects: actor.effects, system: actor.system || null })),
    tokens: state.tokens.map(token => ({ id: token.id, actorId: token.actorId, actorLink: token.actorLink !== false, actorDelta: token.actorDelta || null, effects: token.effects })),
  });
}
