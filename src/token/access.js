import { actorUsesIndependentInstances } from '../actor/classification.js';

export const TOKEN_VISIBILITY_MODES = Object.freeze(['public', 'party', 'gm', 'users']);
const VISIBILITY_MODE_SET = new Set(TOKEN_VISIBILITY_MODES);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function normalizeUserIds(value, { max = 64 } = {}) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const id = String(entry ?? '').trim().slice(0, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= max) break;
  }
  return result;
}

export function defaultTokenVisibility(actor) {
  if (actor?.type === 'pc') return actor.partyId ? 'party' : 'public';
  if (actor?.type === 'summon' && actor.partyId) return 'party';
  return 'gm';
}

export function normalizeTokenVisibility(raw, { actor = null, legacyHidden = false } = {}) {
  const source = object(raw);
  const requestedMode = String(source.mode ?? '').trim();
  const mode = legacyHidden
    ? 'gm'
    : VISIBILITY_MODE_SET.has(requestedMode) ? requestedMode : defaultTokenVisibility(actor);
  return {
    ...clone(source),
    mode,
    userIds: normalizeUserIds(source.userIds),
  };
}

export function normalizeTokenVision(raw, { actor = null } = {}) {
  const source = object(raw);
  const normalizeRange = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const legacy = normalizeRange(source.rangeOverrideMeters);
  const preciseRangeOverrideMeters = Object.hasOwn(source, 'preciseRangeOverrideMeters')
    ? normalizeRange(source.preciseRangeOverrideMeters)
    : legacy;
  let vagueRangeOverrideMeters = Object.hasOwn(source, 'vagueRangeOverrideMeters')
    ? normalizeRange(source.vagueRangeOverrideMeters)
    : legacy;
  if (preciseRangeOverrideMeters !== null && vagueRangeOverrideMeters !== null) {
    vagueRangeOverrideMeters = Math.max(preciseRangeOverrideMeters, vagueRangeOverrideMeters);
  }
  const result = {
    ...clone(source),
    enabled: source.enabled !== false && Boolean(actor),
    preciseRangeOverrideMeters,
    vagueRangeOverrideMeters,
    overrideUserIds: normalizeUserIds(source.overrideUserIds),
  };
  delete result.rangeOverrideMeters;
  return result;
}

export function normalizeTokenAccess(raw = {}, { actor = null } = {}) {
  const source = object(raw);
  const legacyHidden = source.hidden === true;
  const result = {
    controllerUserIds: normalizeUserIds(source.controllerUserIds),
    visibility: normalizeTokenVisibility(source.visibility, { actor, legacyHidden }),
    vision: normalizeTokenVision(source.vision, { actor }),
  };
  if (actorUsesIndependentInstances(actor)) result.actorLink = false;
  return result;
}

export function tokenControllerIds(token) {
  return normalizeUserIds(token?.controllerUserIds);
}

export function tokenControlledByUser(token, actor, user = null, ownershipLevel = () => 'none') {
  if (!user) return false;
  if (tokenControllerIds(token).includes(String(user.id))) return true;
  return actor?.type === 'pc' && ownershipLevel(user, actor.id) === 'owner';
}
