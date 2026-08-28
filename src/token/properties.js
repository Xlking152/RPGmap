import {
  normalizeElevationFt,
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
    hidden: token.hidden === true,
    diameterMeters: normalizeTokenDiameterMeters(token.diameterMeters, 1),
    rotation: normalizeTokenRotation(token.rotation, 0),
    elevationFt: normalizeElevationFt(token.elevationFt, 0),
    locked: token.locked === true,
    showName: token.showName !== false,
  });
}

export async function setTokenHidden(api, value, hidden, options = {}) {
  return update(api, value, { hidden: hidden === true }, options);
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

export async function setTokenElevationFt(api, value, elevationFt, options = {}) {
  const { token } = requireToken(api, value);
  return update(api, value, {
    elevationFt: normalizeElevationFt(elevationFt, token.elevationFt),
  }, options);
}
