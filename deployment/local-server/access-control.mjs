import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertWorldState, isSameChat } from './world-schema.mjs';
import { statusStateChanged } from './status-operations.mjs';
import { resolveStatusCapabilitiesForToken } from './status-capabilities-v2.mjs';

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
function same(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
function mapById(items = []) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) if (item?.id !== undefined && item?.id !== null) map.set(String(item.id), item);
  return map;
}
function entityState(state) {
  const value = state?.preferences?.entitySystem;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { actors: [], tokens: [] };
}
function combatState(state) {
  const value = state?.preferences?.combatSystem?.combat;
  return value && typeof value === 'object' ? value : null;
}
function activeWorld(state) {
  const value = state?.preferences?.worldV2;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function activeScene(state) {
  const world = activeWorld(state);
  if (!world || !Array.isArray(world.scenes)) return null;
  return world.scenes.find(scene => String(scene?.id ?? '') === String(world.activeSceneId ?? '')) || null;
}
function tokenMapFromScene(state) { return mapById(activeScene(state)?.tokens || []); }
function tokenActorMap(state) {
  const result = new Map();
  for (const token of entityState(state).tokens || []) {
    const actorId = cleanActorId(token?.actorId);
    if (actorId && token?.id != null) result.set(String(token.id), actorId);
  }
  for (const token of activeScene(state)?.tokens || []) {
    const actorId = cleanActorId(token?.actorId);
    if (actorId && token?.id != null) result.set(String(token.id), actorId);
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
    if ((token.actorLink !== false) !== (other.actorLink !== false)) return false;
  }
  return true;
}
function sceneTokenStructureMatches(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return false;
  const beforeTokens = mapById(beforeScene.tokens || []);
  const nextTokens = mapById(nextScene.tokens || []);
  if (beforeTokens.size !== nextTokens.size) return false;
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (!other) return false;
    if (String(token.actorId ?? '') !== String(other.actorId ?? '')) return false;
    if ((token.actorLink !== false) !== (other.actorLink !== false)) return false;
  }
  return true;
}
function placement(token) {
  if (!token) return null;
  return token.placement === 'feature'
    ? { placement: 'feature', featureId: token.featureId == null ? null : String(token.featureId) }
    : { placement: 'map', x: Number(token.x), y: Number(token.y) };
}
export function movedWorldTokenIds(before, next) {
  const beforeScene = activeScene(before);
  const nextScene = activeScene(next);
  if (!beforeScene || !nextScene || String(beforeScene.id) !== String(nextScene.id)) return [];
  const nextTokens = mapById(nextScene.tokens || []);
  return (beforeScene.tokens || []).flatMap(token => {
    const id = String(token?.id ?? '');
    if (!id) return [];
    const other = nextTokens.get(id);
    return other && !same(placement(token), placement(other)) ? [id] : [];
  });
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
  if (!state || typeof state !== 'object') return state;
  const copy = structuredClone(state);
  if (copy.preferences && typeof copy.preferences === 'object') {
    delete copy.preferences.entitySystem;
    delete copy.preferences.chatSystem;
    delete copy.preferences.combatSystem;
    if (copy.preferences.worldV2 !== undefined) copy.preferences.worldV2 = worldV2GlobalProjection(copy.preferences.worldV2);
  }
  return copy;
}
function tokenSizeFields(token) { return { diameterMeters: token?.diameterMeters ?? null, size: token?.size ?? null }; }
function changedActorIds(before, next) {
  const changed = new Set();
  const beforeActors = mapById(entityState(before).actors || []);
  const nextActors = mapById(entityState(next).actors || []);
  for (const [id, actor] of beforeActors) if (!same(actor, nextActors.get(id))) changed.add(id);
  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  for (const [id, token] of beforeTokens) {
    const other = nextTokens.get(id);
    if (!same(token, other)) {
      const actorId = cleanActorId(other?.actorId ?? token?.actorId);
      if (actorId) changed.add(actorId);
    }
  }
  return changed;
}

function newPlayerKey() { return randomBytes(8).toString('hex').toUpperCase(); }
function newAuthToken() { return randomBytes(32).toString('base64url'); }
export function hashCredential(value) { return createHash('sha256').update(String(value || '')).digest('hex'); }
const ACTOR_TYPES = new Set(['pc', 'monster', 'npc', 'summon', 'other']);
const MARKER_KINDS = new Set(['trap', 'target', 'area', 'note']);
function normalizePlacementGrants(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const clean = (value, allowed = null) => [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item ?? '').trim().slice(0, 160))
    .filter(item => item && (!allowed || allowed.has(item))))].slice(0, 128);
  return {
    actorTypes: clean(source.actorTypes, ACTOR_TYPES),
    actorIds: clean(source.actorIds),
    markerKinds: clean(source.markerKinds, MARKER_KINDS),
  };
}
export function createAccessState() { return { schemaVersion: 3, users: [] }; }
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
    const keyHash = typeof item.playerKeyHash === 'string' && item.playerKeyHash.length === 64
      ? item.playerKeyHash
      : typeof item.claimHash === 'string' && item.claimHash.length === 64 ? item.claimHash : null;
    users.push({
      id, name: cleanName(item.name), role: 'player', defaultActorId, ownership,
      placementGrants: normalizePlacementGrants(item.placementGrants),
      tokenHash: typeof item.tokenHash === 'string' && item.tokenHash.length === 64 ? item.tokenHash : null,
      playerKeyHash: keyHash, claimHash: keyHash, disabled: item.disabled === true,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    });
  }
  return { schemaVersion: 3, users };
}
function baseUser({ name, defaultActorId = null, ownership = {}, placementGrants = {} } = {}) {
  const normalizedOwnership = normalizeOwnership(ownership);
  const actorId = cleanActorId(defaultActorId);
  if (actorId) normalizedOwnership[actorId] = OWNERSHIP.OWNER;
  const now = new Date().toISOString();
  return { id: randomUUID(), name: cleanName(name), role: 'player', defaultActorId: actorId, ownership: normalizedOwnership, placementGrants: normalizePlacementGrants(placementGrants), tokenHash: null, playerKeyHash: null, claimHash: null, disabled: false, createdAt: now, updatedAt: now };
}
export function createBoundUser(options = {}) {
  const playerKey = newPlayerKey();
  const user = baseUser(options);
  const keyHash = hashCredential(playerKey);
  user.tokenHash = keyHash; user.playerKeyHash = keyHash; user.claimHash = keyHash;
  return { user, authToken: playerKey, playerKey };
}
export function createClaimableUser(options = {}) {
  const playerKey = newPlayerKey();
  const user = baseUser(options);
  const keyHash = hashCredential(playerKey);
  user.playerKeyHash = keyHash; user.claimHash = keyHash;
  return { user, playerKey, claimCode: playerKey };
}
export function verifyUserCredential(user, authToken) { return Boolean(user && !user.disabled && user.tokenHash && authToken && user.tokenHash === hashCredential(authToken)); }
export function verifyPlayerKey(user, playerKey) { return Boolean(user && !user.disabled && user.playerKeyHash && playerKey && user.playerKeyHash === hashCredential(String(playerKey).trim().toUpperCase())); }
export function bindWithPlayerKey(user, playerKey) {
  if (!verifyPlayerKey(user, playerKey)) return null;
  const authToken = newAuthToken();
  user.tokenHash = hashCredential(authToken); user.updatedAt = new Date().toISOString();
  return authToken;
}
export function claimUser(user, claimCode) { return bindWithPlayerKey(user, claimCode); }
export function resetUserPlayerKey(user) {
  if (!user) return null;
  const playerKey = newPlayerKey();
  const keyHash = hashCredential(playerKey);
  user.playerKeyHash = keyHash; user.claimHash = keyHash; user.tokenHash = null; user.updatedAt = new Date().toISOString();
  return playerKey;
}
export function resetUserClaim(user) { return resetUserPlayerKey(user); }
export function updateUserRecord(user, patch = {}) {
  if (!user) return null;
  if (patch.name !== undefined) user.name = cleanName(patch.name, user.name);
  if (patch.ownership !== undefined) user.ownership = normalizeOwnership(patch.ownership);
  if (patch.placementGrants !== undefined) user.placementGrants = normalizePlacementGrants(patch.placementGrants);
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
  return { id: user.id, name: user.name, role: 'player', defaultActorId: user.defaultActorId || null, ownership: { ...user.ownership }, placementGrants: normalizePlacementGrants(user.placementGrants), disabled: user.disabled === true, claimed: Boolean(user.tokenHash), hasPlayerKey: Boolean(user.playerKeyHash), createdAt: user.createdAt, updatedAt: user.updatedAt };
}
export function ownershipLevel(user, actorId) { return !user || !actorId ? OWNERSHIP.NONE : user.ownership?.[String(actorId)] || OWNERSHIP.NONE; }
export function actorCatalogFromWorld(state) { return (entityState(state).actors || []).map(actor => ({ id: String(actor.id), name: cleanName(actor.name, 'Actor') })); }
export function currentCombatActorId(state) {
  const combat = combatState(state);
  if (!combat || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  const current = combat.combatants[index];
  return tokenActorMap(state).get(String(current?.tokenId || '')) || cleanActorId(current?.actorId) || null;
}

export function currentCombatTokenId(state) {
  const combat = combatState(state);
  if (!combat || combat.state !== 'active' || !Array.isArray(combat.combatants) || !combat.combatants.length) return null;
  const index = Math.max(0, Math.min(combat.combatants.length - 1, Number(combat.turnIndex) || 0));
  const tokenId = combat.combatants[index]?.tokenId;
  return tokenId == null || tokenId === '' ? null : String(tokenId);
}

function actorForToken(state, token) {
  const actorId = cleanActorId(token?.actorId);
  if (!actorId) return null;
  return (activeWorld(state)?.actors || []).find(actor => String(actor?.id) === actorId)
    || (entityState(state).actors || []).find(actor => String(actor?.id) === actorId)
    || null;
}

export function userControlsToken(state, user, token) {
  if (!user || !token) return false;
  const userId = String(user.id || '');
  if (userId && (token.controllerUserIds || []).map(String).includes(userId)) return true;
  const actor = actorForToken(state, token);
  return actor?.type === 'pc' && ownershipLevel(user, actor.id) === OWNERSHIP.OWNER;
}

export function validatePlayerWorldPush({ before, next, user } = {}) {
  if (!user || user.disabled) return { ok: false, code: 'identity_required', message: '需要已批准的 Player 身份' };
  if (!before || typeof before !== 'object') return { ok: false, code: 'gm_initialization_required', message: 'World 只能由 GM 初始化' };
  if (!next || typeof next !== 'object' || Array.isArray(next)) return { ok: false, code: 'invalid_state', message: 'World state must be an object' };
  if (!activeWorld(before) || !activeWorld(next)) return { ok: false, code: 'world_v2_required', message: 'Player authority requires World V2' };
  try { assertWorldState(before); assertWorldState(next); }
  catch (error) { return { ok: false, code: error?.code || 'invalid_state', message: error?.message || 'World state 无效' }; }
  if (!actorSetsMatch(before, next) || !tokenSetsMatch(before, next) || !sceneTokenStructureMatches(before, next)) {
    return { ok: false, code: 'actor_structure_gm_only', message: '创建、删除或重新绑定 Actor / Token 只能由 GM 完成' };
  }
  if (statusStateChanged(before, next)) return { ok: false, code: 'status_gm_only', message: '状态定义与 Actor / Token 效果只能通过 GM 状态操作提交' };
  if (!same(combatState(before), combatState(next))) return { ok: false, code: 'combat_gm_only', message: '参战者、先攻顺序、轮次与当前回合只能由 GM 修改' };
  if (!same(globalProjection(before), globalProjection(next))) return { ok: false, code: 'world_scope_forbidden', message: 'Player 只能修改自己拥有的 Actor、Token 与聊天内容' };
  if (!isSameChat(before, next)) return { ok: false, code: 'chat_server_only', message: '聊天记录只能通过服务器提交' };
  const beforeTokens = mapById(entityState(before).tokens || []);
  const nextTokens = mapById(entityState(next).tokens || []);
  for (const [id, token] of beforeTokens) {
    if (!same(tokenSizeFields(token), tokenSizeFields(nextTokens.get(id)))) return { ok: false, code: 'token_size_gm_only', message: 'Token 直径只能由 GM 修改' };
  }
  const movedTokenIds = movedWorldTokenIds(before, next);
  if (combatState(before)?.state === 'active' && movedTokenIds.length > 1) {
    return { ok: false, code: 'combat_group_move_gm_only', message: '战斗中 Player 只能移动当前回合的一个 Token' };
  }
  const changed = changedActorIds(before, next);
  for (const actorId of changed) {
    if (ownershipLevel(user, actorId) !== OWNERSHIP.OWNER) return { ok: false, code: 'actor_not_owned', message: `你没有 Actor ${actorId} 的 OWNER 权限`, actorId };
  }
  const activeActorId = currentCombatActorId(before);
  if (combatState(before)?.state === 'active' && changed.size && (!activeActorId || [...changed].some(actorId => actorId !== activeActorId))) {
    return { ok: false, code: 'combat_turn_locked', message: '当前处于战斗中，只能操控先攻顺序中正在行动的 Actor', activeActorId };
  }
  const sceneTokens = tokenMapFromScene(before);
  const activeTokenId = currentCombatTokenId(before);
  for (const tokenId of movedTokenIds) {
    const token = sceneTokens.get(String(tokenId));
    const actorId = cleanActorId(token?.actorId);
    if (!token || !userControlsToken(before, user, token)) {
      return { ok: false, code: 'token_not_controlled', message: '你没有该 Token 的控制权限', tokenId, actorId };
    }
    if (activeTokenId && String(activeTokenId) !== String(tokenId)) {
      return { ok: false, code: 'combat_turn_locked', message: '战斗中只能移动当前回合的 Token', tokenId, actorId, activeTokenId };
    }
    const capabilities = resolveStatusCapabilitiesForToken(before, tokenId);
    if (capabilities.canMove === false) {
      const reason = capabilities.reasons?.length ? `（${capabilities.reasons.join('、')}）` : '';
      return { ok: false, code: 'status_movement_forbidden', message: `该 Token 当前状态禁止移动${reason}`, tokenId };
    }
  }
  return { ok: true, changedActorIds: [...changed] };
}
