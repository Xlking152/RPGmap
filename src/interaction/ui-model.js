const LEGACY_FEATURE_LOCATION_TYPES = new Set(['feature', 'building']);

function stringValue(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function taxonomyMap(mapPackage, key) {
  const value = mapPackage?.featureTaxonomy?.[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function featureCategoryLabel(mapPackage, featureOrCategory) {
  const category = typeof featureOrCategory === 'object'
    ? featureOrCategory?.category
    : featureOrCategory;
  const id = stringValue(category, 'generic');
  return stringValue(taxonomyMap(mapPackage, 'categories')[id], id);
}

export function featureSubtypeLabel(mapPackage, feature) {
  const subtype = stringValue(feature?.subtype);
  if (!subtype) return '未分类';
  return stringValue(taxonomyMap(mapPackage, 'subtypes')[subtype], subtype);
}

export function featureDetailRows(mapPackage, feature) {
  const details = feature?.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return Object.freeze([]);
  const globalLabels = taxonomyMap(mapPackage, 'detailFields');
  const localLabels = feature?.presentation?.detailFields && typeof feature.presentation.detailFields === 'object'
    ? feature.presentation.detailFields
    : {};
  const rows = Object.entries(details)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .map(([key, value]) => Object.freeze({
      key,
      label: stringValue(localLabels[key] ?? globalLabels[key], key),
      value: String(value),
    }));
  return Object.freeze(rows);
}

export function characterFeatureId(character) {
  const location = character?.location;
  if (!LEGACY_FEATURE_LOCATION_TYPES.has(location?.type)) return null;
  return location.featureId == null ? null : String(location.featureId);
}

export function charactersInsideFeature(state, featureId) {
  const id = String(featureId ?? '');
  if (!id) return Object.freeze([]);
  return Object.freeze((state?.characters || []).filter((character) => characterFeatureId(character) === id));
}

export function featureLocationLabel(character, mapPackage) {
  const featureId = characterFeatureId(character);
  if (!featureId) return null;
  const feature = (mapPackage?.features || []).find((item) => String(item.id) === featureId);
  return `位于：${feature?.name || featureId}`;
}

export function featureEntranceText(feature) {
  if (!Array.isArray(feature?.entrance) || feature.entrance.length < 2) return '';
  const x = Number(feature.entrance[0]);
  const y = Number(feature.entrance[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
  return `x ${x.toFixed(1)} · y ${y.toFixed(1)}`;
}
