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

export const FEATURE_INTERACTION_ACTIONS = Object.freeze([
  'inspect',
  'enter',
  'exit',
  'damage',
  'restore',
  'open',
  'close',
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

function asOptionalNonNegativeNumber(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`Invalid MapPackage: ${label} must be a non-negative finite number`);
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

function normalizeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .map(([key, label]) => [String(key), String(label ?? '').trim()])
      .filter(([, label]) => Boolean(label)),
  ));
}

function normalizeFeatureTaxonomy(mapPackage) {
  const source = mapPackage.featureTaxonomy && typeof mapPackage.featureTaxonomy === 'object'
    ? mapPackage.featureTaxonomy
    : {};
  return Object.freeze({
    categories: normalizeStringMap(source.categories),
    subtypes: normalizeStringMap(source.subtypes),
    detailFields: normalizeStringMap(source.detailFields),
  });
}

function normalizeNavigationPolygon(value, label) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const points = value.map((point, index) => {
    const x = Number(point?.[0]);
    const y = Number(point?.[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new TypeError(`Invalid MapPackage: ${label}[${index}] must contain finite coordinates`);
    }
    return Object.freeze([x, y]);
  });
  return Object.freeze(points);
}

function normalizeNavigationCapability(feature, declared) {
  const source = declared.navigation ?? feature.navigation;
  if (!source || typeof source !== 'object') return null;
  const passageTile = source.passageTile === 'road' || source.passageTile === 'open'
    ? source.passageTile
    : null;
  return Object.freeze({
    blocks: source.blocks === true,
    passableWhenOpen: source.passableWhenOpen === true,
    passableWhenDestroyed: source.passableWhenDestroyed === true,
    damageCreatesPassage: source.damageCreatesPassage === true,
    blockingHeightFt: asOptionalNonNegativeNumber(source.blockingHeightFt, 'feature navigation blockingHeightFt'),
    blockingPolygon: normalizeNavigationPolygon(source.blockingPolygon, 'feature navigation blockingPolygon'),
    passageTile,
    passagePolygon: normalizeNavigationPolygon(source.passagePolygon, 'feature navigation passagePolygon'),
  });
}

function normalizeFeature(feature, index, destructibleCategories) {
  if (!feature || typeof feature !== 'object') {
    throw new TypeError(`Invalid MapPackage: features[${index}] must be an object`);
  }
  const id = asNonEmptyString(feature.id ?? feature.featureId, `features[${index}].id`);
  const category = String(feature.category ?? 'generic');
  const declared = feature.capabilities && typeof feature.capabilities === 'object' ? feature.capabilities : {};
  const declaredActions = declared.actions && typeof declared.actions === 'object' ? declared.actions : {};

  const destructible = declared.destructible
    ?? feature.destructible?.enabled
    ?? feature.destructible
    ?? destructibleCategories.has(category);
  const enterable = declared.enterable ?? feature.enterable === true;
  const inspectable = declared.inspectable ?? feature.inspectable !== false;
  const openable = declared.openable
    ?? feature.openable
    ?? feature.interactions?.openable
    ?? declaredActions.open
    ?? declaredActions.close
    ?? false;

  const actions = Object.freeze({
    inspect: Boolean(declaredActions.inspect ?? inspectable),
    enter: Boolean(declaredActions.enter ?? enterable),
    exit: Boolean(declaredActions.exit ?? enterable),
    damage: Boolean(declaredActions.damage ?? destructible),
    restore: Boolean(declaredActions.restore ?? destructible),
    open: Boolean(declaredActions.open ?? openable),
    close: Boolean(declaredActions.close ?? openable),
  });
  const interactive = declared.interactive
    ?? feature.interactive
    ?? Object.values(actions).some(Boolean);
  const navigation = normalizeNavigationCapability(feature, declared);

  const capabilities = Object.freeze({
    ...declared,
    inspectable: Boolean(inspectable),
    interactive: Boolean(interactive),
    enterable: Boolean(enterable),
    destructible: Boolean(destructible),
    openable: Boolean(openable),
    actions,
    navigation,
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
  const featureTaxonomy = normalizeFeatureTaxonomy(rawPackage);
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
    featureTaxonomy,
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
    openableCount: features.filter((feature) => feature.capabilities?.openable).length,
    navigationObstacleCount: features.filter((feature) => feature.capabilities?.navigation?.blocks).length,
    heightAwareObstacleCount: features.filter((feature) => Number.isFinite(feature.capabilities?.navigation?.blockingHeightFt)).length,
  });
}
