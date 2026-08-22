function finiteAnchor(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? Object.freeze([x, y]) : null;
}

function isOpenableFeature(feature) {
  return Boolean(
    feature?.capabilities?.openable
    || feature?.capabilities?.actions?.open
    || feature?.capabilities?.actions?.close,
  );
}

/**
 * Return the map-facing control presentation for a Feature.
 *
 * Openable Features receive a small fixed-screen toggle at their center (or entrance).
 * The configured size is the clickable hit target; the visual glyph stays deliberately
 * smaller so map artwork remains dominant. A map may override presentation with
 * `presentation.control`, or set it to `false` when the Feature should only be operated
 * from the inspector/API.
 */
export function featureControlDescriptor(feature) {
  if (!isOpenableFeature(feature)) return null;
  const configured = feature?.presentation?.control;
  if (configured === false) return null;
  const source = configured && typeof configured === 'object' ? configured : {};
  if (source.enabled === false) return null;

  const type = String(source.type ?? source.kind ?? 'toggle').trim().toLowerCase();
  if (type !== 'toggle') return null;

  const anchor = finiteAnchor(source.anchor ?? source.position ?? feature.center ?? feature.entrance);
  if (!anchor) return null;

  const requestedSize = Number(source.size ?? 24);
  const size = Number.isFinite(requestedSize) ? Math.max(20, Math.min(36, requestedSize)) : 24;
  return Object.freeze({
    type,
    anchor,
    style: String(source.style ?? 'door').trim() || 'door',
    label: String(source.label ?? feature.name ?? feature.id ?? 'Feature'),
    size,
  });
}

export function featureControlAction(featureState) {
  if (!featureState || featureState.destroyed) return null;
  return featureState.open ? 'close' : 'open';
}

export function featureControlTitle(feature, featureState) {
  const name = String(feature?.name ?? feature?.id ?? 'Feature');
  if (!featureState) return name;
  if (featureState.destroyed) return `${name} · 已摧毁`;
  return featureState.open
    ? `${name} · 已打开 · 点击关闭`
    : `${name} · 已关闭 · 点击打开`;
}
