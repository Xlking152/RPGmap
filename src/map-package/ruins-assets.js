function invalid(label) {
  throw new TypeError(`Invalid MapPackage: ${label}`);
}

function texture(value, label) {
  if (typeof value === 'string') {
    if (!value.trim()) invalid(`${label} requires a resource URL`);
    return value.trim();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.url !== 'string' || !value.url.trim()) invalid(`${label} requires a resource URL`);
  const result = { url: value.url.trim() };
  for (const key of ['width', 'height', 'columns', 'rows']) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (!Number.isFinite(number) || number <= 0 || (['columns', 'rows'].includes(key) && !Number.isInteger(number))) {
      invalid(`${label}.${key} must be positive${['columns', 'rows'].includes(key) ? ' integer' : ''}`);
    }
    result[key] = number;
  }
  for (const key of ['column', 'row']) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    const count = result[key === 'column' ? 'columns' : 'rows'] || 1;
    if (!Number.isInteger(number) || number < 0 || number >= count) invalid(`${label}.${key} is outside the atlas`);
    result[key] = number;
  }
  if ((result.columns > 1 || result.rows > 1) && !(result.width && result.height)) {
    invalid(`${label} atlas requires width and height`);
  }
  if (value.align !== undefined) {
    if (!value.align || typeof value.align !== 'object' || Array.isArray(value.align)) invalid(`${label}.align must be an object`);
    const align = {};
    for (const key of ['offsetX', 'offsetY', 'scaleX', 'scaleY']) {
      if (value.align[key] === undefined) continue;
      const number = Number(value.align[key]);
      if (!Number.isFinite(number) || (key.startsWith('scale') && number <= 0)) invalid(`${label}.align.${key} is invalid`);
      align[key] = number;
    }
    result.align = Object.freeze(align);
  }
  return Object.freeze(result);
}

/** Only visual resources are admitted; no entity or navigation fields survive. */
export function normalizeRuinsAssets(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('artAssets.ruins must be a style table');
  const entries = Object.entries(value);
  if (entries.length > 512) invalid('artAssets.ruins exceeds 512 styles');
  const result = Object.create(null);
  for (const [style, variants] of entries) {
    if (!style.trim() || !variants || typeof variants !== 'object' || Array.isArray(variants)) invalid(`artAssets.ruins.${style} requires normal/severe resources`);
    if (variants.normal === undefined) invalid(`artAssets.ruins.${style}.normal is required`);
    result[style] = Object.freeze({ normal: texture(variants.normal, `artAssets.ruins.${style}.normal`),
      ...(variants.severe === undefined ? {} : { severe: texture(variants.severe, `artAssets.ruins.${style}.severe`) }) });
  }
  return Object.freeze(result);
}
