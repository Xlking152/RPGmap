export const MAP_PACKAGE_API_VERSION = 1;
export const MAP_PACKAGE_FORMAT = 'rpgmap-map-package-v1';

export const MAP_LAYER_ROLES = Object.freeze([
  'base',
  'terrain',
  'liquid',
  'structure',
  'special',
  'destructible',
  'labels',
]);

const ROLE_SET = new Set(MAP_LAYER_ROLES);

function asNonEmptyString(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`Invalid MapPackage: ${label} is required`);
  return text;
}

function asPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new TypeError(`Invalid MapPackage: ${label} must be greater than zero`);
  }
  return number;
}

function defaultLayerRole(id) {
  if (ROLE_SET.has(id)) return id;
  if (id === 'damage' || id === 'flood' || id === 'effects') return 'special';
  return 'special';
}

function normalizeLayerDescriptor(entry, index) {
  if (typeof entry === 'string') {
    const id = asNonEmptyString(entry, `layers[${index}]`);
    return Object.freeze({ id, role: defaultLayerRole(id), sourceLayers: Object.freeze([id]) });
  }
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(`Invalid MapPackage: layerPlan[${index}] must be a string or object`);
  }
  const id = asNonEmptyString(entry.id, `layerPlan[${index}].id`);
  const role = asNonEmptyString(entry.role ?? defaultLayerRole(id), `layerPlan[${index}].role`);
  if (!ROLE_SET.has(role)) {
    throw new TypeError(`Invalid MapPackage: layer role "${role}" is not supported`);
  }
  const sourceLayers = Array.isArray(entry.sourceLayers) && entry.sourceLayers.length
    ? entry.sourceLayers.map((value, sourceIndex) => asNonEmptyString(value, `layerPlan[${index}].sourceLayers[${sourceIndex}]`))
    : [id];
  return Object.freeze({
    id,
    role,
    sourceLayers: Object.freeze(sourceLayers),
    description: entry.description ? String(entry.description) : '',
  });
}

function normalizeLayerPlan(mapPackage) {
  const configured = Array.isArray(mapPackage.layerPlan) && mapPackage.layerPlan.length
    ? mapPackage.layerPlan
    : mapPackage.layers;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new TypeError('Invalid MapPackage: layers or layerPlan is required');
  }
  const plan = configured.map(normalizeLayerDescriptor);
  const ids = plan.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('Invalid MapPackage: logical layer IDs must be unique');
  return Object.freeze(plan);
}

function normalizeFeature(feature, index, destructibleCategories) {
  if (!feature || typeof feature !== 'object') {
    throw new TypeError(`Invalid MapPackage: features[${index}] must be an object`);
  }
  const id = asNonEmptyString(feature.id ?? feature.featureId, `features[${index}].id`);
  const category = String(feature.category ?? 'generic');
  const declared = feature.capabilities && typeof feature.capabilities === 'object' ? feature.capabilities : {};
  const destructible = declared.destructible
    ?? feature.destructible?.enabled
    ?? feature.destructible
    ?? destructibleCategories.has(category);
  const enterable = declared.enterable ?? feature.enterable === true;
  const inspectable = declared.inspectable ?? feature.inspectable !== false;
  const interactive = declared.interactive ?? Boolean(inspectable || enterable || destructible);
  const capabilities = Object.freeze({
    ...declared,
    inspectable: Boolean(inspectable),
    interactive: Boolean(interactive),
    enterable: Boolean(enterable),
    destructible: Boolean(destructible),
  });
  return Object.freeze({ ...feature, id, category, capabilities });
}

export function prepareMapPackage(rawPackage, { source = 'unknown' } = {}) {
  if (!rawPackage || typeof rawPackage !== 'object') throw new TypeError('Invalid MapPackage: object expected');
  const id = asNonEmptyString(rawPackage.id ?? rawPackage.mapId, 'id');
  const version = asNonEmptyString(rawPackage.version ?? rawPackage.mapVersion, 'version');
  const width = asPositiveNumber(rawPackage.width, 'width');
  const height = asPositiveNumber(rawPackage.height, 'height');
  const render = typeof rawPackage.createSvg === 'function'
    ? rawPackage.createSvg
    : typeof rawPackage.svg === 'string'
      ? () => rawPackage.svg
      : null;
  if (!render) throw new TypeError('Invalid MapPackage: createSvg() or svg markup is required');

  const destructibleCategories = new Set(
    Array.isArray(rawPackage.destructibleCategories) ? rawPackage.destructibleCategories.map(String) : [],
  );
  const sourceFeatures = Array.isArray(rawPackage.features) ? rawPackage.features : [];
  const features = Object.freeze(sourceFeatures.map((feature, index) => normalizeFeature(feature, index, destructibleCategories)));
  const featureIds = features.map((feature) => feature.id);
  if (new Set(featureIds).size !== featureIds.length) throw new TypeError('Invalid MapPackage: feature IDs must be unique');

  const layerPlan = normalizeLayerPlan(rawPackage);
  const svg = typeof rawPackage.svg === 'string' ? rawPackage.svg : render();
  if (!String(svg).includes('<svg')) throw new TypeError('Invalid MapPackage: renderer did not return SVG markup');

  return Object.freeze({
    ...rawPackage,
    id,
    version,
    width,
    height,
    packageFormat: MAP_PACKAGE_FORMAT,
    mapPackageApiVersion: MAP_PACKAGE_API_VERSION,
    source: String(source),
    layerPlan,
    logicalLayers: Object.freeze(layerPlan.map((entry) => entry.id)),
    features,
    featureCount: features.length,
    svg,
    createSvg: render,
  });
}

export function mapPackageCapabilities(mapPackage) {
  const features = Array.isArray(mapPackage?.features) ? mapPackage.features : [];
  return Object.freeze({
    featureCount: features.length,
    interactiveCount: features.filter((feature) => feature.capabilities?.interactive).length,
    destructibleCount: features.filter((feature) => feature.capabilities?.destructible).length,
    enterableCount: features.filter((feature) => feature.capabilities?.enterable).length,
  });
}
