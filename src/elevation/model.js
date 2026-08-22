function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number) && number >= 0) return number;
  const fallbackNumber = Number(fallback);
  return Number.isFinite(fallbackNumber) && fallbackNumber >= 0 ? fallbackNumber : 0;
}

function optionalFiniteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeElevationFt(value, fallback = 0) {
  return finiteNonNegative(value, fallback);
}

export function normalizeBlockingHeightFt(value, fallback = null) {
  const normalized = optionalFiniteNonNegative(value);
  if (normalized !== null) return normalized;
  return optionalFiniteNonNegative(fallback);
}

export function entityStateFromAppState(state) {
  const entityState = state?.preferences?.entitySystem;
  return entityState && typeof entityState === 'object'
    ? entityState
    : { actors: [], tokens: [] };
}

export function tokenForCharacter(state, characterId) {
  const id = String(characterId ?? '');
  if (!id) return null;
  return (entityStateFromAppState(state).tokens || []).find((token) => (
    String(token?.characterId ?? token?.id ?? '') === id
  )) || null;
}

export function actorForCharacter(state, characterId) {
  const token = tokenForCharacter(state, characterId);
  if (!token?.actorId) return null;
  return (entityStateFromAppState(state).actors || []).find((actor) => (
    String(actor?.id ?? '') === String(token.actorId)
  )) || null;
}

export function tokenElevationFt(tokenOrState, characterId = null) {
  const token = characterId === null
    ? tokenOrState
    : tokenForCharacter(tokenOrState, characterId);
  return normalizeElevationFt(token?.elevationFt, 0);
}

export function featureBlockingHeightFt(feature, featureState = null) {
  const override = featureState?.custom?.blockingHeightFt;
  if (override !== undefined && override !== null && override !== '') {
    const normalizedOverride = normalizeBlockingHeightFt(override);
    if (normalizedOverride !== null) return normalizedOverride;
  }
  return normalizeBlockingHeightFt(
    feature?.capabilities?.navigation?.blockingHeightFt
      ?? feature?.navigation?.blockingHeightFt,
  );
}

/**
 * Generic 2.5D obstacle rule.
 *
 * A Feature without a declared finite blocking height behaves like the legacy
 * 2D obstacle and always blocks. For a height-aware Feature, strict greater
 * than is required to clear it: elevationFt === blockingHeightFt still blocks.
 */
export function featureBlocksMover(feature, featureState = null, moverContext = null) {
  const navigation = feature?.capabilities?.navigation || feature?.navigation;
  if (!navigation?.blocks) return false;
  const blockingHeight = featureBlockingHeightFt(feature, featureState);
  if (blockingHeight === null) return true;
  const elevationFt = normalizeElevationFt(moverContext?.elevationFt, 0);
  return elevationFt <= blockingHeight;
}

export function formatFt(value) {
  const normalized = normalizeElevationFt(value, 0);
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(1).replace(/\.0$/, '');
}
