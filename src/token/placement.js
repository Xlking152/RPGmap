function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/**
 * UI placement policy for the current square-grid map shell.
 *
 * Token Runtime intentionally accepts arbitrary world coordinates; this adapter
 * owns the legacy shell's 1 m cell-centre snapping without teaching canonical
 * Token mutation APIs about one particular map UI.
 */
export function snapActorTokenPlacementPoint(api, point = {}) {
  const width = Math.max(1, finite(api?.mapPackage?.width, 1));
  const height = Math.max(1, finite(api?.mapPackage?.height, 1));
  const x = clamp(finite(point.x, 0), 0, width);
  const y = clamp(finite(point.y, 0), 0, height);
  return Object.freeze({
    x: clamp(Math.floor(x) + 0.5, 0.5, Math.max(0.5, width - 0.5)),
    y: clamp(Math.floor(y) + 0.5, 0.5, Math.max(0.5, height - 0.5)),
  });
}

export function inspectActorTokenPlacement(api, point = {}, { tokenId = null } = {}) {
  const snapped = snapActorTokenPlacementPoint(api, point);
  const placementTokenId = tokenId == null ? null : String(tokenId).trim() || null;
  const inspection = api?.inspectTokenPlacement?.(placementTokenId, snapped) || { valid: true };
  return Object.freeze({
    point: snapped,
    valid: inspection?.valid !== false,
    inspection,
  });
}

/**
 * Create one canonical Scene Token for an existing World Actor.
 * No Character document is created here; World V2 projects the active Scene
 * back into state.characters[] only for the not-yet-migrated editor shell.
 */
export async function createActorTokenAtPoint(api, actorId, point, options = {}) {
  if (!api?.tokens?.create) throw new Error('Actor Token placement requires api.tokens.create()');
  const targetActorId = String(actorId || '').trim();
  if (!targetActorId) throw new Error('Actor Token placement requires actorId');

  const placement = inspectActorTokenPlacement(api, point);
  if (!placement.valid) return Object.freeze({ ok: false, token: null, ...placement });

  const token = await api.tokens.create({
    actorId: targetActorId,
    x: placement.point.x,
    y: placement.point.y,
    actorLink: options.actorLink !== false,
    actorDelta: options.actorDelta ?? null,
    diameterMeters: options.diameterMeters ?? 1,
    rotation: options.rotation ?? 0,
    elevationFt: options.elevationFt ?? 0,
    hidden: options.hidden === true,
    locked: options.locked === true,
    showName: options.showName !== false,
    effects: Array.isArray(options.effects) ? options.effects : [],
  });

  return Object.freeze({ ok: true, token, ...placement });
}

/**
 * Reposition an existing canonical Scene Token without touching the temporary
 * Character projection. The current Token id is supplied to the placement
 * inspector so navigation can ignore the mover's own occupied cell.
 */
export async function relocateActorTokenAtPoint(api, tokenId, point) {
  if (!api?.tokens?.get || !api?.tokens?.move) {
    throw new Error('Actor Token relocation requires api.tokens.get() + api.tokens.move()');
  }
  const targetTokenId = String(tokenId || '').trim();
  if (!targetTokenId) throw new Error('Actor Token relocation requires tokenId');
  if (!api.tokens.get(targetTokenId)) throw new Error(`Unknown Token: ${targetTokenId}`);

  const placement = inspectActorTokenPlacement(api, point, { tokenId: targetTokenId });
  if (!placement.valid) return Object.freeze({ ok: false, token: null, ...placement });

  const token = await api.tokens.move(targetTokenId, placement.point);
  return Object.freeze({ ok: true, token, ...placement });
}
