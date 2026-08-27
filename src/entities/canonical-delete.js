function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function id(value) {
  return String(value ?? '').trim();
}

function detachAreaAnchors(scene, removedTokens) {
  const tokenById = new Map(removedTokens.map(token => [String(token.id), token]));
  scene.attackAreas = array(scene.attackAreas).map(area => {
    const anchor = object(area?.anchor);
    if (anchor.type !== 'character') return area;
    const token = tokenById.get(id(anchor.tokenId ?? anchor.characterId));
    if (!token) return area;
    const next = clone(area);
    next.anchor = { type: 'free', markerId: null };
    if (token.placement === 'map' && Number.isFinite(Number(token.x)) && Number.isFinite(Number(token.y))) {
      next.origin = { x: Number(token.x), y: Number(token.y) };
    }
    return next;
  });
}

export function listWorldActorTokens(world, actorId) {
  const target = id(actorId);
  if (!target) return [];
  return array(world?.scenes).flatMap(scene => array(scene?.tokens)
    .filter(token => id(token?.actorId) === target)
    .map(token => ({ sceneId: id(scene?.id), token: clone(token) })));
}

export function removeActorAndTokensFromWorld(world, actorId) {
  const target = id(actorId);
  if (!target) throw new Error('Actor deletion requires actorId');
  const next = clone(world);
  const actorIndex = array(next?.actors).findIndex(actor => id(actor?.id) === target);
  if (actorIndex < 0) throw new Error(`Unknown Actor: ${actorId}`);

  const actor = clone(next.actors[actorIndex]);
  const removedTokens = [];
  for (const scene of array(next.scenes)) {
    const sceneTokens = array(scene.tokens);
    const removed = sceneTokens.filter(token => id(token?.actorId) === target);
    if (!removed.length) continue;
    removed.forEach(token => removedTokens.push({ sceneId: id(scene.id), token: clone(token) }));
    detachAreaAnchors(scene, removed);
    scene.tokens = sceneTokens.filter(token => id(token?.actorId) !== target);
  }

  next.actors.splice(actorIndex, 1);
  next.updatedAt = new Date().toISOString();
  return { world: next, actor, tokens: removedTokens };
}

export async function deleteCanonicalToken(api, tokenId) {
  if (!api?.tokens?.get || !api?.tokens?.remove) {
    throw new Error('Canonical Token deletion requires api.tokens.get()/remove()');
  }
  const current = api.tokens.get(tokenId);
  if (!current) return null;
  const removed = await api.tokens.remove(current.id);
  api.selection?.remove?.([removed.id]);
  return removed;
}

export async function deleteCanonicalActor(api, actorId) {
  if (!api?.world?.get || !api?.world?.commit) {
    throw new Error('Canonical Actor deletion requires World V2');
  }
  const result = removeActorAndTokensFromWorld(api.world.get(), actorId);
  await api.world.commit(result.world, {
    source: 'world-v2:actor.remove',
    reason: 'actor.remove',
    render: true,
  });

  const removedIds = result.tokens.map(entry => entry.token.id);
  api.selection?.remove?.(removedIds);

  for (const entry of result.tokens) {
    api.emit?.('token:delete', {
      id: entry.token.id,
      tokenId: entry.token.id,
      actorId: entry.token.actorId,
      sceneId: entry.sceneId,
      token: clone(entry.token),
      actorDelete: true,
    });
  }
  api.emit?.('actor:delete', {
    id: result.actor.id,
    actorId: result.actor.id,
    actor: clone(result.actor),
    tokenIds: removedIds,
  });
  return result;
}
