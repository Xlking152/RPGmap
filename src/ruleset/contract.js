export const RULESET_API_VERSION = 1;

export const ACTOR_SHEET_KINDS = Object.freeze([
  'character',
  'monster',
  'npc',
  'generic',
]);

function nonEmptyString(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Ruleset ${field} must be a non-empty string`);
  return text;
}

function frozenArray(value) {
  return Object.freeze(Array.isArray(value) ? [...value] : []);
}

function optionalFunction(value) {
  return typeof value === 'function' ? value : null;
}

function actorFunction(value, fallback) {
  return typeof value === 'function' ? value : fallback;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function actorSheetKind(actor, requested) {
  const explicit = text(requested);
  if (ACTOR_SHEET_KINDS.includes(explicit)) return explicit;
  const actorType = String(actor?.type || 'other');
  if (actorType === 'pc') return 'character';
  if (actorType === 'monster' || actorType === 'summon') return 'monster';
  if (actorType === 'npc') return 'npc';
  return 'generic';
}

function actorTypeLabel(actor) {
  return ({
    pc: 'PC',
    monster: '怪物',
    npc: 'NPC',
    summon: '召唤物',
    other: '其他',
  })[String(actor?.type || 'other')] || '其他';
}

function defaultSheetTab(kind, tabs, requested) {
  const available = new Set(tabs.map(tab => String(tab?.id || '')).filter(Boolean));
  const explicit = text(requested);
  if (explicit && available.has(explicit)) return explicit;
  const preferred = kind === 'monster' ? 'combat' : 'overview';
  if (available.has(preferred)) return preferred;
  if (available.has('overview')) return 'overview';
  if (available.has('combat')) return 'combat';
  return String(tabs[0]?.id || '');
}

function normalizeSheetSummary(raw, actor, kind) {
  const source = plainObject(raw);
  const tags = Array.isArray(source.tags)
    ? source.tags.map(item => String(item ?? '').trim()).filter(Boolean)
    : [];
  return Object.freeze({
    ...structuredClone(source),
    type: text(source.type, String(actor?.type || 'other')),
    typeLabel: text(source.typeLabel, actorTypeLabel(actor)),
    kind,
    subtitle: text(source.subtitle),
    tags: Object.freeze(tags),
  });
}

function normalizeSheetDescription(rawDescription, actor) {
  const source = plainObject(rawDescription);
  const tabs = (Array.isArray(source.tabs) ? source.tabs : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => structuredClone(item));
  const variants = (Array.isArray(source.variants) ? source.variants : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => structuredClone(item));
  const kind = actorSheetKind(actor, source.kind);
  return Object.freeze({
    ...structuredClone(source),
    actorId: text(source.actorId, String(actor?.id || '')),
    kind,
    defaultTab: defaultSheetTab(kind, tabs, source.defaultTab),
    summary: normalizeSheetSummary(source.summary, actor, kind),
    variants: Object.freeze(variants),
    currentVariantId: source.currentVariantId == null ? null : String(source.currentVariantId),
    tabs: Object.freeze(tabs),
  });
}

function prepareActorPresentation(raw = {}) {
  const describe = actorFunction(raw.describe, actor => ({
    name: String(actor?.name || ''),
    avatarDataUrl: null,
    color: '#64748b',
    variantLabel: '',
  }));
  const describeSheet = actorFunction(raw.describeSheet, actor => ({
    actorId: String(actor?.id || ''),
    variants: [],
    currentVariantId: null,
    tabs: [],
  }));
  return Object.freeze({
    describe,
    describeSheet(actor, context = {}) {
      return normalizeSheetDescription(describeSheet(actor, context), actor);
    },
  });
}

function plainClone(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? structuredClone(value) : {};
}

function prepareActorInstances(raw = {}) {
  return Object.freeze({
    supported: ['createDelta', 'normalizeDelta', 'fromResolved', 'rebaseDelta']
      .some(key => typeof raw[key] === 'function'),
    createDelta: actorFunction(raw.createDelta, () => ({})),
    normalizeDelta: actorFunction(raw.normalizeDelta, (_baseActor, delta) => plainClone(delta)),
    fromResolved: actorFunction(raw.fromResolved, (_baseActor, _resolvedActor, context = {}) => (
      plainClone(context.currentDelta)
    )),
    rebaseDelta: actorFunction(raw.rebaseDelta, (_previousBase, nextBase, delta, context = {}) => (
      actorFunction(raw.normalizeDelta, (_baseActor, value) => plainClone(value))(nextBase, delta, context)
    )),
    templateFingerprint: actorFunction(raw.templateFingerprint, actor => plainClone(actor)),
  });
}

function prepareVision(raw = {}) {
  return Object.freeze({
    describe: actorFunction(raw.describe, () => ({
      enabled: false,
      rangeMeters: 0,
      preciseRangeMeters: 0,
      vagueRangeMeters: 0,
      senses: {},
    })),
  });
}

function presentationOptions(value) {
  return Object.freeze((Array.isArray(value) ? value : []).map(option => Object.freeze({ ...option })));
}

function prepareHealthPresentation(raw = {}) {
  const operations = raw.operations && typeof raw.operations === 'object' ? raw.operations : {};
  return Object.freeze({
    modes: presentationOptions(raw.modes),
    operations: Object.freeze(Object.fromEntries(Object.entries(operations).map(([key, value]) => [
      key,
      Object.freeze({
        ...(value && typeof value === 'object' ? value : {}),
        types: presentationOptions(value?.types),
      }),
    ]))),
    describe: optionalFunction(raw.describe),
  });
}

export function prepareRuleset(raw = {}) {
  const apiVersion = Number(raw.apiVersion ?? RULESET_API_VERSION);
  if (apiVersion !== RULESET_API_VERSION) {
    throw new Error(`Unsupported ruleset apiVersion: ${apiVersion}`);
  }

  const actor = raw.actor && typeof raw.actor === 'object' ? raw.actor : {};
  const health = raw.health && typeof raw.health === 'object' ? raw.health : {};
  const statuses = raw.statuses && typeof raw.statuses === 'object' ? raw.statuses : {};
  const importers = raw.importers && typeof raw.importers === 'object' ? raw.importers : {};
  const vision = raw.vision && typeof raw.vision === 'object' ? raw.vision : {};

  return Object.freeze({
    apiVersion,
    id: nonEmptyString(raw.id, 'id'),
    title: nonEmptyString(raw.title, 'title'),
    version: nonEmptyString(raw.version, 'version'),
    actor: Object.freeze({
      resourceDefinitions: frozenArray(actor.resourceDefinitions),
      createDefault: actorFunction(actor.createDefault, () => ({ name: '', system: {} })),
      createFromImport: actorFunction(actor.createFromImport, (_imported, context = {}) => (
        actorFunction(actor.createDefault, () => ({ name: '', system: {} }))(context)
      )),
      migrateLegacy: actorFunction(actor.migrateLegacy, rawActor => ({
        name: String(rawActor?.name || ''),
        system: rawActor?.system && typeof rawActor.system === 'object' ? structuredClone(rawActor.system) : {},
      })),
      normalizeSystem: actorFunction(actor.normalizeSystem, system => (
        system && typeof system === 'object' && !Array.isArray(system) ? structuredClone(system) : {}
      )),
      validateSystem: actorFunction(actor.validateSystem, () => []),
      derive: actorFunction(actor.derive, actorDocument => ({
        id: String(actorDocument?.id || ''),
        name: String(actorDocument?.name || ''),
      })),
      attributePaths: actorFunction(actor.attributePaths, () => []),
      resolveAttribute: actorFunction(actor.resolveAttribute, () => null),
      applyRuntimeOperation: actorFunction(actor.applyRuntimeOperation, () => ({
        changed: false,
        blocked: 'unknown_actor_operation',
      })),
      instances: prepareActorInstances(actor.instances),
      portrait: Object.freeze({
        describe: actorFunction(actor.portrait?.describe, document => ({ variantId: null, reference: document.img || null })),
        update: actorFunction(actor.portrait?.update, (document, { reference }) => {
          const previous = document.img;
          document.img = reference;
          if (document.prototypeToken?.texture && (!document.prototypeToken.texture.src || document.prototypeToken.texture.src === previous)) document.prototypeToken.texture.src = reference;
        }),
      }),
      presentation: prepareActorPresentation(actor.presentation),
    }),
    health: Object.freeze({
      supportedModes: frozenArray(health.supportedModes),
      defaultModeForSource: typeof health.defaultModeForSource === 'function'
        ? health.defaultModeForSource
        : () => 'simple',
      createRuntime: optionalFunction(health.createRuntime),
      normalizeRuntime: optionalFunction(health.normalizeRuntime),
      resolve: optionalFunction(health.resolve),
      switchMode: optionalFunction(health.switchMode),
      applyRuntimeOperation: optionalFunction(health.applyRuntimeOperation),
      applyDamage: optionalFunction(health.applyDamage),
      applyHealing: optionalFunction(health.applyHealing),
      presentation: prepareHealthPresentation(health.presentation),
    }),
    statuses: Object.freeze({
      definitions: frozenArray(statuses.definitions),
      derive: optionalFunction(statuses.derive),
      canonicalizeChangeTarget: optionalFunction(statuses.canonicalizeChangeTarget),
    }),
    vision: prepareVision(vision),
    importers: Object.freeze({ ...importers }),
    metadata: Object.freeze({ ...(raw.metadata || {}) }),
  });
}
