function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function newTokenId() {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `token-${value}`;
}

function activeSceneIndex(world) {
  const scenes = array(world?.scenes);
  const activeId = String(world?.activeSceneId ?? '');
  const index = scenes.findIndex(scene => String(scene?.id ?? '') === activeId);
  if (index < 0) throw new Error(`World has no active Scene: ${activeId || '(missing)'}`);
  return index;
}

function actorExists(world, actorId) {
  return array(world?.actors).some(actor => String(actor?.id ?? '') === String(actorId));
}

function tokenIndex(scene, tokenId) {
  return array(scene?.tokens).findIndex(token => String(token?.id ?? '') === String(tokenId));
}

function requireToken(scene, tokenId) {
  const index = tokenIndex(scene, tokenId);
  if (index < 0) throw new Error(`Unknown Token: ${tokenId}`);
  return { index, token: scene.tokens[index] };
}

function withActiveScene(world, update) {
  const next = clone(world);
  const index = activeSceneIndex(next);
  const scene = clone(next.scenes[index]);
  next.scenes[index] = update(scene, next) || scene;
  next.updatedAt = new Date().toISOString();
  return next;
}

function normalizeDelta(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : null;
}

function normalizeTexture(value) {
  const source = typeof value === 'string' ? { src: value } : object(value);
  return {
    ...clone(source),
    src: text(source.src) || null,
  };
}

function normalizeToken(raw, { actorId, tokenId } = {}) {
  const source = object(raw);
  const placement = source.placement === 'feature' || source.featureId != null ? 'feature' : 'map';
  return {
    id: text(tokenId ?? source.id, newTokenId()).slice(0, 160),
    actorId: text(actorId ?? source.actorId).slice(0, 160),
    actorLink: source.actorLink !== false,
    actorDelta: normalizeDelta(source.actorDelta),
    placement,
    x: placement === 'map' ? finite(source.x, 0) : null,
    y: placement === 'map' ? finite(source.y, 0) : null,
    featureId: placement === 'feature' ? text(source.featureId).slice(0, 160) || null : null,
    texture: normalizeTexture(source.texture),
    color: text(source.color) || null,
    diameterMeters: Math.max(0.1, finite(source.diameterMeters ?? source.size, 1)),
    rotation: finite(source.rotation, 0),
    elevationFt: finite(source.elevationFt, 0),
    hidden: source.hidden === true,
    locked: source.locked === true,
    showName: source.showName !== false,
    effects: clone(array(source.effects)),
  };
}

function detachTokenAreaAnchors(scene, token) {
  const tokenId = String(token?.id ?? '');
  if (!tokenId) return scene;
  scene.attackAreas = array(scene.attackAreas).map(area => {
    const anchor = object(area?.anchor);
    const canonical = anchor.type === 'token' && String(anchor.tokenId ?? '') === tokenId;
    if (!canonical) return area;
    const next = clone(area);
    next.anchor = { type: 'free', markerId: null };
    if (token.placement === 'map' && Number.isFinite(Number(token.x)) && Number.isFinite(Number(token.y))) {
      next.origin = { x: Number(token.x), y: Number(token.y) };
    }
    return next;
  });
  return scene;
}

export function listActiveSceneTokens(world) {
  const index = activeSceneIndex(world);
  return clone(array(world.scenes[index]?.tokens));
}

export function getActiveSceneToken(world, tokenId) {
  const index = activeSceneIndex(world);
  const token = array(world.scenes[index]?.tokens)
    .find(item => String(item?.id ?? '') === String(tokenId));
  return token ? clone(token) : null;
}

export function createSceneToken(world, {
  actorId,
  id: tokenId,
  x = 0,
  y = 0,
  featureId = null,
  actorLink = true,
  actorDelta = null,
  texture = null,
  color = null,
  diameterMeters = 1,
  rotation = 0,
  elevationFt = 0,
  hidden = false,
  locked = false,
  showName = true,
  effects = [],
} = {}) {
  const targetActorId = text(actorId).slice(0, 160);
  if (!targetActorId || !actorExists(world, targetActorId)) throw new Error(`Unknown Actor: ${actorId || '(missing)'}`);
  const candidateId = text(tokenId, newTokenId()).slice(0, 160);
  if (!candidateId) throw new Error('Token requires an id');

  let created = null;
  const next = withActiveScene(world, scene => {
    if (tokenIndex(scene, candidateId) >= 0) throw new Error(`Token already exists: ${candidateId}`);
    created = normalizeToken({
      id: candidateId,
      actorId: targetActorId,
      actorLink,
      actorDelta,
      placement: featureId ? 'feature' : 'map',
      x,
      y,
      featureId,
      texture,
      color,
      diameterMeters,
      rotation,
      elevationFt,
      hidden,
      locked,
      showName,
      effects,
    });
    scene.tokens = [...array(scene.tokens), created];
    return scene;
  });
  return { world: next, token: clone(created) };
}

export function moveSceneToken(world, tokenId, { x, y } = {}) {
  let moved = null;
  const next = withActiveScene(world, scene => {
    const { index, token } = requireToken(scene, tokenId);
    moved = normalizeToken({ ...token, placement: 'map', x: finite(x, token.x ?? 0), y: finite(y, token.y ?? 0), featureId: null });
    scene.tokens[index] = moved;
    return scene;
  });
  return { world: next, token: clone(moved) };
}

export function placeSceneTokenInFeature(world, tokenId, featureId) {
  const targetFeatureId = text(featureId).slice(0, 160);
  if (!targetFeatureId) throw new Error('Feature placement requires featureId');
  let placed = null;
  const next = withActiveScene(world, scene => {
    const { index, token } = requireToken(scene, tokenId);
    placed = normalizeToken({ ...token, placement: 'feature', featureId: targetFeatureId, x: null, y: null });
    scene.tokens[index] = placed;
    return scene;
  });
  return { world: next, token: clone(placed) };
}

export function updateSceneToken(world, tokenId, changes = {}) {
  let updated = null;
  const next = withActiveScene(world, scene => {
    const { index, token } = requireToken(scene, tokenId);
    if (changes.actorId !== undefined && String(changes.actorId) !== String(token.actorId)) {
      const actorId = text(changes.actorId).slice(0, 160);
      if (!actorExists(world, actorId)) throw new Error(`Unknown Actor: ${changes.actorId}`);
    }
    const merged = {
      ...token,
      ...clone(object(changes)),
      id: token.id,
      actorId: changes.actorId === undefined ? token.actorId : text(changes.actorId).slice(0, 160),
      actorDelta: changes.actorDelta === undefined ? token.actorDelta : normalizeDelta(changes.actorDelta),
      effects: changes.effects === undefined ? token.effects : clone(array(changes.effects)),
    };
    updated = normalizeToken(merged, { tokenId: token.id, actorId: merged.actorId });
    scene.tokens[index] = updated;
    return scene;
  });
  return { world: next, token: clone(updated) };
}

export function removeSceneToken(world, tokenId) {
  let removed = null;
  const next = withActiveScene(world, scene => {
    const { index, token } = requireToken(scene, tokenId);
    removed = clone(token);
    detachTokenAreaAnchors(scene, token);
    scene.tokens.splice(index, 1);
    return scene;
  });
  return { world: next, token: removed };
}
