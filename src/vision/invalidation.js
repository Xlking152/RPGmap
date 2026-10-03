const CHANGE_KEYS = new Set(['actors', 'tokens', 'scenes', 'featureStates', 'fog',
  'sceneContent', 'collections', 'statusDefinitionsChanged', 'combatChanged', 'chat']);
const COLLECTION_TYPES = new Set(['Actor', 'Token', 'Scene', 'StatusDefinition', 'Journal',
  'Marker', 'AttackArea', 'SceneEvent', 'OcclusionShape', 'ChatMessage']);
const TOKEN_FIELDS = new Set(['id', 'name', 'actorId', 'actorLink', 'actorDelta', 'placement',
  'x', 'y', 'featureId', 'texture', 'color', 'diameterMeters', 'rotation', 'elevationMeters',
  'movement', 'light', 'controllerUserIds', 'visibility', 'vision', 'locked', 'showName', 'effects']);
const SOURCE_FIELDS = ['actorId', 'actorLink', 'actorDelta', 'placement', 'x', 'y', 'featureId',
  'elevationMeters', 'vision', 'effects', 'controllerUserIds', 'visibility'];

// Committed runtime snapshots are copy-on-write. Identity handles unchanged
// branches; equality also supports normalized snapshots and equivalent Fog deltas.
function visionValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && visionValuesEqual(left[key], right[key]));
}

export function visionScene(state) {
  const world = state?.preferences?.worldV2;
  return world?.scenes?.find(scene => String(scene?.id ?? '') === String(world?.activeSceneId ?? '')) || null;
}

function tokenIn(scene, id) {
  return id ? scene?.tokens?.find(token => String(token.id) === String(id)) || null : null;
}

function actorFor(state, token) {
  return token && state?.preferences?.worldV2?.actors?.find(actor => String(actor.id) === String(token.actorId)) || null;
}

export function tokenVisionLight(token) {
  if (token?.placement !== 'map' || token?.light?.enabled !== true
    || !(Number(token.light.rangeMeters) > 0)) return null;
  return { ...token.light, x: token.x, y: token.y,
    elevationMeters: (Number(token.elevationMeters) || 0) + (Number(token.light.elevationOffsetMeters) || 0) };
}

export function visionStatusTargets(detail = {}) {
  const tokenIds = [], actorIds = [];
  let known = false;
  for (const [field, target] of [['tokenIds', tokenIds], ['actorIds', actorIds]]) {
    if (detail[field] === undefined) continue;
    if (!Array.isArray(detail[field])) return null;
    known = true; target.push(...detail[field]);
  }
  if (detail.tokenId) { known = true; tokenIds.push(detail.tokenId); }
  if (detail.actorId) { known = true; actorIds.push(detail.actorId); }
  if (detail.snapshots !== undefined) {
    if (!Array.isArray(detail.snapshots) || detail.snapshots.some(snapshot => !snapshot?.tokenId)) return null;
    known = true; tokenIds.push(...detail.snapshots.map(snapshot => snapshot.tokenId));
  }
  if (detail.payload?.operations !== undefined && (!Array.isArray(detail.payload.operations)
    || detail.payload.operations.some(target => !target?.targetId
      || !['actor', 'token', 'syntheticActor'].includes(target.scope)))) return null;
  const targets = [detail, detail.payload, ...(detail.payload?.operations || [])];
  for (const target of targets) {
    if (!target?.targetId) continue;
    if (!['actor', 'token', 'syntheticActor'].includes(target.scope)) return null;
    known = true;
    (target.scope === 'actor' ? actorIds : tokenIds).push(target.targetId);
  }
  return known ? { tokenIds, actorIds } : null;
}

function parties(state, token, connected) {
  if (connected) return state?.preferences?.audienceVision?.partyIds || [];
  const actor = actorFor(state, token);
  return actor?.partyId ? [String(actor.partyId)] : [];
}

function fogMetadata(fog) {
  return Object.fromEntries(Object.entries(fog || {}).filter(([key]) => key !== 'exploredByParty'));
}

function fullInvalidation() {
  return { render: true, sourceChanged: true, spatialChanged: true, exploredChanged: true,
    resetVisibility: true, dirtyBounds: null, unknown: true };
}

function mergeBounds(left, right) {
  if (!left || !right) return null;
  return { minX: Math.min(left.minX, right.minX), minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX), maxY: Math.max(left.maxY, right.maxY) };
}

// Classify a complete authoritative changeSet against the previous canonical
// snapshot. In particular, deleted/disabled lights must be read from BEFORE.
// Missing or future change formats conservatively invalidate every derived layer.
export function classifyVisionChange({ beforeState, afterState, changeSet, sourceTokenId = null,
  previousSourceTokenId = sourceTokenId, connected = false } = {}) {
  if (!changeSet || typeof changeSet !== 'object' || Array.isArray(changeSet)
    || Object.keys(changeSet).some(key => !CHANGE_KEYS.has(key))) return fullInvalidation();
  for (const key of ['tokens', 'featureStates', 'fog', 'sceneContent', 'collections']) {
    if (changeSet[key] !== undefined && !Array.isArray(changeSet[key])) return fullInvalidation();
  }
  if ((changeSet.tokens || []).some(entry => !entry || typeof entry !== 'object'
    || ['upsertIds', 'removeIds'].some(key => entry[key] !== undefined && !Array.isArray(entry[key]))
    || Object.values(entry.fields || {}).some(fields => !Array.isArray(fields)))) return fullInvalidation();
  if (['featureStates', 'fog'].some(key => (changeSet[key] || []).some(entry => !entry || typeof entry !== 'object'))) {
    return fullInvalidation();
  }
  const before = visionScene(beforeState), after = visionScene(afterState);
  const result = { render: false, sourceChanged: false, spatialChanged: false,
    exploredChanged: false, resetVisibility: false, dirtyBounds: null, unknown: false };
  if (!before || !after || String(before.id) !== String(after.id)
    || String(previousSourceTokenId || '') !== String(sourceTokenId || '')) return fullInvalidation();
  const sceneId = String(after.id);
  const active = entry => !entry?.sceneId || String(entry.sceneId) === sceneId;
  const beforeToken = tokenIn(before, previousSourceTokenId), afterToken = tokenIn(after, sourceTokenId);
  result.sourceChanged = Boolean(beforeToken) !== Boolean(afterToken)
    || SOURCE_FIELDS.some(field => !visionValuesEqual(beforeToken?.[field], afterToken?.[field]))
    || !visionValuesEqual(actorFor(beforeState, beforeToken), actorFor(afterState, afterToken))
    || (changeSet.statusDefinitionsChanged === true && Boolean(beforeToken || afterToken));
  result.resetVisibility = Boolean(beforeToken) !== Boolean(afterToken)
    || beforeToken?.actorId !== afterToken?.actorId || beforeToken?.placement !== afterToken?.placement;
  // Audience documents are not included in documentChangeSet. Compare only the
  // small viewer descriptor, never another user's private visibility cache.
  if (connected && !visionValuesEqual(beforeState?.preferences?.audienceVision?.source,
    afterState?.preferences?.audienceVision?.source)) result.sourceChanged = true;
  result.spatialChanged = ['featureStates', 'sceneEvents', 'occlusionShapes', 'mapPackage', 'settings']
    .some(field => !visionValuesEqual(before[field], after[field]));
  for (const entry of changeSet.tokens || []) {
    if (!entry || typeof entry !== 'object') return fullInvalidation();
    if (!active(entry)) continue;
    const ids = [...(entry.upsertIds || []), ...(entry.removeIds || [])];
    for (const id of ids) {
      if (entry.fields?.[id]?.some(field => !TOKEN_FIELDS.has(field))) return fullInvalidation();
      if (!visionValuesEqual(tokenVisionLight(tokenIn(before, id)), tokenVisionLight(tokenIn(after, id)))) {
        result.spatialChanged = true;
      }
    }
  }
  for (const entry of changeSet.sceneContent || []) {
    if (!entry || !Array.isArray(entry.types)) return fullInvalidation();
    if (active(entry) && entry.types.some(type => !['Marker', 'AttackArea', 'SceneEvent', 'OcclusionShape'].includes(type))) {
      return fullInvalidation();
    }
  }
  for (const entry of changeSet.collections || []) {
    if (!entry || !COLLECTION_TYPES.has(entry.type)) return fullInvalidation();
    if (active(entry) && ['SceneEvent', 'OcclusionShape'].includes(entry.type)) result.spatialChanged = true;
    if (active(entry) && entry.type === 'Token' && !visionValuesEqual(
      (before.tokens || []).map(tokenVisionLight).filter(Boolean),
      (after.tokens || []).map(tokenVisionLight).filter(Boolean))) result.spatialChanged = true;
  }
  const beforeParties = parties(beforeState, beforeToken, connected), afterParties = parties(afterState, afterToken, connected);
  const partyChanged = !visionValuesEqual(beforeParties, afterParties);
  const fogMetadataChanged = !visionValuesEqual(fogMetadata(before.fog), fogMetadata(after.fog));
  result.exploredChanged = partyChanged || fogMetadataChanged
    || afterParties.some(partyId => !visionValuesEqual(before.fog?.exploredByParty?.[String(partyId)],
      after.fog?.exploredByParty?.[String(partyId)]));
  result.render = result.sourceChanged || result.spatialChanged || result.exploredChanged;
  if (result.exploredChanged && !result.sourceChanged && !result.spatialChanged && !partyChanged && !fogMetadataChanged) {
    const entries = (changeSet.fog || []).filter(active);
    if (entries.length) result.dirtyBounds = entries.slice(1)
      .reduce((bounds, entry) => mergeBounds(bounds, entry.dirtyBounds), entries[0].dirtyBounds ?? null);
  }
  return result;
}
