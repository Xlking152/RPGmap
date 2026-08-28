import { normalizeActorDocument } from '../actor/index.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

function diffValue(base, current) {
  if (same(base, current)) return undefined;
  if (Array.isArray(current)) return clone(current);
  if (!isObject(current)) return clone(current);

  const result = {};
  const baseObject = isObject(base) ? base : {};
  for (const [key, value] of Object.entries(current)) {
    const difference = diffValue(baseObject[key], value);
    if (difference !== undefined) result[key] = difference;
  }
  return Object.keys(result).length ? result : undefined;
}

export function mergeActorDelta(baseActor, actorDelta) {
  if (!baseActor || typeof baseActor !== 'object') throw new Error('Synthetic Actor requires a Base Actor');
  const merged = mergeValue(baseActor, object(actorDelta));
  // A Token delta may customize instance data but never changes which World
  // Actor is its template. Keep the canonical Actor id invariant intact.
  merged.id = baseActor.id;
  return merged;
}

export function createActorDelta(baseActor, resolvedActor) {
  if (!baseActor || typeof baseActor !== 'object') throw new Error('ActorDelta requires a Base Actor');
  if (!resolvedActor || typeof resolvedActor !== 'object') throw new Error('ActorDelta requires a resolved Actor');
  const delta = object(diffValue(baseActor, resolvedActor));
  // Never persist identity rebinding in a Token delta.
  delete delta.id;
  return delta;
}

export function resolveTokenActor(world, tokenId) {
  const scenes = Array.isArray(world?.scenes) ? world.scenes : [];
  const scene = scenes.find(item => String(item?.id ?? '') === String(world?.activeSceneId ?? ''));
  if (!scene) throw new Error(`World has no active Scene: ${world?.activeSceneId || '(missing)'}`);
  const token = (scene.tokens || []).find(item => String(item?.id ?? '') === String(tokenId));
  if (!token) throw new Error(`Unknown Token: ${tokenId}`);
  const rawBaseActor = (world?.actors || []).find(actor => String(actor?.id ?? '') === String(token.actorId));
  if (!rawBaseActor) throw new Error(`Token ${tokenId} references missing Actor: ${token.actorId}`);

  const synthetic = token.actorLink === false;
  const baseActor = normalizeActorDocument(rawBaseActor);
  const actor = synthetic
    ? normalizeActorDocument(mergeActorDelta(rawBaseActor, token.actorDelta))
    : baseActor;
  return {
    token: clone(token),
    baseActor: clone(baseActor),
    actor: clone(actor),
    synthetic,
    actorLink: !synthetic,
  };
}

export function mergeActorDeltaPatch(currentDelta, patch) {
  return mergeValue(object(currentDelta), object(patch));
}
