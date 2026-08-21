import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const OWNERSHIP = Object.freeze({ NONE: 'none', OBSERVER: 'observer', OWNER: 'owner' });
const OWNERSHIP_VALUES = new Set(Object.values(OWNERSHIP));

function cleanName(value, fallback = 'Player') {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return text || fallback;
}

function cleanActorId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value).trim();
  return id ? id.slice(0, 160) : null;
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mapById(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.id !== undefined && item?.id !== null) map.set(String(item.id), item);
  }
  return map;
}

function entityState(state) {
  const value = state?.preferences?.entitySystem;
  return value && typeof value === 'object' ? value : { actors: [], tokens: [] };
}

function combatState(state) {
  const value = state?.preferences?.combatSystem?.combat;
  return value && typeof value === 'object' ? value : null;
}

function chatMessages(state) {
  const value = state?.preferences?.chatSystem?.messages;
  return Array.isArray(value) ? value : [];
}

function tokenActorMap(state) {
  const result = new Map();
  for (const token of entityState(state).tokens || []) {
    const actorId = cleanActorId(token?.actorId);
    if (!actorId) continue;
    if (token?.id != null) result.set(String(token.id), actorId);
    if (token?.characterId != null) result.set(String(token.characterId), actorId);
  }
  return result;
}

function actorSetsMatch(before, next) {
  const a = new Set((entityState(before).actors || []).map(item => String(item?.id ?? '')));
  const b = new Set((entityState(next).actors || []).map(item => String(item?.id ?? '')));
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function tokenSetsMatch(before, next) {
  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  if (beforeTokens.size !== nextTokens.size) return false;
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (!other) return false;
    if (String(token.actorId ?? '') !== String(other.actorId ?? '')) return false;
    if (String(token.characterId ?? '') !== String(other.characterId ?? '')) return false;
  }
  return true;
}

function characterSetsMatch(before, next) {
  const a = new Set((before?.characters || []).map(item => String(item?.id ?? '')));
  const b = new Set((next?.characters || []).map(item => String(item?.id ?? '')));
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function changedActorIds(before, next) {
  const changed = new Set();
  const beforeActors = mapById(entityState(before).actors || []);
  const nextActors = mapById(entityState(next).actors || []);
  for (const [id, actor] of beforeActors) {
    if (!same(actor, nextActors.get(id))) changed.add(id);
  }

  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (!same(token, other)) {
      const actorId = cleanActorId(other?.actorId ?? token?.actorId);
      if (actorId) changed.add(actorId);
    }
  }

  const beforeTokenActors = tokenActorMap(before);
  const nextTokenActors = tokenActorMap(next);
  const beforeCharacters = mapById(before?.characters || []);
  const nextCharacters = mapById(next?.characters || []);
  for (const [id, character] of beforeCharacters) {
    if (!same(character, nextCharacters.get(id))) {
      const actorId = nextTokenActors.get(id) || beforeTokenActors.get(id);
      if (actorId) changed.add(actorId);
      else changed.add('__unbound__');
    }
  }
  return changed;
}

function globalProjection(state) {
  if (!state || typeof state !== 'object') return state;
  const copy = structuredClone(state);
  delete copy.characters;
  if (copy.preferences && typeof copy.preferences === 'object') {
    delete copy.preferences.entitySystem;
    delete copy.preferences.chatSystem;
    delete copy.preferences.combatSystem;
  }
  return copy;
}

function chatAppendOnly(before, next) {
  const oldMessages = chatMessages(before);
  const newMessages = chatMessages(next);
  if (newMessages.length < oldMessages.length) return false;
  for (let i = 0; i < oldMessages.length; i += 1) {
    if (!same(oldMessages[i], newMessages[i])) return false;
  }
  return true;
}

function newPlayerKey() {
  return randomBytes(8).toString('hex').toUpperCase();
}

function newAuthToken() {
  return randomBytes(32).toString('base64url');
}

export function hashCredential(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function createAccessState() {
  return { schemaVersion: 2, users: [] };
}

export function normalizeOwnership(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [actorIdRaw, levelRaw] of Object.entries(raw)) {
    const actorId = cleanActorId(actorIdRaw);
    const level = String(levelRaw || '').toLowerCase();
    if (actorId && OWNERSHIP_VALUES.has(level) && level !== OWNERSHIP.NONE) result[actorId] = level;
  }
  return result;
}

export function normalizeAccessState(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : createAccessState();
  const users = [];
  const seen = new Set();
  for (const item of Array.isArray(source.users) ? source.users : []) {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownership = normalizeOwnership(item.ownership);
    let defaultActorId = cleanActorId(item.defaultActorId);
    if (defaultActorId && ownership[defaultActorId] !== OWNERSHIP.OWNER) defaultActorId = null;
    const legacyClaimHash = typeof item.claimHash === 'string' && item.claimHash.length === 64 ? item.claimHash : null;
    users.push({
      id,
      name: cleanName(item.name),
      role: 'player',
      defaultActorId,
      ownership,
      tokenHash: typeof item.tokenHash === 'string' && item.tokenHash.length === 64 ? item.tokenHash : null,
      playerKeyHash: typeof item.playerKeyHash === 'string' && item.playerKeyHash.length === 64 ? item.playerKeyHash : legacyClaimHash,
      disabled: item.disabled === true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }
  return { schemaVersion: 2, users };
}

function baseUser({ name, defaultActorId = null, ownership = {} } = {}) {
  const normalizedOwnership = normalizeOwnership(ownership);
  const actorId = cleanActorId(defaultActorId);
  if (actorId) normalizedOwnership[actorId] = OWNERSHIP.OWNER;
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: cleanName(name),
    role: 'player',
    defaultActorId: actorId,
    ownership: normalizedOwnership,
    tokenHash: null,
    playerKeyHash: null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function createBoundUser(options = {}) {
  const authToken = newAuthToken();
  const playerKey = newPlayerKey();
  const user = baseUser(options);
  user.tokenHash = hashCredential(authToken);
  user.playerKeyHash = hashCredential(playerKey);
  return { user, authToken, playerKey };
}

export function createClaimableUser(options = {}) {
  const playerKey = newPlayerKey();
  const user = baseUser(options);
  user.playerKeyHash = hashCredential(playerKey);
  return { user, playerKey };
}

export function verifyUserCredential(user, authToken) {
  if (!user || user.disabled || !user.tokenHash || !authToken) return false;
  return user.tokenHash === hashCredential(authToken);
}

export function verifyPlayerKey(user, playerKey) {
  if (!user || user.disabled || !user.playerKeyHash || !playerKey) return false;
  return user.playerKeyHash === hashCredential(String(playerKey).trim().toUpperCase());
}

export function bindWithPlayerKey(user, playerKey) {
  if (!verifyPlayerKey(user, playerKey)) return null;
  const authToken = newAuthToken();
  user.tokenHash = hashCredential(authToken);
  user.updatedAt = new Date().toISOString();
  return authToken;
}

export function resetUserPlayerKey(user) {
  if (!user) return null;
  const playerKey = newPlayerKey();
  user.playerKeyHash = hashCredential(playerKey);
  user.tokenHash = null;
  user.updatedAt = new Date().toISOString();
  return playerKey;
}

export function updateUserRecord(user, patch = {}) {
  if (!user) return null;
  if (patch.name !== undefined) user.name = cleanName(patch.name, user.name);
  if (patch.ownership !== undefined) user.ownership = normalizeOwnership(patch.ownership);
  if (patch.defaultActorId !== undefined) {
    const actorId = cleanActorId(patch.defaultActorId);
    if (actorId) user.ownership[actorId] = OWNERSHIP.OWNER;
    user.defaultActorId = actorId;
  }
  if (user.defaultActorId && user.ownership[user.defaultActorId] !== OWNERSHIP.OWNER) user.defaultActorId = null;
  if (patch.disabled !== undefined) user.disabled = patch.disabled === true;
  user.updatedAt = new Date().toISOString();
  return user;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    role: 'player',
    defaultActorId: user.defaultActorId || null,
    ownership: { ...user.ownership },
    disabled: user.disabled === true,
    claimed: Boolean(user.tokenHash),
    hasPlayerKey: Boolean(user.playerKeyHash),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function ownershipLevel(user, actorId) {
  if (!user || !actorId) return OWNERSHIP.NONE;
  return user.ownership?.[String(actorId)] || OWNERSHIP.NONE;
}

export function actorCatalogFromWorld(state) {
  return (entityState(state).actors || []).map(actor => ({ id: String(actor.id), name: cleanName(actor.name, 'Actor') }));
}

export function currentCombatActorId(state) {
  const combat = combatState(state);
  if (!combat || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  return cleanActorId(combat.combatants[index]?.actorId);
}

export function validatePlayerWorldPush({ before, next, user } = {}) {
  if (!user || user.disabled) return { ok: false, code: 'identity_required', message: '需要已批准的 Player 身份' };
  if (!before || typeof before !== 'object') return { ok: false, code: 'gm_initialization_required', message: 'World 只能由 GM 初始化' };
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { ok: false, code: 'invalid_state', message: 'World state must be an object' };

  if (!actorSetsMatch(before, next) || !tokenSetsMatch(before, next) || !characterSetsMatch(before, next)) {
    return { ok: false, code: 'actor_structure_gm_only', message: '创建、删除或重新绑定 Actor / Token 只能由 GM 完成' };
  }
  if (!same(combatState(before), combatState(next))) {
    return { ok: false, code: 'combat_gm_only', message: '参战者、先攻顺序、轮次与当前回合只能由 GM 修改' };
  }
  if (!same(globalProjection(before), globalProjection(next))) {
    return { ok: false, code: 'world_scope_forbidden', message: 'Player 只能修改自己拥有的 Actor、Token 与聊天内容' };
  }
  if (!chatAppendOnly(before, next)) {
    return { ok: false, code: 'chat_history_forbidden', message: 'Player 不能删除或改写既有聊天 / Game Log' };
  }

  const changed = changedActorIds(before, next);
  if (changed.has('__unbound__')) {
    return { ok: false, code: 'unbound_character_forbidden', message: '未绑定 Actor 的 Token/角色状态只能由 GM 修改' };
  }
  for (const actorId of changed) {
    if (ownershipLevel(user, actorId) !== OWNERSHIP.OWNER) {
      return { ok: false, code: 'actor_not_owned', message: `你没有 Actor ${actorId} 的 OWNER 权限`, actorId };
    }
  }

  if (changed.size) {
    const activeActorId = currentCombatActorId(before);
    if (combatState(before)?.state === 'active') {
      if (!activeActorId || [...changed].some(actorId => actorId !== activeActorId)) {
        return { ok: false, code: 'combat_turn_locked', message: '当前处于战斗中，只能操控先攻顺序中正在行动的角色', activeActorId };
      }
    }
  }

  return { ok: true, changedActorIds: [...changed] };
}
