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
  return capabilities;
}
