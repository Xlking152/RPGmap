import { BUILTIN_STATUS_DEFINITIONS } from './status-operations.mjs';

const BUILTIN_BY_ID = new Map(BUILTIN_STATUS_DEFINITIONS.map(definition => [definition.id, definition]));

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeValue(base, delta) {
  if (delta === undefined) return structuredClone(base);
  if (Array.isArray(delta)) return structuredClone(delta);
  if (!plainObject(delta)) return structuredClone(delta);
  const result = plainObject(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(delta)) result[key] = mergeValue(result[key], value);
  return result;
}

function resolveTokenActor(baseActor, token) {
  if (!baseActor || token?.actorLink !== false || !plainObject(token?.actorDelta)) return baseActor;
  const actor = mergeValue(baseActor, token.actorDelta);
  actor.id = baseActor.id;
  return actor;
}

function applyChange(current, change, stacks) {
  const amount = finite(change?.value);
  if (change?.mode === 'set') return amount;
  if (change?.mode === 'multiply') return current * amount;
  if (change?.mode === 'min') return Math.min(current, amount);
  if (change?.mode === 'max') return Math.max(current, amount);
  return current + amount * stacks;
}

function healthMovementBlock(actor, actorStatuses) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  const form = forms.find(item => String(item?.id) === String(actor?.currentFormId)) || forms[0] || null;
  const hpBase = form?.resourceBases?.hp;
  const hpRuntime = actor?.runtime?.resources?.hp;
  const healthRuntime = actor?.runtime?.health;
  if (!hpBase && !hpRuntime && !healthRuntime) return null;
  let maximum = Math.max(0, finite(hpRuntime?.maxOverride ?? hpBase?.baseMax));
  let current = finite(hpRuntime?.current, maximum);
  for (const { definition, effect } of actorStatuses) {
    const stacks = Math.max(1, Math.floor(finite(effect?.stacks, 1)));
    for (const change of definition?.changes || []) {
      if (change?.target === 'resources.hp.max') maximum = applyChange(maximum, change, stacks);
      if (change?.target === 'resources.hp.current') current = applyChange(current, change, stacks);
    }
  }
  maximum = Math.max(0, maximum);
  if (healthRuntime?.mode !== 'wound-track') {
    current = Math.max(0, Math.min(maximum, Math.floor(finite(current, maximum))));
    return current <= 0 ? 'dead' : null;
  }
  const raw = healthRuntime?.wounds || {};
  const aggravated = Math.max(0, Math.min(maximum, Math.floor(finite(raw.aggravated))));
  const lethal = Math.max(0, Math.min(maximum - aggravated, Math.floor(finite(raw.lethal))));
  const bashing = Math.max(0, Math.min(maximum - aggravated - lethal, Math.floor(finite(raw.bashing))));
  const healthy = Math.max(0, maximum - aggravated - lethal - bashing);
  if (maximum > 0 && aggravated >= maximum) return 'dead';
  if (maximum > 0 && healthy === 0) return 'unconscious';
  return null;
}

export function resolveStatusCapabilitiesForToken(state, tokenId) {
  const entities = state?.preferences?.entitySystem;
  const tokens = Array.isArray(entities?.tokens) ? entities.tokens : [];
  const actors = Array.isArray(entities?.actors) ? entities.actors : [];
  const token = tokens.find(item => String(item?.id) === String(tokenId)) || null;
  const baseActor = token ? actors.find(item => String(item?.id) === String(token.actorId)) || null : null;
  const actor = resolveTokenActor(baseActor, token);
  if (!token || !actor) {
    return { canMove: false, canInteract: false, canActInCombat: false, collisionBypassGroups: [], reasons: ['Actor / Token binding is missing'] };
  }
  const definitions = new Map(BUILTIN_BY_ID);
  for (const definition of Array.isArray(entities.statusDefinitions) ? entities.statusDefinitions : []) definitions.set(String(definition?.id), definition);
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
  const actorStatusCount = resolved.length;
  collect(token, 'token');
  const capabilities = { canMove: true, canInteract: true, canActInCombat: true, collisionBypassGroups: [], reasons: [] };
  for (const key of ['canMove', 'canInteract', 'canActInCombat']) {
    if (resolved.some(status => status.definition?.capabilities?.[key] === false)) capabilities[key] = false;
  }
  const bypass = new Set();
  for (const status of resolved) {
    if (status.definition?.capabilities?.canMove === false) capabilities.reasons.push(String(status.definition.name || status.definition.id || '状态禁止移动'));
    for (const group of status.definition?.capabilities?.collisionBypassGroups || []) if (group === 'structure') bypass.add(group);
  }
  capabilities.collisionBypassGroups = [...bypass];
  const healthBlock = healthMovementBlock(actor, resolved.slice(0, actorStatusCount));
  if (healthBlock) {
    capabilities.canMove = false;
    capabilities.canInteract = false;
    capabilities.canActInCombat = false;
    capabilities.reasons.push(healthBlock === 'dead' ? '死亡' : '昏迷');
  }
  return capabilities;
}
