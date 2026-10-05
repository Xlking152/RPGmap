// Independent server projection implementation before deferred shell preparation.
export function createPreviousProjectionFunctions({ sessions = new Map(), audienceStateFor, projectMotionForSession,
  createFogDocumentChanges, createDocumentChanges, sendSocket, rememberResumeCommit, committedPatches = new WeakMap(),
  describeVisionForToken, structuredClone = globalThis.structuredClone } = {}) {
function lightweightProjectionShell(state) {
  const preferences = { ...(state?.preferences || {}) };
  const worldState = preferences.worldV2 || {};
  preferences.worldV2 = {
    ...worldState,
    actors: [...(worldState.actors || [])],
    scenes: [...(worldState.scenes || [])],
  };
  preferences.entitySystem = { ...(preferences.entitySystem || {}) };
  return { ...state, preferences };
}

function canonicalWorldScene(state, sceneId) {
  return (state?.preferences?.worldV2?.scenes || [])
    .find(scene => String(scene?.id || '') === String(sceneId || '')) || null;
}

function movementProjectionTargets(state, operations) {
  const activeSceneId = String(state?.preferences?.worldV2?.activeSceneId || '');
  const targets = new Map();
  let movement = false;
  for (const operation of operations) {
    if (operation.type === 'scene.fog.explore') continue;
    if (!['token.move', 'token.movePath', 'token.reposition'].includes(operation.type)) return null;
    movement = true;
    const sceneId = String(operation.payload?.sceneId || activeSceneId);
    const ids = operation.type === 'token.movePath'
      ? operation.payload?.tokenIds || []
      : [operation.payload?.tokenId];
    if (!targets.has(sceneId)) targets.set(sceneId, new Set());
    for (const tokenId of ids) targets.get(sceneId).add(String(tokenId || ''));
  }
  return movement ? targets : null;
}

function projectedFogAfterMovement(previous, canonical, partyIds = []) {
  const visiblePartyIds = [...new Set([
    ...Object.keys(previous?.exploredByParty || {}),
    ...partyIds.map(String),
  ])];
  const exploredByParty = Object.fromEntries(visiblePartyIds.flatMap(partyId => {
    const value = canonical?.exploredByParty?.[partyId];
    return value ? [[partyId, value]] : [];
  }));
  return { ...(previous || {}), exploredByParty };
}

function tryIncrementalAudienceProjection(session, beforeProjection, afterState, operations, results, beforeState = null) {
  if (!beforeProjection || session.role === 'gm' || !Array.isArray(operations) || !operations.length) return null;
  const types = new Set(operations.map(operation => String(operation?.type || '')));
  const next = lightweightProjectionShell(beforeProjection);
  const projectedWorld = next.preferences.worldV2;
  projectedWorld.updatedAt = String(afterState?.preferences?.worldV2?.updatedAt || projectedWorld.updatedAt || '');
  if ([...types].every(type => type === 'scene.fog.explore')) {
    const partyIds = next.preferences.audienceVision?.partyIds || [];
    projectedWorld.scenes = projectedWorld.scenes.map(scene => {
      const canonical = canonicalWorldScene(afterState, scene.id);
      return canonical ? { ...scene, fog: projectedFogAfterMovement(scene.fog, canonical.fog, partyIds) } : scene;
    });
    return next;
  }

  if ([...types].every(type => type === 'chat.append')) {
    const chatIds = new Set((results || []).map(result => String(result?.chatId || '')).filter(Boolean));
    const appended = (afterState?.preferences?.chatSystem?.messages || [])
      .filter(message => chatIds.has(String(message?.id || '')));
    // Player chat has no entity-bearing data. Protected GM event data still
    // uses the full projection so hidden Actor/Token references are filtered.
    if (appended.length !== chatIds.size || appended.some(message => message?.data != null)) return null;
    next.preferences.chatSystem = {
      ...(beforeProjection.preferences?.chatSystem || {}),
      messages: [
        ...(beforeProjection.preferences?.chatSystem?.messages || []),
        ...appended.map(message => structuredClone(message)),
      ],
    };
    return next;
  }

  const movementTargets = movementProjectionTargets(afterState, operations);
  if (movementTargets) {
    const activeSceneId = String(projectedWorld.activeSceneId || '');
    const sourceId = String(session.visionSourceTokenId || '');
    const sourceMoved = movementTargets.get(activeSceneId)?.has(sourceId) === true;
    if (sourceMoved) {
      const projectedScene = canonicalWorldScene(beforeProjection, activeSceneId);
      const canonicalScene = canonicalWorldScene(afterState, activeSceneId);
      const projectedTokens = new Map((projectedScene?.tokens || []).map(token => [String(token?.id || ''), token]));
      const allTokensPrivate = (canonicalScene?.tokens || []).every(token => {
        const projected = projectedTokens.get(String(token?.id || ''));
        return projected && projected.audienceRestricted !== true && projected.audienceVisibility !== 'vague';
      });
      if (!allTokensPrivate) return null;
    }
    const pending = new Set([...movementTargets].flatMap(([sceneId, ids]) =>
      [...ids].map(tokenId => `${sceneId}:${tokenId}`)));
    for (const [sceneIndex, scene] of projectedWorld.scenes.entries()) {
      const canonical = canonicalWorldScene(afterState, scene.id);
      if (!canonical) return null;
      const movedIds = movementTargets.get(String(scene.id)) || new Set();
      let changed = false;
      const tokens = (scene.tokens || []).map(token => {
        const tokenId = String(token?.id || '');
        if (!movedIds.has(tokenId)) return token;
        if (token.audienceRestricted === true || token.audienceVisibility === 'vague') return token;
        const authoritative = (canonical.tokens || []).find(item => String(item?.id || '') === String(token.id));
        if (!authoritative) return token;
        pending.delete(`${scene.id}:${tokenId}`);
        changed = true;
        return structuredClone(authoritative);
      });
      const fog = canonicalWorldScene(beforeState, scene.id)?.fog === canonical.fog ? scene.fog
        : projectedFogAfterMovement(scene.fog, canonical.fog, next.preferences.audienceVision?.partyIds || []);
      if (!changed && (fog === scene.fog || JSON.stringify(fog) === JSON.stringify(scene.fog))) continue;
      const attackAreas = (scene.attackAreas || []).map(area => {
        if (!movedIds.has(String(area?.anchor?.tokenId || ''))) return area;
        return structuredClone((canonical.attackAreas || []).find(item => String(item?.id || '') === String(area?.id || '')) || area);
      });
      projectedWorld.scenes[sceneIndex] = { ...scene, tokens, attackAreas, fog };
      if (String(projectedWorld.activeSceneId || '') === String(scene.id)) {
        next.preferences.entitySystem = { ...next.preferences.entitySystem, tokens: [...tokens] };
        next.attackAreas = [...attackAreas];
      }
    }
    if (pending.size) return null;
    if (sourceMoved) {
      const source = describeVisionForToken(afterState, sourceId);
      if (!source) return null;
      next.preferences.audienceVision = {
        ...next.preferences.audienceVision,
        source: {
          ...next.preferences.audienceVision?.source,
          tokenId: source.tokenId,
          x: source.x,
          y: source.y,
          elevationMeters: source.elevationMeters,
          rangeMeters: source.preciseRangeMeters,
          preciseRangeMeters: source.preciseRangeMeters,
          vagueRangeMeters: source.vagueRangeMeters,
          preciseGroundRangeMeters: source.preciseGroundRangeMeters,
          vagueGroundRangeMeters: source.vagueGroundRangeMeters,
          senses: structuredClone(source.senses || {}),
          lighting: source.lighting,
        },
      };
    }
    return next;
  }

  if ([...types].every(type => type.startsWith('status.')) && !types.has('status.definition.upsert')
    && !types.has('status.definition.delete') && !types.has('status.definition.import')) {
    const actorIds = new Set();
    const tokenIds = new Set();
    for (const operation of operations) {
      const payload = operation.payload || {};
      const scope = String(payload.scope || payload.target?.scope || '');
      const targetId = String(payload.targetId || payload.target?.targetId || '');
      if (scope === 'actor' && targetId) actorIds.add(targetId);
      else if (['token', 'syntheticActor'].includes(scope) && targetId) tokenIds.add(targetId);
      else return null;
    }
    const canonicalWorld = afterState?.preferences?.worldV2;
    const definitions = new Map((canonicalWorld?.statusDefinitions || []).map(definition => [String(definition.id), definition]));
    if (operations.some(operation => {
      const definition = definitions.get(String(operation.payload?.statusId || operation.payload?.definitionId || ''));
      return definition?.capabilities?.visibility !== undefined || definition?.capabilities?.visionPrecision !== undefined;
    })) return null;
    for (const actorId of actorIds) {
      if (session.visionSourceTokenId) {
        const source = canonicalWorldScene(afterState, canonicalWorld?.activeSceneId)?.tokens
          ?.find(token => String(token?.id || '') === String(session.visionSourceTokenId));
        if (String(source?.actorId || '') === actorId) return null;
      }
      // An Observer can read an Actor template while its hostile Tokens are
      // still cropped by perception. A template status may hide, reveal or
      // change public badges on those linked Tokens, not just the Actor body.
      for (const scene of canonicalWorld?.scenes || []) {
        const prior = new Map((canonicalWorldScene(beforeProjection, scene.id)?.tokens || [])
          .map(token => [String(token.id), token]));
        if ((scene.tokens || []).some(token => String(token.actorId) === actorId && token.actorLink !== false
          && (!prior.has(String(token.id)) || prior.get(String(token.id)).audienceRestricted === true
            || prior.get(String(token.id)).audienceVisibility === 'vague'))) return null;
      }
      const index = projectedWorld.actors.findIndex(actor => String(actor?.id || '') === actorId);
      const current = projectedWorld.actors[index];
      const authoritative = (canonicalWorld?.actors || []).find(actor => String(actor?.id || '') === actorId);
      if (index < 0 || current?.audienceRestricted === true || !authoritative) return null;
      projectedWorld.actors[index] = structuredClone(authoritative);
    }
    for (const tokenId of tokenIds) {
      if (String(session.visionSourceTokenId || '') === tokenId) return null;
      let found = false;
      for (const [sceneIndex, scene] of projectedWorld.scenes.entries()) {
        const index = (scene.tokens || []).findIndex(token => String(token?.id || '') === tokenId);
        if (index < 0) continue;
        const current = scene.tokens[index];
        const authoritative = canonicalWorldScene(afterState, scene.id)?.tokens
          ?.find(token => String(token?.id || '') === tokenId);
        if (current?.audienceRestricted === true || !authoritative) return null;
        const tokens = [...scene.tokens];
        tokens[index] = structuredClone(authoritative);
        projectedWorld.scenes[sceneIndex] = { ...scene, tokens };
        if (String(projectedWorld.activeSceneId || '') === String(scene.id)) {
          next.preferences.entitySystem = { ...next.preferences.entitySystem, tokens: [...tokens] };
        }
        found = true;
        break;
      }
      if (!found) return null;
    }
    if (actorIds.size) {
      next.preferences.entitySystem = {
        ...next.preferences.entitySystem,
        actors: [...projectedWorld.actors],
      };
    }
    return next;
  }
  return null;
}


function broadcastOperationCommit({ beforeState, afterState, operationId, baseRevision, revision, updatedAt, results, originSessionId, operations = [], documentBatch = false, onOriginProjection = null }) {
  const fog = results.filter(result => Object.hasOwn(result, 'dirtyBounds'));
  const fogOnly = operations.length && operations.every(operation => operation.type === 'scene.fog.explore');
  const recipients = [...sessions];
  const originIndex = recipients.findIndex(([, session]) => session.id === originSessionId);
  if (originIndex > 0) recipients.unshift(...recipients.splice(originIndex, 1));
  for (const [socket, session] of recipients) {
    if (session.role !== 'gm' && session.identityStatus !== 'active') continue;
    const beforeProjection = session.audienceProjection || audienceStateFor(session, beforeState);
    const incrementalProjection = tryIncrementalAudienceProjection(
      session, beforeProjection, afterState, operations, results, beforeState,
    );
    const pureMovement = operations.length && operations.every(operation => ['token.move', 'token.movePath', 'token.reposition'].includes(operation.type))
      && results.every(result => ['token.move', 'token.movePath', 'token.reposition'].includes(result.action));
    const afterProjection = incrementalProjection || audienceStateFor(session, afterState, pureMovement ? {
      movementCache: { beforeState, previousProjection: beforeProjection,
        tokenIds: new Set(results.flatMap(result => result.tokenIds || [result.tokenId]).map(String)) },
    } : {});
    session.audienceProjection = afterProjection;
    const motion = documentBatch
      ? projectMotionForSession(results, beforeProjection, afterProjection, session)
      : [];
    const response = {
      type: documentBatch ? 'document.batch.committed' : 'world.operation.committed', operationId, baseRevision, revision, updatedAt,
      changes: fogOnly ? createFogDocumentChanges(beforeProjection, afterProjection, { fog })
        : createDocumentChanges(beforeProjection, afterProjection, null, { motion, fog }),
      ...(motion.length ? { motion } : {}),
      originSessionId,
      audienceRevision: session.audienceRevision,
    };
    sendSocket(socket, response);
    if (session.id === originSessionId) onOriginProjection?.(afterProjection);
  }
  rememberResumeCommit({
    beforeState, afterState, operationId, baseRevision, revision, updatedAt,
    results, originSessionId, documentBatch, fog, patch: committedPatches.get(afterState),
  });
}
return { tryIncrementalAudienceProjection, broadcastOperationCommit, movementProjectionTargets };
}
