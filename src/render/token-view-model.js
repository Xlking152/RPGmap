import { tokenDiameterMeters, tokenElevationFt } from '../elevation/model.js';
import { normalizeTokenRotation } from '../token/properties.js';
import { deriveActorDocument, describeActor } from '../actor/index.js';

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

export function actorDisplayForm(actor, { ruleset } = {}) {
  return deriveActorDocument(actor, ruleset ? { ruleset } : {})?.form || null;
}

/**
 * Build the map-facing display model from a canonical Scene Token plus its
 * resolved Actor (Base Actor for linked Tokens; Synthetic Actor for unlinked
 * Tokens). Appearance precedence is explicit Token override -> current Ruleset
 * presentation override -> Core Actor prototype/img fallback.
 */
export function createTokenViewModel({ token, actor, selected = false, ruleset, gmViewer = false, invisible = false } = {}) {
  if (!token || !actor || token.placement !== 'map') return null;
  const x = finite(token.x);
  const y = finite(token.y);
  if (x === null || y === null) return null;

  const presentation = describeActor(actor, ruleset ? { ruleset } : {}) || {};
  const name = text(token.name, text(presentation.name, text(actor.name, String(token.id || 'Token'))));
  const avatarDataUrl = text(
    token?.texture?.src
      ?? presentation.avatarDataUrl
      ?? actor?.prototypeToken?.texture?.src
      ?? actor?.img
      ?? actor?.avatarDataUrl,
    '',
  ) || null;
  const color = safeColor(
    token?.color
      ?? presentation.color
      ?? actor?.prototypeToken?.color,
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
    audienceRestricted: token.audienceRestricted === true || actor.audienceRestricted === true,
    audienceVisibility: token.audienceVisibility || null,
    gmViewer: Boolean(gmViewer),
    gmOnly: token?.visibility?.mode === 'gm',
    invisible: Boolean(invisible),
  });
}
