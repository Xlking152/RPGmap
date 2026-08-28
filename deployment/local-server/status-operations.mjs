import { randomUUID } from 'node:crypto';

export const STATUS_LIMITS = Object.freeze({
  maxDefinitions: 128,
  maxEffectsPerTarget: 64,
  maxChangesPerDefinition: 16,
  maxBatchOperations: 64,
  maxStacks: 99,
  maxTextLength: 4_000,
  maxIdLength: 160,
});

export const STATUS_OPERATION_CACHE_LIMIT = 512;

const STATUS_MESSAGE_TYPES = new Set([
  'status.apply',
  'status.remove',
  'status.setStacks',
  'status.definition.upsert',
  'status.definition.delete',
]);
const SCOPES = new Set(['actor', 'token']);
const CHANGE_MODES = new Set(['add', 'set', 'multiply', 'min', 'max']);
const CAPABILITY_KEYS = new Set(['canMove', 'canInteract', 'canActInCombat', 'collisionBypassGroups']);
const CATEGORIES = new Set(['buff', 'debuff', 'trait', 'status']);
const STATUS_ICON_NAMES = new Set([
  'activity', 'anchor', 'ban', 'bomb', 'building', 'building-2', 'circle-alert',
  'circle-dot', 'circle-slash', 'door-closed', 'droplet', 'eye', 'eye-off',
  'flame', 'footprints', 'ghost', 'heart-pulse', 'lock', 'lock-keyhole', 'moon',
  'shield', 'shield-alert', 'skull', 'snowflake', 'sparkles', 'swords',
  'star', 'triangle-alert', 'unlock', 'unlock-keyhole', 'waves',
]);

function fail(message, code = 'invalid_status') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function array(value, label, max) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > max) fail(`${label} exceeds maximum length`, 'status_limit');
  return value;
}

function text(value, label, { required = false, max = STATUS_LIMITS.maxTextLength } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${label} is required`);
    return '';
  }
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const result = value.trim();
  if (required && !result) fail(`${label} is required`);
  if (result.length > max) fail(`${label} is too long`, 'status_limit');
  return result;
}

function id(value, label) {
  return text(value, label, { required: true, max: STATUS_LIMITS.maxIdLength });
}

export function assertStatusOperationId(value) {
  const operationId = id(value, 'operationId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) {
    fail('operationId may only contain letters, numbers, dot, underscore, colon, and hyphen', 'invalid_operation_id');
  }
  return operationId;
}

function integer(value, label, minimum, maximum) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function entityState(state) {
  return object(object(object(state, 'state').preferences, 'state.preferences').entitySystem, 'state.preferences.entitySystem');
}

function definitionMap(entities) {
  return new Map((entities.statusDefinitions || []).map(definition => [String(definition.id), definition]));
}

function definitionFor(entities, definitionId) {
  return definitionMap(entities).get(String(definitionId)) || null;
}

function statusCollection(entities, scope, targetId) {
  if (!SCOPES.has(scope)) fail('status scope must be actor or token');
  const list = scope === 'actor' ? entities.actors : entities.tokens;
  const target = list.find(entry => String(entry?.id) === String(targetId));
  if (!target) fail(`${scope} target does not exist: ${targetId}`, 'status_target_not_found');
  if (!Array.isArray(target.effects)) target.effects = [];
  return { target, effects: target.effects };
}

function normalizeTarget(message, label = 'status operation') {
  const source = message?.target && typeof message.target === 'object' && !Array.isArray(message.target)
    ? message.target
    : message;
  const scope = text(source?.scope, `${label}.scope`, { required: true, max: 16 });
  if (!SCOPES.has(scope)) fail(`${label}.scope must be actor or token`);
  return { scope, targetId: id(source?.targetId ?? source?.id, `${label}.targetId`) };
}

function validateChange(value, label) {
  const change = object(value, label);
  text(change.target, `${label}.target`, { required: true, max: 240 });
  const mode = text(change.mode ?? 'add', `${label}.mode`, { required: true, max: 20 });
  if (!CHANGE_MODES.has(mode)) fail(`${label}.mode is invalid`);
  if (!Number.isFinite(Number(change.value))) fail(`${label}.value must be finite`);
  return change;
}

export function assertStatusDefinition(value, label = 'status definition') {
  const definition = object(value, label);
  const definitionId = id(definition.id, `${label}.id`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(definitionId)) fail(`${label}.id contains unsupported characters`, 'invalid_status_id');
  text(definition.name, `${label}.name`, { required: true, max: 120 });
  text(definition.description ?? '', `${label}.description`);
  const icon = text(definition.icon ?? 'circle-dot', `${label}.icon`, { required: true, max: 120 });
  if (!STATUS_ICON_NAMES.has(icon)) fail(`${label}.icon is not an allowed Lucide icon`, 'status_icon_invalid');
  const color = text(definition.color ?? '', `${label}.color`, { max: 32 });
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) fail(`${label}.color must be a six-digit hex color`);
  const category = text(definition.category ?? 'status', `${label}.category`, { required: true, max: 24 });
  if (!CATEGORIES.has(category)) fail(`${label}.category is invalid`);
  const scopes = array(definition.scopes, `${label}.scopes`, 2);
  if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(scope => !SCOPES.has(String(scope)))) {
    fail(`${label}.scopes must contain unique actor/token values`);
  }
  const maxStacks = integer(definition.maxStacks ?? 1, `${label}.maxStacks`, 1, STATUS_LIMITS.maxStacks);
  const changes = array(definition.changes ?? [], `${label}.changes`, STATUS_LIMITS.maxChangesPerDefinition);
  changes.forEach((change, index) => validateChange(change, `${label}.changes[${index}]`));
  if (maxStacks > 1 && changes.some(change => String(change.mode || 'add') !== 'add')) {
    fail(`${label} can only stack additive changes`, 'status_stacking_invalid');
  }
  const capabilities = object(definition.capabilities ?? {}, `${label}.capabilities`);
  for (const key of Object.keys(capabilities)) if (!CAPABILITY_KEYS.has(key)) fail(`${label}.capabilities.${key} is not allowed`);
  for (const key of ['canMove', 'canInteract', 'canActInCombat']) {
    if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean') fail(`${label}.capabilities.${key} must be boolean`);
  }
  if (capabilities.collisionBypassGroups !== undefined) {
    const groups = array(capabilities.collisionBypassGroups, `${label}.capabilities.collisionBypassGroups`, 4);
    if (groups.some(group => group !== 'structure') || new Set(groups).size !== groups.length) {
      fail(`${label}.capabilities.collisionBypassGroups may only contain structure`);
    }
  }
  return definition;
}

export function assertStatusInstance(value, label, { definitions, scope, legacy = false } = {}) {
  const effect = object(value, label);
  id(effect.id, `${label}.id`);
  const definitionId = effect.definitionId == null ? '' : id(effect.definitionId, `${label}.definitionId`);
  if (!definitionId) {
    if (legacy && typeof effect.name === 'string' && Array.isArray(effect.changes)) return effect;
    fail(`${label}.definitionId is required`, 'invalid_status_reference');
  }
  const definition = definitions.get(definitionId) || null;
  if (!definition) fail(`${label} references missing definition: ${definitionId}`, 'invalid_status_reference');
  if (!definition.scopes.includes(scope)) fail(`${label} cannot be applied to ${scope}`, 'status_scope_forbidden');
  if (scope === 'token' && (definition.changes || []).length) {
    fail(`${label} cannot apply Actor numeric changes to a Token`, 'status_scope_forbidden');
  }
  integer(effect.stacks ?? 1, `${label}.stacks`, 1, Number(definition.maxStacks) || 1);
  if (effect.enabled !== undefined && typeof effect.enabled !== 'boolean') fail(`${label}.enabled must be boolean`);
  text(effect.note ?? '', `${label}.note`);
  if (effect.createdAt !== undefined) text(effect.createdAt, `${label}.createdAt`, { required: true, max: 80 });
  if (effect.source !== undefined && effect.source !== null && (typeof effect.source !== 'object' || Array.isArray(effect.source))) {
    fail(`${label}.source must be an object or null`);
  }
  return effect;
}

export function assertStatusState(entitySystem) {
  const entities = object(entitySystem, 'entitySystem');
  const definitions = array(entities.statusDefinitions ?? [], 'entitySystem.statusDefinitions', STATUS_LIMITS.maxDefinitions);
  const definitionIds = new Set();
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = assertStatusDefinition(definitions[index], `entitySystem.statusDefinitions[${index}]`);
    const definitionId = String(definition.id);
    if (definitionIds.has(definitionId)) fail(`Duplicate status definition: ${definitionId}`, 'duplicate_id');
    definitionIds.add(definitionId);
  }
  const definitionsById = definitionMap(entities);
  const legacy = Number(entities.schemaVersion || 0) < 3;
  for (const [scope, targets] of [['actor', entities.actors], ['token', entities.tokens]]) {
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const effects = array(targets[targetIndex]?.effects ?? [], `entitySystem.${scope}s[${targetIndex}].effects`, STATUS_LIMITS.maxEffectsPerTarget);
      const effectIds = new Set();
      const statusIds = new Set();
      for (let effectIndex = 0; effectIndex < effects.length; effectIndex += 1) {
        const effect = assertStatusInstance(effects[effectIndex], `entitySystem.${scope}s[${targetIndex}].effects[${effectIndex}]`, {
          definitions: definitionsById, scope, legacy,
        });
        const effectId = String(effect.id);
        if (effectIds.has(effectId)) fail(`Duplicate effect id on ${scope}: ${effectId}`, 'duplicate_id');
        effectIds.add(effectId);
        if (effect.definitionId) {
          const definitionId = String(effect.definitionId);
          if (statusIds.has(definitionId)) fail(`Duplicate status on ${scope}: ${definitionId}`, 'duplicate_id');
          statusIds.add(definitionId);
        }
      }
    }
  }
  return entitySystem;
}

function normalizedDefinition(input) {
  const value = structuredClone(object(input, 'definition'));
  value.builtIn = false;
  value.id = id(value.id, 'definition.id');
  value.name = text(value.name, 'definition.name', { required: true, max: 120 });
  value.description = text(value.description ?? '', 'definition.description');
  value.icon = text(value.icon ?? 'circle-dot', 'definition.icon', { required: true, max: 120 });
  value.color = text(value.color || '#64748b', 'definition.color', { max: 32 });
  value.category = text(value.category || 'status', 'definition.category', { max: 24 });
  value.scopes = [...new Set(array(value.scopes ?? ['actor'], 'definition.scopes', 2).map(String))];
  value.maxStacks = integer(value.maxStacks ?? 1, 'definition.maxStacks', 1, STATUS_LIMITS.maxStacks);
  value.changes = array(value.changes ?? [], 'definition.changes', STATUS_LIMITS.maxChangesPerDefinition).map(change => ({
    target: text(change?.target, 'definition.change.target', { required: true, max: 240 }),
    mode: text(change?.mode || 'add', 'definition.change.mode', { max: 20 }),
    value: Number(change?.value),
  }));
  value.capabilities = structuredClone(value.capabilities ?? {});
  assertStatusDefinition(value);
  return value;
}

function sourceFor(message, context) {
  const supplied = message.source && typeof message.source === 'object' && !Array.isArray(message.source)
    ? structuredClone(message.source)
    : {};
  return {
    ...supplied,
    userId: context.userId || null,
    sessionId: context.sessionId || null,
    role: 'gm',
  };
}

function applyOne(state, message, context) {
  const entities = entityState(state);
  entities.statusDefinitions ||= [];
  entities.schemaVersion = Math.max(3, Number(entities.schemaVersion) || 0);
  const type = String(message?.type || '');

  if (type === 'status.definition.upsert') {
    const definition = normalizedDefinition(message.definition);
    const index = entities.statusDefinitions.findIndex(item => String(item?.id) === definition.id);
    if (index >= 0 && entities.statusDefinitions[index]?.builtIn === true) {
      fail('Built-in status definitions are read-only', 'status_builtin_readonly');
    }
    if (index < 0) {
      if (entities.statusDefinitions.length >= STATUS_LIMITS.maxDefinitions) fail('Too many status definitions', 'status_limit');
      entities.statusDefinitions.push(definition);
    } else {
      const usedByToken = entities.tokens.some(token => (token.effects || []).some(effect => String(effect.definitionId) === definition.id));
      if (usedByToken && (definition.changes || []).length) fail('Token statuses cannot gain Actor numeric changes', 'status_scope_forbidden');
      const maxInUse = Math.max(1, ...entities.actors.concat(entities.tokens).flatMap(target => (target.effects || [])
        .filter(effect => String(effect.definitionId) === definition.id).map(effect => Number(effect.stacks) || 1)));
      if (definition.maxStacks < maxInUse) fail('maxStacks is lower than an applied stack count', 'status_definition_in_use');
      entities.statusDefinitions[index] = definition;
    }
    return { action: 'definition.upsert', definitionId: definition.id };
  }

  if (type === 'status.definition.delete') {
    const definitionId = id(message.definitionId ?? message.statusId, 'definitionId');
    const index = entities.statusDefinitions.findIndex(item => String(item?.id) === definitionId);
    if (index < 0) fail(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
    if (entities.statusDefinitions[index]?.builtIn === true) fail('Built-in status definitions are read-only', 'status_builtin_readonly');
    const referenced = entities.actors.concat(entities.tokens).some(target =>
      (target.effects || []).some(effect => String(effect.definitionId) === definitionId));
    if (referenced) fail('Status definition is still in use', 'status_definition_in_use');
    entities.statusDefinitions.splice(index, 1);
    return { action: 'definition.delete', definitionId };
  }

  const { scope, targetId } = normalizeTarget(message);
  const { effects } = statusCollection(entities, scope, targetId);
  const definitionId = id(message.statusId ?? message.definitionId, 'statusId');
  const definition = definitionFor(entities, definitionId);
  if (!definition) fail(`Status definition does not exist: ${definitionId}`, 'status_definition_not_found');
  if (!definition.scopes.includes(scope)) fail(`Status cannot be applied to ${scope}`, 'status_scope_forbidden');
  if (scope === 'token' && (definition.changes || []).length) fail('Token statuses cannot modify Actor numeric values', 'status_scope_forbidden');
  const index = effects.findIndex(effect => String(effect?.definitionId) === definitionId);

  if (type === 'status.apply') {
    const stacks = integer(message.stacks ?? 1, 'stacks', 1, STATUS_LIMITS.maxStacks);
    const maximum = Number(definition.maxStacks) || 1;
    if (index >= 0) {
      effects[index].stacks = Math.min(maximum, (Number(effects[index].stacks) || 1) + stacks);
      effects[index].enabled = true;
      if (message.note !== undefined) effects[index].note = text(message.note, 'note');
    } else {
      if (effects.length >= STATUS_LIMITS.maxEffectsPerTarget) fail('Target has too many statuses', 'status_limit');
      const effect = {
        id: randomUUID(),
        definitionId,
        stacks: Math.min(maximum, stacks),
        enabled: true,
        note: text(message.note ?? '', 'note'),
        source: sourceFor(message, context),
        createdAt: context.now,
      };
      effects.push(effect);
    }
    return { action: 'apply', scope, targetId, definitionId };
  }

  if (type === 'status.remove') {
    if (index >= 0) effects.splice(index, 1);
    return { action: 'remove', scope, targetId, definitionId };
  }

  if (type === 'status.setStacks') {
    if (index < 0) fail('Status is not applied to this target', 'status_not_applied');
    effects[index].stacks = integer(message.stacks, 'stacks', 1, Number(definition.maxStacks) || 1);
    if (message.enabled !== undefined) {
      if (typeof message.enabled !== 'boolean') fail('enabled must be boolean');
      effects[index].enabled = message.enabled;
    }
    if (message.note !== undefined) effects[index].note = text(message.note, 'note');
    return { action: 'setStacks', scope, targetId, definitionId };
  }

  fail(`Unsupported status operation: ${type}`, 'unknown_message');
}

export function applyStatusMessage(state, message, context = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) fail('World is not initialized', 'world_uninitialized');
  const next = structuredClone(state);
  const now = context.now || new Date().toISOString();
  const localContext = { ...context, now };
  let results;
  if (message?.type === 'status.batch') {
    const operations = array(message.operations, 'status.batch.operations', STATUS_LIMITS.maxBatchOperations);
    if (!operations.length) fail('status.batch.operations cannot be empty');
    results = operations.map((operation, index) => {
      const item = object(operation, `status.batch.operations[${index}]`);
      if (!STATUS_MESSAGE_TYPES.has(String(item.type)) || String(item.type).startsWith('status.definition.')) {
        fail(`status.batch.operations[${index}].type is not allowed`);
      }
      return applyOne(next, item, localContext);
    });
  } else {
    if (!STATUS_MESSAGE_TYPES.has(String(message?.type))) fail('Unknown status message', 'unknown_message');
    results = [applyOne(next, message, localContext)];
  }
  assertStatusState(entityState(next));
  return { state: next, results };
}

export function isStatusMessage(message) {
  return String(message?.type || '') === 'status.batch' || STATUS_MESSAGE_TYPES.has(String(message?.type || ''));
}

export function isStructuralStatusMessage(message) {
  return String(message?.type || '').startsWith('status.definition.');
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeActorDeltaValue(base, delta) {
  if (delta === undefined) return structuredClone(base);
  if (Array.isArray(delta)) return structuredClone(delta);
  if (!plainObject(delta)) return structuredClone(delta);
  const result = plainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(delta)) {
    result[key] = mergeActorDeltaValue(result[key], value);
  }
  return result;
}

function resolveAuthoritativeTokenActor(baseActor, token) {
  if (!baseActor || token?.actorLink !== false || !plainObject(token?.actorDelta)) return baseActor;
  const actor = mergeActorDeltaValue(baseActor, token.actorDelta);
  actor.id = baseActor.id;
  return actor;
}

/**
 * Resolve the same movement capability that the browser displays, using only
 * the latest authoritative World snapshot. This is the final server-side gate
 * for Player movement; GM relocation/import remains intentionally unrestricted.
 */
export function resolveStatusCapabilitiesForToken(state, tokenId) {
  const entities = state?.preferences?.entitySystem;
  const tokens = Array.isArray(entities?.tokens) ? entities.tokens : [];
  const actors = Array.isArray(entities?.actors) ? entities.actors : [];
  const token = tokens.find(item => String(item?.id) === String(tokenId)) || null;
  const baseActor = token ? actors.find(item => String(item?.id) === String(token.actorId)) || null : null;
  const actor = resolveAuthoritativeTokenActor(baseActor, token);
  if (!token || !actor) {
    return { canMove: false, canInteract: false, canActInCombat: false, collisionBypassGroups: [], reasons: ['Actor / Token binding is missing'] };
  }

  const definitions = new Map((Array.isArray(entities.statusDefinitions) ? entities.statusDefinitions : [])
    .map(definition => [String(definition?.id), definition]));
  const resolved = [];
  const collect = (target, scope) => {
    for (const effect of Array.isArray(target?.effects) ? target.effects : []) {
      if (!effect || effect.enabled === false) continue;
      const definition = definitions.get(String(effect.definitionId || ''));
      if (!definition || !definition.scopes?.includes(scope)) continue;
      resolved.push({ definition, effect, scope });
    }
  };
  collect(actor, 'actor');
  collect(token, 'token');

  const capabilities = {
    canMove: true,
    canInteract: true,
    canActInCombat: true,
    collisionBypassGroups: [],
    reasons: [],
  };
  for (const key of ['canMove', 'canInteract', 'canActInCombat']) {
    if (resolved.some(status => status.definition?.capabilities?.[key] === false)) capabilities[key] = false;
  }
  const bypass = new Set();
  for (const status of resolved) {
    if (status.definition?.capabilities?.canMove === false) {
      capabilities.reasons.push(String(status.definition.name || status.definition.id || '状态禁止移动'));
    }
    for (const group of status.definition?.capabilities?.collisionBypassGroups || []) {
      if (group === 'structure') bypass.add(group);
    }
  }
  capabilities.collisionBypassGroups = [...bypass];

  return capabilities;
}

export function statusStateChanged(before, next) {
  const beforeEntities = before?.preferences?.entitySystem;
  const nextEntities = next?.preferences?.entitySystem;
  if (JSON.stringify(beforeEntities?.statusDefinitions ?? []) !== JSON.stringify(nextEntities?.statusDefinitions ?? [])) return true;
  const projectActors = targets => (Array.isArray(targets) ? targets : [])
    .map(target => ({ id: target?.id, effects: target?.effects ?? [] }))
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const projectTokens = targets => (Array.isArray(targets) ? targets : [])
    .map(target => ({
      id: target?.id,
      effects: target?.effects ?? [],
      // Synthetic Actor effects are Actor-scoped mechanics persisted inside the
      // unlinked Token's ActorDelta. Treat them exactly like Actor effects for
      // permission purposes so an OWNER Player cannot forge GM-only statuses
      // through a raw world.push.
      actorDeltaEffects: plainObject(target?.actorDelta) && Array.isArray(target.actorDelta.effects)
        ? target.actorDelta.effects
        : null,
    }))
    .sort((left, right) => String(left.id ?? '').localeCompare(String(right.id ?? '')));
  const projection = entities => ({
    actors: projectActors(entities?.actors),
    tokens: projectTokens(entities?.tokens),
  });
  return JSON.stringify(projection(beforeEntities)) !== JSON.stringify(projection(nextEntities));
}
