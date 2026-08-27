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
    if (!actorId) continue;
    if (token.id != null) map.set(String(token.id), actorId);
    if (token.characterId != null) map.set(String(token.characterId), actorId);
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
    tokens: (entities.tokens || []).map(token => ({ id: token?.id, effects: token?.effects ?? [] })),
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
  delete copy.characters;
  if (copy.preferences && typeof copy.preferences === 'object') {
    delete copy.preferences.entitySystem;
    delete copy.preferences.chatSystem;
    delete copy.preferences.combatSystem;
    if (copy.preferences.worldV2 !== undefined) {
      copy.preferences.worldV2 = worldV2GlobalProjection(copy.preferences.worldV2);
    }
  }
  return copy;
}

function appendOnly(before, next) {
  const oldMessages = chatMessages(before);
  const newMessages = chatMessages(next);
  if (newMessages.length < oldMessages.length) return false;
  for (let i = 0; i < oldMessages.length; i += 1) if (!same(oldMessages[i], newMessages[i])) return false;
  return true;
}

function currentActorId(state) {
  const combat = combatState(state);
  if (!combat || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  const current = combat.combatants[index];
  // The Token binding is authoritative. Old combat records may omit actorId,
  // and a GM can later rebind a Token, so a cached combatant actorId must not
  // turn a valid OWNER turn into an unowned, immovable turn.
  return tokenActors(state).get(String(current?.tokenId || ''))
    || (current?.actorId != null && String(current.actorId).trim() ? String(current.actorId) : null);
}

export function actorIdForCharacter(state, characterId) {
  return tokenActors(state).get(String(characterId || '')) || null;
}

export function validateLocalPlayerChange({ before, next, permissions = {} } = {}) {
  if (!before || !next) return { ok: true };
  if (permissions.actorOwnerIds?.includes?.('*')) return { ok: true };

  const owners = new Set((permissions.actorOwnerIds || []).map(String));
  const beforeActors = mapById(entityState(before).actors || []);
  const nextActors = mapById(entityState(next).actors || []);
  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  const beforeCharacters = mapById(before.characters || []);
  const nextCharacters = mapById(next.characters || []);

  if (!sameIds(beforeActors, nextActors) || !sameIds(beforeTokens, nextTokens) || !sameIds(beforeCharacters, nextCharacters)) {
    return { ok: false, code: 'actor_structure_gm_only', message: '创建、删除或重新绑定 Actor / Token 只能由 GM 完成' };
  }
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (String(token.actorId ?? '') !== String(other?.actorId ?? '') || String(token.characterId ?? '') !== String(other?.characterId ?? '')) {
      return { ok: false, code: 'actor_structure_gm_only', message: '重新绑定 Actor / Token 只能由 GM 完成' };
    }
    if (!same(tokenSizeFields(token), tokenSizeFields(other))) {
      return { ok: false, code: 'token_size_gm_only', message: 'Token 直径只能由 GM 修改' };
    }
  }
  if (!same(combatState(before), combatState(next))) return { ok: false, code: 'combat_gm_only', message: '先攻、参战者和回合推进只能由 GM 修改' };
  if (!same(statusProjection(before), statusProjection(next))) {
    return { ok: false, code: 'status_server_only', message: '状态定义与 Actor / Token 状态只能通过 GM 状态操作提交' };
  }
  if (!same(globalProjection(before), globalProjection(next))) return { ok: false, code: 'world_scope_forbidden', message: 'Player 只能修改自己拥有的角色与聊天内容' };
  if (!same(chatMessages(before), chatMessages(next))) return { ok: false, code: 'chat_server_only', message: '聊天记录只能通过服务器提交' };

  const changed = new Set();
  for (const [id, actor] of beforeActors) if (!same(actor, nextActors.get(id))) changed.add(id);
  for (const [id, token] of beforeTokens) if (!same(token, nextTokens.get(id))) changed.add(String(token.actorId));
  const beforeTokenActors = tokenActors(before);
  const nextTokenActors = tokenActors(next);
  for (const [id, character] of beforeCharacters) {
    if (!same(character, nextCharacters.get(id))) {
      const actorId = nextTokenActors.get(id) || beforeTokenActors.get(id);
      if (!actorId) return { ok: false, code: 'unbound_character_forbidden', message: '未绑定 Actor 的角色状态只能由 GM 修改' };
      changed.add(actorId);
    }
  }

  for (const actorId of changed) if (!owners.has(String(actorId))) return { ok: false, code: 'actor_not_owned', message: '你没有这个角色的 OWNER 权限', actorId };
  if (changed.size && combatState(before)?.state === 'active') {
    const activeActorId = currentActorId(before);
    if (!activeActorId || [...changed].some(id => String(id) !== activeActorId)) {
      return { ok: false, code: 'combat_turn_locked', message: '当前处于战斗中，只能操控先攻顺序中正在行动的角色', activeActorId };
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
