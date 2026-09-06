import {
  normalizeElevationMeters,
  normalizeTokenDiameterMeters,
} from '../elevation/model.js';

function tokenId(value) {
  return String(value ?? '').trim();
}

export function normalizeTokenRotation(value, fallback = 0) {
  const number = Number(value);
  const fallbackNumber = Number(fallback);
  const source = Number.isFinite(number) ? number : (Number.isFinite(fallbackNumber) ? fallbackNumber : 0);
  return ((source % 360) + 360) % 360;
}

function requireToken(api, value) {
  if (!api?.tokens?.get || !api?.tokens?.update) {
    throw new Error('Token property editing requires canonical Token Runtime V2');
  }
  const id = tokenId(value);
  if (!id) throw new Error('Token property editing requires tokenId');
  const token = api.tokens.get(id);
  if (!token) throw new Error(`Unknown Token: ${id}`);
  return { id, token };
}

async function update(api, value, changes, options = {}) {
  const { id } = requireToken(api, value);
  return api.tokens.update(id, changes, options);
}

export function tokenPropertySnapshot(api, value) {
  const { id, token } = requireToken(api, value);
  return Object.freeze({
    id,
    actorId: String(token.actorId),
    hidden: token.visibility?.mode === 'gm',
    visibility: structuredClone(token.visibility || { mode: 'public', userIds: [] }),
    diameterMeters: normalizeTokenDiameterMeters(token.diameterMeters, 1),
    rotation: normalizeTokenRotation(token.rotation, 0),
    elevationMeters: normalizeElevationMeters(token.elevationMeters, 0),
    locked: token.locked === true,
    showName: token.showName !== false,
  });
}

export async function setTokenHidden(api, value, hidden, options = {}) {
  const { id } = requireToken(api, value);
  await api.world.performOperations([{
    type: 'token.access.patch',
    payload: {
      sceneId: api.world.get().activeSceneId,
      tokenId: id,
      patch: { visibility: { mode: hidden === true ? 'gm' : 'public', userIds: [] } },
    },
  }], { source: 'token.access.patch', ...options });
  return api.tokens.get(id);
}

export async function setTokenDiameterMeters(api, value, diameterMeters, options = {}) {
  const { token } = requireToken(api, value);
  return update(api, value, {
    diameterMeters: normalizeTokenDiameterMeters(diameterMeters, token.diameterMeters),
  }, options);
}

export async function setTokenRotation(api, value, rotation, options = {}) {
  const { token } = requireToken(api, value);
  return update(api, value, {
    rotation: normalizeTokenRotation(rotation, token.rotation),
  }, options);
}

export async function setTokenElevationMeters(api, value, elevationMeters, options = {}) {
  const { id, token } = requireToken(api, value);
  const nextElevation = normalizeElevationMeters(elevationMeters, token.elevationMeters);
  const currentElevation = normalizeElevationMeters(token.elevationMeters, 0);
  if (token.placement === 'map' && api.movement?.moveTokenTo
    && Math.abs(nextElevation - currentElevation) > 1e-9) {
    const verticalAction = currentElevation === 0 && nextElevation > 0 ? 'takeoff'
      : nextElevation === 0 && currentElevation > 0 ? 'landing'
        : null;
    const result = await api.movement.moveTokenTo(id, {
      x: Number(token.x), y: Number(token.y), elevationMeters: nextElevation,
    }, null, { movementMode: 'fly', verticalAction });
    if (!result?.committed) {
      const error = new Error(result?.reason || 'Token elevation movement was rejected');
      error.code = result?.code || 'movement_failed';
      throw error;
    }
    return api.tokens.get(id);
  }
  return update(api, id, { elevationMeters: nextElevation }, options);
}

export const setTokenElevationFt = setTokenElevationMeters;
