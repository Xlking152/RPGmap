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

export function prepareRuleset(raw = {}) {
  const apiVersion = Number(raw.apiVersion ?? RULESET_API_VERSION);
  if (apiVersion !== RULESET_API_VERSION) {
    throw new Error(`Unsupported ruleset apiVersion: ${apiVersion}`);
  }

  const actor = raw.actor && typeof raw.actor === 'object' ? raw.actor : {};
  const health = raw.health && typeof raw.health === 'object' ? raw.health : {};
  const statuses = raw.statuses && typeof raw.statuses === 'object' ? raw.statuses : {};
  const importers = raw.importers && typeof raw.importers === 'object' ? raw.importers : {};

  return Object.freeze({
    apiVersion,
    id: nonEmptyString(raw.id, 'id'),
    title: nonEmptyString(raw.title, 'title'),
    version: nonEmptyString(raw.version, 'version'),
    actor: Object.freeze({
      resourceDefinitions: frozenArray(actor.resourceDefinitions),
      badStatusDefinitions: frozenArray(actor.badStatusDefinitions),
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
      setWounds: optionalFunction(health.setWounds),
      applyDamage: optionalFunction(health.applyDamage),
      applyHealing: optionalFunction(health.applyHealing),
    }),
    statuses: Object.freeze({
      definitions: frozenArray(statuses.definitions),
    }),
    importers: Object.freeze({ ...importers }),
    metadata: Object.freeze({ ...(raw.metadata || {}) }),
  });
}
