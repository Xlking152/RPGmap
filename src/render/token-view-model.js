import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { normalizeTokenRotation } from '../token/properties.js';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function safeColor(value, fallback = '#3d9b63') {
  const color = text(value);
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

export function actorDisplayForm(actor) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  return forms.find(form => String(form?.id ?? '') === String(actor?.currentFormId ?? '')) || forms[0] || null;
}

/**
 * Build the map-facing display model from a canonical Scene Token plus its
 * resolved Actor (Base Actor for linked Tokens; Synthetic Actor for unlinked
 * Tokens). Character compatibility projection is intentionally not accepted.
 */
export function createTokenViewModel({ token, actor, selected = false } = {}) {
  if (!token || !actor || token.hidden === true || token.placement !== 'map') return null;
  const x = finite(token.x);
  const y = finite(token.y);
  if (x === null || y === null) return null;

  const form = actorDisplayForm(actor);
  const name = text(actor.name, text(token.name, String(token.id || 'Token')));
  const avatarDataUrl = text(
    form?.avatarDataUrl ?? actor?.avatarDataUrl ?? actor?.img,
    '',
  ) || null;
  const color = safeColor(
    form?.tokenAppearance?.color ?? actor?.prototypeToken?.color ?? token?.color,
  );

  return Object.freeze({
    id: String(token.id),
    actorId: String(token.actorId),
    x,
    y,
    name,
    avatarDataUrl,
    color,
    diameterMeters: tokenDiameterMeters(token),
    rotation: normalizeTokenRotation(token.rotation, 0),
    elevationFt: tokenElevationFt(token),
    showName: token.showName !== false,
    selected: Boolean(selected),
    actorLink: token.actorLink !== false,
  });
}
