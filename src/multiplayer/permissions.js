function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mapById(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) if (item?.id != null) map.set(String(item.id), item);
  return map;
}

function entityState(state) {
  return state?.preferences?.entitySystem && typeof state.preferences.entitySystem === 'object'
    ? state.preferences.entitySystem
    : { actors: [], tokens: [] };
}

function worldV2(state) {
  const world = state?.preferences?.worldV2;
  return world && typeof world === 'object' && !Array.isArray(world) ? world : null;
}

function activeScene(state) {
  const world = worldV2(state);
  if (!world || !Array.isArray(world.scenes)) return null;
  return world.scenes.find(scene => String(scene?.id ?? '') === String(world.activeSceneId ?? '')) || null;
}

function combatState(state) {
  const combat = state?.preferences?.combatSystem?.combat;
  return combat && typeof combat === 'object' ? combat : null;
}

function chatMessages(state) {
  const messages = state?.preferences?.chatSystem?.messages;
  return Array.isArray(messages) ? messages : [];
}

function tokenActors(state) {
  const map = new Map();
  for (const token of entityState(state).tokens || []) {
    const actorId = token?.actorId == null ? null : String(token.actorId);
    if (actorId && token.id != null) map.set(String(token.id), actorId);
  }
  for (const token of activeScene(state)?.tokens || []) {
    const actorId = token?.actorId == null ? null : String(token.actorId);
    if (actorId && token.id != null) map.set(String(token.id), actorId);
  }
  return map;
}

function sameIds(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a.keys()) if (!b.has(id)) return false;
  return true;
}

function tokenSizeFields(token) {
  return { diameterMeters: token?.diameterMeters ?? null, size: token?.size ?? null };
}

function statusProjection(state) {
  const entities = entityState(state);
  return {
    definitions: entities.statusDefinitions ?? [],
    actors: (entities.actors || []).map(actor => ({ id: actor?.id, effects: actor?.effects ?? [] })),
    tokens: (entities.tokens || []).map(token => ({
      id: token?.id,
      effects: token?.effects ?? [],
      actorDeltaEffects: token?.actorDelta?.effects ?? null,
    })),
  };
}

function worldV2GlobalProjection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const world = structuredClone(raw);
  const activeSceneId = String(world.activeSceneId ?? '');
  delete world.actors;
  delete world.statusDefinitions;
  delete world.updatedAt;
  if (Array.isArray(world.scenes)) {
    world.scenes = world.scenes.map(scene => {
      if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return scene;
      if (String(scene.id ?? '') !== activeSceneId) return scene;
      const projected = structuredClone(scene);
      delete projected.tokens;
      delete projected.markers;
      delete projected.attackAreas;
      delete projected.sceneEvents;
      if (projected.settings && typeof projected.settings === 'object' && !Array.isArray(projected.settings)) {
        projected.settings = { ...projected.settings };
        delete projected.settings.gridVisible;
        if (!Object.keys(projected.settings).length) delete projected.settings;
      }
      return projected;
    });
  }
  return world;
}

function globalProjection(state) {
  const copy = structuredClone(state);
  if (copy.preferences && typeof copy.preferences === 'object') {
    delete copy.preferences.entitySystem;
    delete copy.preferences.chatSystem;
    delete copy.preferences.combatSystem;
    if (copy.preferences.worldV2 !== undefined) copy.preferences.worldV2 = worldV2GlobalProjection(copy.preferences.worldV2);
  }
  return copy;
}

function currentActorId(state) {
  const combat = combatState(state);
  if (!combat || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  const current = combat.combatants[index];
  return tokenActors(state).get(String(current?.tokenId || ''))
    || (current?.actorId != null && String(current.actorId).trim() ? String(current.actorId) : null);
}

function tokenPlacement(token) {
  if (!token) return null;
  return token.placement === 'feature'
    ? { placement: 'feature', featureId: token.featureId == null ? null : String(token.featureId) }
    : { placement: 'map', x: Number(token.x), y: Number(token.y) };
}

function changedSceneTokenIds(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return [];
  const nextTokens = mapById(nextScene.tokens || []);
  return (beforeScene.tokens || []).flatMap(token => {
    const id = String(token?.id ?? '');
    const other = nextTokens.get(id);
    return id && other && !same(tokenPlacement(token), tokenPlacement(other)) ? [id] : [];
  });
}

function hasLegacyIdentity(state) {
  if (Object.hasOwn(state || {}, 'characters')) return true;
  return (entityState(state).tokens || []).some(token => Object.hasOwn(token || {}, 'characterId'));
}

export function actorIdForToken(state, tokenId) {
  return tokenActors(state).get(String(tokenId || '')) || null;
}

export function validateLocalPlayerChange({ before, next, permissions = {} } = {}) {
  if (!before || !next) return { ok: true };
  if (permissions.actorOwnerIds?.includes?.('*')) return { ok: true };
  if (hasLegacyIdentity(before) || hasLegacyIdentity(next)) {
    return { ok: false, code: 'legacy_character_forbidden', message: '当前存档不接受旧角色标识字段' };
  }
  if (!worldV2(before) || !worldV2(next)) {
    return { ok: false, code: 'world_v2_required', message: 'Player preflight requires World V2' };
  }

  const owners = new Set((permissions.actorOwnerIds || []).map(String));
  const beforeActors = mapById(entityState(before).actors || []);
  const nextActors = mapById(entityState(next).actors || []);
  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  const beforeSceneTokens = mapById(activeScene(before)?.tokens || []);
  const nextSceneTokens = mapById(activeScene(next)?.tokens || []);

  if (!sameIds(beforeActors, nextActors) || !sameIds(beforeTokens, nextTokens) || !sameIds(beforeSceneTokens, nextSceneTokens)) {
    return { ok: false, code: 'actor_structure_gm_only', message: '创建、删除或重新绑定 Actor / Token 只能由 GM 完成' };
  }
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (String(token.actorId ?? '') !== String(other?.actorId ?? '') || (token.actorLink !== false) !== (other?.actorLink !== false)) {
      return { ok: false, code: 'actor_structure_gm_only', message: '重新绑定 Actor / Token 只能由 GM 完成' };
    }
    if (!same(tokenSizeFields(token), tokenSizeFields(other))) {
      return { ok: false, code: 'token_size_gm_only', message: 'Token 直径只能由 GM 修改' };
    }
  }
  for (const [id, token] of beforeSceneTokens) {
    const other = nextSceneTokens.get(id);
    if (String(token.actorId ?? '') !== String(other?.actorId ?? '') || (token.actorLink !== false) !== (other?.actorLink !== false)) {
      return { ok: false, code: 'actor_structure_gm_only', message: 'Scene Token 重新绑定只能由 GM 完成' };
    }
  }
  if (!same(combatState(before), combatState(next))) return { ok: false, code: 'combat_gm_only', message: '先攻、参战者和回合推进只能由 GM 修改' };
  if (!same(statusProjection(before), statusProjection(next))) {
    return { ok: false, code: 'status_server_only', message: '状态定义与 Actor / Token 状态只能通过 GM 状态操作提交' };
  }
  if (!same(globalProjection(before), globalProjection(next))) return { ok: false, code: 'world_scope_forbidden', message: 'Player 只能修改自己拥有的 Actor、Token 与聊天内容' };
  if (!same(chatMessages(before), chatMessages(next))) return { ok: false, code: 'chat_server_only', message: '聊天记录只能通过服务器提交' };

  const movedTokenIds = changedSceneTokenIds(before, next);
  if (combatState(before)?.state === 'active' && movedTokenIds.length > 1) {
    return { ok: false, code: 'combat_group_move_gm_only', message: '战斗中 Player 只能移动当前回合的一个 Token' };
  }

  const changed = new Set();
  for (const [id, actor] of beforeActors) if (!same(actor, nextActors.get(id))) changed.add(id);
  for (const [id, token] of beforeTokens) if (!same(token, nextTokens.get(id))) changed.add(String(token.actorId));
  const actorByToken = tokenActors(before);
  for (const tokenId of movedTokenIds) {
    const actorId = actorByToken.get(String(tokenId));
    if (!actorId) return { ok: false, code: 'unbound_token_forbidden', message: '未绑定 Actor 的 Token 只能由 GM 修改' };
    changed.add(actorId);
  }

  for (const actorId of changed) if (!owners.has(String(actorId))) return { ok: false, code: 'actor_not_owned', message: '你没有这个 Actor 的 OWNER 权限', actorId };
  if (changed.size && combatState(before)?.state === 'active') {
    const activeActorId = currentActorId(before);
    if (!activeActorId || [...changed].some(id => String(id) !== activeActorId)) {
      return { ok: false, code: 'combat_turn_locked', message: '当前处于战斗中，只能操控先攻顺序中正在行动的 Actor', activeActorId };
    }
  }
  return { ok: true, changedActorIds: [...changed] };
}

export function canControlActor({ actorId, state, permissions = {} } = {}) {
  if (!actorId) return false;
  if (permissions.actorOwnerIds?.includes?.('*')) return true;
  if (!(permissions.actorOwnerIds || []).map(String).includes(String(actorId))) return false;
  const combat = combatState(state);
  if (combat?.state !== 'active') return true;
  return currentActorId(state) === String(actorId);
}
