export const RULESET_API_VERSION = 1;

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

function prepareActorPresentation(raw = {}) {
  return Object.freeze({
    describe: actorFunction(raw.describe, actor => ({
      name: String(actor?.name || ''),
      avatarDataUrl: null,
      color: '#64748b',
      variantLabel: '',
    })),
    describeSheet: actorFunction(raw.describeSheet, actor => ({
      actorId: String(actor?.id || ''),
      variants: [],
      currentVariantId: null,
      tabs: [],
    })),
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
