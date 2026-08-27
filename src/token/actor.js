function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeValue(base, delta) {
  if (delta === undefined) return clone(base);
  if (Array.isArray(delta)) return clone(delta);
  if (!isObject(delta)) return clone(delta);

  const result = isObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(delta)) {
    result[key] = mergeValue(result[key], value);
  }
  return result;
}

export function mergeActorDelta(baseActor, actorDelta) {
  if (!baseActor || typeof baseActor !== 'object') throw new Error('Synthetic Actor requires a Base Actor');
  const merged = mergeValue(baseActor, object(actorDelta));
  // A Token delta may customize instance data but never changes which World
  // Actor is its template. Keep the canonical Actor id invariant intact.
  merged.id = baseActor.id;
  return merged;
}

export function resolveTokenActor(world, tokenId) {
  const scenes = Array.isArray(world?.scenes) ? world.scenes : [];
  const scene = scenes.find(item => String(item?.id ?? '') === String(world?.activeSceneId ?? ''));
  if (!scene) throw new Error(`World has no active Scene: ${world?.activeSceneId || '(missing)'}`);
  const token = (scene.tokens || []).find(item => String(item?.id ?? '') === String(tokenId));
  if (!token) throw new Error(`Unknown Token: ${tokenId}`);
  const baseActor = (world?.actors || []).find(actor => String(actor?.id ?? '') === String(token.actorId));
  if (!baseActor) throw new Error(`Token ${tokenId} references missing Actor: ${token.actorId}`);

  const synthetic = token.actorLink === false;
  return {
    token: clone(token),
    baseActor: clone(baseActor),
    actor: synthetic ? mergeActorDelta(baseActor, token.actorDelta) : clone(baseActor),
    synthetic,
    actorLink: !synthetic,
  };
}

export function mergeActorDeltaPatch(currentDelta, patch) {
  return mergeValue(object(currentDelta), object(patch));
}
