import { INFINITE_HORROR_BAD_STATUS_DEFS, INFINITE_HORROR_RESOURCE_DEFS } from './definitions.js';
import { INFINITE_HORROR_HEALTH } from './health.js';

export const INFINITE_HORROR_ACTOR_SYSTEM_VERSION = 1;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function identifier(value, fallback) {
  return text(value == null ? '' : String(value), fallback);
}

function defaultIdFactory(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${prefix}-${value}`;
}

function mergeValue(base, patch) {
  if (patch === undefined) return clone(base);
  if (Array.isArray(patch)) return clone(patch);
  if (!patch || typeof patch !== 'object') return clone(patch);
  const result = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) result[key] = mergeValue(result[key], value);
  return result;
}

function normalizeImportedCard(input = {}) {
  const source = object(input);
  return {
    formName: text(source.formName, '默认形态'),
    identity: { ...object(source.identity), name: text(source.identity?.name, '未命名角色') },
    description: clone(object(source.description)),
    resources: clone(object(source.resources)),
    attributes: Array.isArray(source.attributes) ? clone(source.attributes) : [],
    checks: {
      skills: Array.isArray(source.checks?.skills) ? clone(source.checks.skills) : [],
      saves: Array.isArray(source.checks?.saves) ? clone(source.checks.saves) : [],
    },
    badStatuses: Array.isArray(source.badStatuses) ? clone(source.badStatuses) : [],
    combat: {
      ...clone(object(source.combat)),
      attacks: Array.isArray(source.combat?.attacks) ? clone(source.combat.attacks) : [],
      defenses: Array.isArray(source.combat?.defenses) ? clone(source.combat.defenses) : [],
    },
    tokenAppearance: {
      ...clone(object(source.tokenAppearance)),
      color: text(source.tokenAppearance?.color, '#3d9b63'),
      scale: finite(source.tokenAppearance?.scale, 1) || 1,
    },
    source: clone(object(source.source)),
    avatarDataUrl: typeof source.avatarDataUrl === 'string' ? source.avatarDataUrl : null,
  };
}

function emptyBadStatuses() {
  return INFINITE_HORROR_BAD_STATUS_DEFS.map(definition => ({
    id: definition.id,
    name: definition.name,
    light: 0,
    severe: 0,
    destruction: 0,
  }));
}

function migratedBadStatuses(form) {
  if (Array.isArray(form?.badStatuses) && form.badStatuses.length) return clone(form.badStatuses);
  const saves = Array.isArray(form?.checks?.saves) ? form.checks.saves : [];
  const thresholds = saves.filter(item => Number.isFinite(Number(item?.light))
    && Number.isFinite(Number(item?.severe))
    && Number.isFinite(Number(item?.devastating)));
  if (!thresholds.length) return emptyBadStatuses();
  return INFINITE_HORROR_BAD_STATUS_DEFS.map(definition => {
    const threshold = thresholds[definition.group] || {};
    return {
      id: definition.id,
      name: definition.name,
      light: Math.max(0, finite(threshold.light)),
      severe: Math.max(0, finite(threshold.severe)),
      destruction: Math.max(0, finite(threshold.devastating)),
    };
  });
}

function normalizeForm(raw = {}) {
  const form = clone(object(raw));
  const saves = Array.isArray(form.checks?.saves) ? clone(form.checks.saves) : [];
  const savesWereThresholds = saves.some(item => item && typeof item === 'object'
    && 'light' in item && 'severe' in item && 'devastating' in item);
  form.id = identifier(form.id, defaultIdFactory('form'));
  form.name = text(form.name, '默认形态');
  form.avatarDataUrl = typeof form.avatarDataUrl === 'string' ? form.avatarDataUrl : null;
  form.identity = { ...object(form.identity), name: text(form.identity?.name, '未命名角色') };
  form.description = clone(object(form.description));
  form.resourceBases = clone(object(form.resourceBases));
  form.attributes = Array.isArray(form.attributes) ? clone(form.attributes) : [];
  form.checks = {
    ...clone(object(form.checks)),
    skills: Array.isArray(form.checks?.skills) ? clone(form.checks.skills) : [],
    saves: savesWereThresholds ? [] : saves,
  };
  form.badStatuses = migratedBadStatuses(raw);
  form.combat = {
    ...clone(object(form.combat)),
    attacks: Array.isArray(form.combat?.attacks) ? clone(form.combat.attacks) : [],
    defenses: Array.isArray(form.combat?.defenses) ? clone(form.combat.defenses) : [],
  };
  form.tokenAppearance = {
    ...clone(object(form.tokenAppearance)),
    color: text(form.tokenAppearance?.color, '#3d9b63'),
    scale: finite(form.tokenAppearance?.scale, 1) || 1,
  };
  form.source = clone(object(form.source));
  return form;
}

function formFromImport(imported, { variantId, variantName, idFactory = defaultIdFactory } = {}) {
  const card = normalizeImportedCard(imported);
  const resourceBases = {};
  for (const definition of INFINITE_HORROR_RESOURCE_DEFS) {
    resourceBases[definition.id] = {
      id: definition.id,
      name: definition.name,
      kind: definition.kind,
      baseMax: Math.max(0, finite(card.resources?.[definition.id]?.max ?? card.resources?.[definition.id])),
    };
  }
  return normalizeForm({
    id: identifier(variantId, idFactory('form')),
    name: text(variantName, card.formName),
    avatarDataUrl: card.avatarDataUrl,
    identity: card.identity,
    description: card.description,
    resourceBases,
    attributes: card.attributes,
    checks: card.checks,
    badStatuses: card.badStatuses.length ? card.badStatuses : emptyBadStatuses(),
    combat: card.combat,
    tokenAppearance: card.tokenAppearance,
    source: card.source,
  });
}

function initialRuntime(form) {
  const resources = {};
  for (const definition of INFINITE_HORROR_RESOURCE_DEFS) {
    const maximum = Math.max(0, finite(form.resourceBases?.[definition.id]?.baseMax));
    resources[definition.id] = { current: maximum, maxOverride: null, policy: 'preserve' };
  }
  const badStatuses = Object.fromEntries((form.badStatuses || []).map(status => [status.id, 0]));
  const hpMax = Math.max(0, finite(form.resourceBases?.hp?.baseMax));
  return {
    resources,
    customResources: [],
    attributeAdjustments: {},
    badStatuses,
    health: INFINITE_HORROR_HEALTH.createRuntime({
      mode: INFINITE_HORROR_HEALTH.defaultModeForSource(form.source?.type),
      max: hpMax,
      simpleCurrent: resources.hp?.current ?? hpMax,
    }),
  };
}

export function createInfiniteHorrorActorFromImport(imported, context = {}) {
  const card = normalizeImportedCard(imported);
  const form = formFromImport(card, context);
  return {
    name: text(context.name, card.identity.name),
    system: {
      schemaVersion: INFINITE_HORROR_ACTOR_SYSTEM_VERSION,
      currentFormId: form.id,
      forms: [form],
      runtime: initialRuntime(form),
    },
  };
}

export function createDefaultInfiniteHorrorActor(context = {}) {
  return createInfiniteHorrorActorFromImport({
    formName: '默认形态',
    identity: { name: text(context.name, '新角色') },
    description: {},
    resources: {},
    attributes: [],
    checks: { skills: [], saves: [] },
    badStatuses: [],
    combat: { attacks: [], defenses: [] },
    tokenAppearance: { color: '#3d9b63', scale: 1 },
    source: { type: 'manual' },
  }, context);
}

export function migrateInfiniteHorrorActor(rawActor = {}) {
  const actor = object(rawActor);
  const existing = clone(object(actor.system));
  if (Array.isArray(actor.forms)) existing.forms = clone(actor.forms);
  if (actor.currentFormId != null) existing.currentFormId = actor.currentFormId;
  if (actor.runtime && typeof actor.runtime === 'object') {
    existing.runtime = mergeValue(existing.runtime, actor.runtime);
  }
  return { name: text(actor.name, '未命名角色'), system: existing };
}

function currentFormFromSystem(system) {
  const forms = Array.isArray(system?.forms) ? system.forms : [];
  return forms.find(form => String(form?.id) === String(system?.currentFormId)) || forms[0] || null;
}

export function normalizeInfiniteHorrorSystem(rawSystem = {}) {
  const source = clone(object(rawSystem));
  const forms = Array.isArray(source.forms) ? source.forms.filter(Boolean).map(normalizeForm) : [];
  const current = forms.find(form => String(form.id) === String(source.currentFormId)) || forms[0] || null;
  const runtimeSource = clone(object(source.runtime));
  const resources = clone(object(runtimeSource.resources));
  const badStatuses = clone(object(runtimeSource.badStatuses));
  for (const form of forms) {
    for (const status of form.badStatuses || []) {
      if (badStatuses[status.id] === undefined) badStatuses[status.id] = 0;
    }
  }
  for (const definition of INFINITE_HORROR_RESOURCE_DEFS) {
    const maximum = Math.max(0, finite(current?.resourceBases?.[definition.id]?.baseMax));
    const existing = object(resources[definition.id]);
    resources[definition.id] = {
      ...clone(existing),
      current: finite(existing.current, maximum),
      maxOverride: existing.maxOverride === null || existing.maxOverride === undefined
        ? null
        : Math.max(0, finite(existing.maxOverride)),
      policy: text(existing.policy, 'preserve'),
    };
  }
  const hpMax = Math.max(0, finite(current?.resourceBases?.hp?.baseMax));
  const hpCurrent = finite(resources.hp?.current, hpMax);
  return {
    ...source,
    schemaVersion: INFINITE_HORROR_ACTOR_SYSTEM_VERSION,
    currentFormId: current?.id || null,
    forms,
    runtime: {
      ...runtimeSource,
      resources,
      customResources: Array.isArray(runtimeSource.customResources) ? clone(runtimeSource.customResources) : [],
      attributeAdjustments: clone(object(runtimeSource.attributeAdjustments)),
      badStatuses,
      health: INFINITE_HORROR_HEALTH.normalizeRuntime(runtimeSource.health, {
        defaultMode: INFINITE_HORROR_HEALTH.defaultModeForSource(current?.source?.type),
        max: hpMax,
        simpleCurrent: hpCurrent,
      }),
    },
  };
}

export function validateInfiniteHorrorSystem(system) {
  const errors = [];
  if (Number(system?.schemaVersion) !== INFINITE_HORROR_ACTOR_SYSTEM_VERSION) {
    errors.push(`system.schemaVersion must be ${INFINITE_HORROR_ACTOR_SYSTEM_VERSION}`);
  }
  if (!Array.isArray(system?.forms)) errors.push('system.forms must be an array');
  if (!system?.runtime || typeof system.runtime !== 'object' || Array.isArray(system.runtime)) {
    errors.push('system.runtime must be an object');
  }
  if (system?.currentFormId != null
    && !system.forms?.some(form => String(form?.id) === String(system.currentFormId))) {
    errors.push('system.currentFormId must reference an existing form');
  }
  return errors;
}

function applyMode(current, mode, rawValue) {
  const value = finite(rawValue);
  if (mode === 'set') return value;
  if (mode === 'multiply') return current * value;
  if (mode === 'min') return Math.min(current, value);
  if (mode === 'max') return Math.max(current, value);
  return current + value;
}

function canonicalPath(path) {
  const value = String(path || '');
  if (value.startsWith('system.')) return value;
  if (value.startsWith('resources.') || value.startsWith('attributes.')) return `system.${value}`;
  return value;
}

function effectsFor(actor, target, context = {}) {
  const effects = Array.isArray(context.effects) ? context.effects : (Array.isArray(actor?.effects) ? actor.effects : []);
  return effects.filter(effect => effect?.enabled !== false)
    .flatMap(effect => (effect.changes || []).map(change => ({
      ...change,
      value: change?.mode === 'add'
        ? finite(change?.value) * Math.max(1, Math.floor(finite(effect?.stacks, 1)))
        : change?.value,
    })))
    .filter(change => canonicalPath(change?.target) === canonicalPath(target));
}

function resolveAttributeValue(actor, form, attributeId, context = {}) {
  const source = form?.attributes?.find(item => String(item?.id) === String(attributeId));
  if (!source) return null;
  let value = finite(source.base ?? source.value);
  const adjustment = finite(actor.system?.runtime?.attributeAdjustments?.[attributeId]);
  value += adjustment;
  for (const change of effectsFor(actor, `system.attributes.${attributeId}`, context)) {
    value = applyMode(value, change.mode, change.value);
  }
  return { ...clone(source), base: finite(source.base ?? source.value), adjustment, value };
}

function resolveResourceValue(actor, form, resourceId, context = {}) {
  const custom = actor.system?.runtime?.customResources?.find(item => String(item?.id) === String(resourceId));
  if (custom) {
    let max = Math.max(0, finite(custom.max));
    for (const change of effectsFor(actor, `system.resources.${resourceId}.max`, context)) {
      max = applyMode(max, change.mode, change.value);
    }
    let current = finite(custom.current);
    for (const change of effectsFor(actor, `system.resources.${resourceId}.current`, context)) {
      current = applyMode(current, change.mode, change.value);
    }
    return { ...clone(custom), max, current, custom: true };
  }
  const base = form?.resourceBases?.[resourceId];
  if (!base) return null;
  const runtime = actor.system?.runtime?.resources?.[resourceId] || {
    current: base.baseMax,
    maxOverride: null,
    policy: 'preserve',
  };
  let max = runtime.maxOverride === null || runtime.maxOverride === undefined
    ? finite(base.baseMax)
    : finite(runtime.maxOverride);
  for (const change of effectsFor(actor, `system.resources.${resourceId}.max`, context)) {
    max = applyMode(max, change.mode, change.value);
  }
  let current = finite(runtime.current, max);
  for (const change of effectsFor(actor, `system.resources.${resourceId}.current`, context)) {
    current = applyMode(current, change.mode, change.value);
  }
  return {
    id: resourceId,
    name: base.name,
    kind: base.kind,
    baseMax: finite(base.baseMax),
    max,
    current,
    policy: runtime.policy || 'preserve',
    custom: false,
  };
}

function resolveBadStatus(actor, form, statusId) {
  const base = form?.badStatuses?.find(item => String(item?.id) === String(statusId));
  if (!base) return null;
  return {
    ...clone(base),
    light: Math.max(0, finite(base.light)),
    severe: Math.max(0, finite(base.severe)),
    destruction: Math.max(0, finite(base.destruction)),
    current: Math.max(0, finite(actor.system?.runtime?.badStatuses?.[statusId])),
  };
}

export function deriveInfiniteHorrorActor(actor, context = {}) {
  if (!actor) return null;
  const system = normalizeInfiniteHorrorSystem(
    actor.system && typeof actor.system === 'object'
      ? actor.system
      : migrateInfiniteHorrorActor(actor).system,
  );
  const normalizedActor = { ...actor, system };
  const form = currentFormFromSystem(system);
  if (!form) {
    return {
      id: actor.id,
      name: actor.name,
      form: null,
      variants: [],
      currentVariantId: null,
      resources: [],
      attributes: [],
      checks: { skills: [], saves: [] },
      badStatuses: [],
      combat: { attacks: [], defenses: [] },
      health: null,
    };
  }
  const resourceIds = [...new Set([
    ...Object.keys(form.resourceBases || {}),
    ...(system.runtime?.customResources || []).map(item => String(item.id)),
  ])];
  const resources = resourceIds.map(id => resolveResourceValue(normalizedActor, form, id, context)).filter(Boolean);
  const hp = resources.find(resource => resource.id === 'hp') || { max: 0, current: 0 };
  const healthRuntime = INFINITE_HORROR_HEALTH.normalizeRuntime(system.runtime?.health, {
    defaultMode: INFINITE_HORROR_HEALTH.defaultModeForSource(form.source?.type),
    max: hp.max,
    simpleCurrent: hp.current,
  });
  return {
    id: actor.id,
    name: actor.name,
    form: clone(form),
    variants: system.forms.map(item => ({ id: item.id, name: item.name })),
    currentVariantId: form.id,
    resources,
    health: INFINITE_HORROR_HEALTH.resolve(healthRuntime, { max: hp.max, simpleCurrent: hp.current }),
    attributes: (form.attributes || []).map(item => resolveAttributeValue(normalizedActor, form, item.id, context)).filter(Boolean),
    checks: clone(form.checks || { skills: [], saves: [] }),
    badStatuses: (form.badStatuses || []).map(item => resolveBadStatus(normalizedActor, form, item.id)).filter(Boolean),
    combat: clone(form.combat || { attacks: [], defenses: [] }),
  };
}

export function infiniteHorrorAttributePaths(actor) {
  const derived = deriveInfiniteHorrorActor(actor);
  if (!derived) return [];
  return [
    ...derived.resources.flatMap(resource => [
      { path: `system.resources.${resource.id}.current`, label: `${resource.name} · 当前`, kind: 'number' },
      { path: `system.resources.${resource.id}.max`, label: `${resource.name} · 最大`, kind: 'number' },
    ]),
    ...derived.attributes.map(attribute => ({
      path: `system.attributes.${attribute.id}`,
      label: attribute.name,
      kind: 'number',
    })),
  ];
}

export function resolveInfiniteHorrorAttribute(actor, path, context = {}) {
  const value = canonicalPath(path);
  const derived = deriveInfiniteHorrorActor(actor, context);
  let match = /^system\.resources\.([^.]+)\.(current|max)$/.exec(value);
  if (match) return derived?.resources?.find(resource => String(resource.id) === match[1])?.[match[2]] ?? null;
  match = /^system\.attributes\.([^.]+)$/.exec(value);
  if (match) return derived?.attributes?.find(attribute => String(attribute.id) === match[1])?.value ?? null;
  return null;
}

function healthContext(actor) {
  const derived = deriveInfiniteHorrorActor(actor);
  const hp = derived?.resources?.find(resource => resource.id === 'hp') || { max: 0, current: 0 };
  const form = derived?.form;
  return {
    derived,
    hp,
    options: {
      defaultMode: INFINITE_HORROR_HEALTH.defaultModeForSource(form?.source?.type),
      max: hp.max,
      simpleCurrent: hp.current,
    },
  };
}

function setResourceCurrent(actor, resourceId, rawValue) {
  const runtime = actor.system.runtime;
  const custom = runtime.customResources.find(item => String(item.id) === String(resourceId));
  if (custom) custom.current = finite(rawValue);
  else {
    runtime.resources[resourceId] ||= { current: 0, maxOverride: null, policy: 'preserve' };
    runtime.resources[resourceId].current = finite(rawValue);
  }
}

function setResourceMaximum(actor, resourceId, rawValue) {
  const runtime = actor.system.runtime;
  const custom = runtime.customResources.find(item => String(item.id) === String(resourceId));
  if (custom) custom.max = Math.max(0, finite(rawValue));
  else {
    runtime.resources[resourceId] ||= { current: 0, maxOverride: null, policy: 'preserve' };
    runtime.resources[resourceId].maxOverride = rawValue === '' || rawValue === null || rawValue === undefined
      ? null
      : Math.max(0, finite(rawValue));
  }
}

function healthResult(actor, operation) {
  const beforeContext = healthContext(actor);
  const before = beforeContext.derived?.health;
  const runtime = INFINITE_HORROR_HEALTH.normalizeRuntime(actor.system.runtime.health, beforeContext.options);
  if (operation.type === 'health.set-mode') {
    const switched = INFINITE_HORROR_HEALTH.switchMode(runtime, operation.mode, {
      max: beforeContext.hp.max,
      simpleCurrent: beforeContext.hp.current,
    });
    actor.system.runtime.health = switched.runtime;
    setResourceCurrent(actor, 'hp', switched.simpleCurrent);
    return { changed: true, value: deriveInfiniteHorrorActor(actor).health, before };
  }
  if (operation.type === 'health.runtime') {
    const result = INFINITE_HORROR_HEALTH.applyRuntimeOperation(runtime, operation.operation, {
      max: beforeContext.hp.max,
      simpleCurrent: beforeContext.hp.current,
    });
    if (!result?.changed) return { changed: false, blocked: result?.blocked || 'unsupported', before, value: result?.state || before };
    actor.system.runtime.health = result.runtime;
    setResourceCurrent(actor, 'hp', result.current);
    return { changed: true, before, value: deriveInfiniteHorrorActor(actor).health };
  }
  const method = operation.type === 'health.damage' ? 'applyDamage' : 'applyHealing';
  const result = INFINITE_HORROR_HEALTH[method]({
    runtime,
    current: beforeContext.hp.current,
    max: beforeContext.hp.max,
    amount: operation.amount,
    type: operation.damageType,
  });
  actor.system.runtime.health = result.runtime;
  setResourceCurrent(actor, 'hp', result.current);
  return {
    changed: Boolean(result.applied),
    before,
    value: deriveInfiniteHorrorActor(actor).health,
    applied: result.applied || 0,
    overflow: result.overflow || 0,
    blocked: result.blocked || null,
  };
}

export function applyInfiniteHorrorActorOperation(actor, operation = {}, context = {}) {
  actor.system = normalizeInfiniteHorrorSystem(actor.system);
  const type = String(operation?.type || '');
  if (type === 'health.resolve') return { changed: false, value: deriveInfiniteHorrorActor(actor).health };
  if (['health.set-mode', 'health.runtime', 'health.damage', 'health.healing'].includes(type)) {
    return healthResult(actor, operation);
  }
  if (type === 'variant.add') {
    const form = formFromImport(operation.imported, {
      variantId: operation.variantId,
      variantName: operation.variantName,
      idFactory: context.idFactory || defaultIdFactory,
    });
    actor.system.forms.push(form);
    actor.system.currentFormId = form.id;
    for (const definition of INFINITE_HORROR_RESOURCE_DEFS) {
      actor.system.runtime.resources[definition.id] ||= {
        current: form.resourceBases?.[definition.id]?.baseMax || 0,
        maxOverride: null,
        policy: 'preserve',
      };
    }
    for (const status of form.badStatuses || []) {
      if (actor.system.runtime.badStatuses[status.id] === undefined) actor.system.runtime.badStatuses[status.id] = 0;
    }
    return { changed: true, value: clone(form) };
  }
  if (type === 'variant.set') {
    const form = actor.system.forms.find(item => String(item.id) === String(operation.variantId));
    if (!form) return { changed: false, blocked: 'variant_not_found' };
    const changed = String(actor.system.currentFormId) !== String(form.id);
    actor.system.currentFormId = form.id;
    return { changed, value: clone(form) };
  }
  if (type === 'variant.cycle') {
    const forms = actor.system.forms;
    if (forms.length < 2) return { changed: false, blocked: 'single_variant', value: clone(forms[0] || null) };
    const index = Math.max(0, forms.findIndex(form => String(form.id) === String(actor.system.currentFormId)));
    const direction = Number(operation.direction) >= 0 ? 1 : -1;
    const form = forms[(index + direction + forms.length) % forms.length];
    actor.system.currentFormId = form.id;
    return { changed: true, value: clone(form) };
  }
  if (type === 'resource.set-current') {
    setResourceCurrent(actor, operation.resourceId, operation.value);
    return { changed: true, value: resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.current`) };
  }
  if (type === 'resource.step') {
    const current = finite(resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.current`));
    setResourceCurrent(actor, operation.resourceId, current + finite(operation.amount));
    return { changed: true, value: resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.current`) };
  }
  if (type === 'resource.set-max') {
    setResourceMaximum(actor, operation.resourceId, operation.value);
    return { changed: true, value: resolveInfiniteHorrorAttribute(actor, `system.resources.${operation.resourceId}.max`) };
  }
  if (type === 'resource.add-custom') {
    const resourceId = identifier(operation.resourceId, (context.idFactory || defaultIdFactory)('resource'));
    const resource = {
      id: resourceId,
      name: text(operation.name, '特殊能量'),
      current: finite(operation.current),
      max: Math.max(0, finite(operation.max)),
      policy: 'preserve',
    };
    actor.system.runtime.customResources.push(resource);
    return { changed: true, value: clone(resource) };
  }
  if (type === 'resource.remove-custom') {
    const before = actor.system.runtime.customResources.length;
    actor.system.runtime.customResources = actor.system.runtime.customResources
      .filter(item => String(item.id) !== String(operation.resourceId));
    return { changed: actor.system.runtime.customResources.length !== before };
  }
  if (type === 'attribute.set-adjustment') {
    const value = finite(operation.value);
    if (!value) delete actor.system.runtime.attributeAdjustments[operation.attributeId];
    else actor.system.runtime.attributeAdjustments[operation.attributeId] = value;
    return { changed: true, value };
  }
  if (type === 'bad-status.set-current') {
    const value = Math.max(0, finite(operation.value));
    actor.system.runtime.badStatuses[operation.statusId] = value;
    return { changed: true, value };
  }
  if (type === 'avatar.set') {
    const form = currentFormFromSystem(actor.system);
    if (!form) return { changed: false, blocked: 'variant_not_found' };
    form.avatarDataUrl = typeof operation.avatarDataUrl === 'string' ? operation.avatarDataUrl : null;
    return { changed: true, value: form.avatarDataUrl };
  }
  return { changed: false, blocked: 'unsupported' };
}

function healthRole(resource) {
  return resource.id === 'hp' ? 'health-base' : '';
}

function statusLevel(status) {
  if (status.destruction > 0 && status.current >= status.destruction) return 'danger';
  if (status.severe > 0 && status.current >= status.severe) return 'severe';
  if (status.light > 0 && status.current >= status.light) return 'warning';
  return '';
}

export function describeInfiniteHorrorActor(actor) {
  const derived = deriveInfiniteHorrorActor(actor);
  const form = derived?.form;
  return {
    name: text(actor?.name, '未命名角色'),
    avatarDataUrl: form?.avatarDataUrl || null,
    color: text(form?.tokenAppearance?.color, '#3d9b63'),
    variantLabel: text(form?.name, '无形态'),
  };
}

export function describeInfiniteHorrorActorSheet(actor) {
  const derived = deriveInfiniteHorrorActor(actor);
  const form = derived?.form;
  const resources = (derived?.resources || []).map(resource => ({
    id: resource.id,
    label: resource.name,
    current: resource.current,
    max: resource.max,
    custom: resource.custom,
    role: healthRole(resource),
    currentOperation: { type: 'resource.set-current', resourceId: resource.id },
    maxOperation: { type: 'resource.set-max', resourceId: resource.id },
    decrementOperation: { type: 'resource.step', resourceId: resource.id, amount: -1 },
    deleteOperation: resource.custom ? { type: 'resource.remove-custom', resourceId: resource.id } : null,
  }));
  const attributes = (derived?.attributes || []).map(attribute => ({
    id: attribute.id,
    label: attribute.name,
    value: attribute.value,
    base: attribute.base,
    detail: attribute.legendaryBonus ? `基础 ${attribute.base} · 传奇 ${attribute.legendaryBonus}` : `基础 ${attribute.base}`,
    adjustment: attribute.adjustment,
    operation: { type: 'attribute.set-adjustment', attributeId: attribute.id },
  }));
  const table = (id, title, columns, rows, options = {}) => ({
    id, type: 'table', title, columns, rows, ...options,
  });
  return {
    actorId: String(actor?.id || ''),
    avatarDataUrl: form?.avatarDataUrl || null,
    color: text(form?.tokenAppearance?.color, '#3d9b63'),
    variants: (derived?.variants || []).map(item => ({ id: item.id, label: item.name })),
    currentVariantId: derived?.currentVariantId || null,
    tabs: [
      {
        id: 'overview', label: '概览', sections: [
          {
            id: 'resources', type: 'resources', title: '核心资源', items: resources,
            actions: [{
              label: '+ 添加特殊能量槽',
              prompts: [
                { key: 'name', label: '特殊能量槽名称：', defaultValue: '特殊能量' },
                { key: 'max', label: '最大值：', defaultValue: '10', number: true },
                { key: 'current', label: '当前值：', defaultFrom: 'max', number: true },
              ],
              operation: { type: 'resource.add-custom' },
            }],
          },
          {
            id: 'identity', type: 'text', title: '角色信息',
            blocks: [
              [form?.identity?.race, form?.identity?.gender, form?.identity?.age].filter(Boolean).join(' · '),
              form?.description?.summary || '',
            ].filter(Boolean),
          },
          {
            id: 'description', type: 'text', title: '当前形态描述',
            blocks: [form?.description?.appearance || '暂无外貌描述', form?.description?.personality || ''].filter(Boolean),
          },
        ],
      },
      {
        id: 'attributes', label: '属性', sections: [{
          id: 'attributes', type: 'stats', title: '属性', items: attributes,
          help: 'Excel 值作为 Base 保留；“临时”只修改 Runtime，不会覆盖重新导入的基础值。',
        }],
      },
      {
        id: 'checks', label: '鉴定', sections: [
          table('skills', '技能鉴定', ['分类', '技能', '鉴定', '等级 + 附加', '专业'],
            (form?.checks?.skills || []).map(skill => [skill.category, skill.name, skill.checkValue, `${skill.level} + ${skill.bonus}`, skill.specialties || ''])),
          table('saves', '豁免鉴定', ['类型', '当前鉴定', '总附加'],
            (form?.checks?.saves || []).map(save => [save.name, save.checkValue, save.totalBonus]), {
              emptyMessage: '暂无豁免速查数据。重新导入角色卡后会读取“具体数值表 → 检定速查”。',
            }),
        ],
      },
      {
        id: 'combat', label: '战斗', sections: [
          { id: 'attacks', type: 'empty', title: '攻击', message: '攻击结构已预留，暂不从 Excel 导入。' },
          { id: 'defenses', type: 'empty', title: '防御', message: '防御结构已预留，后续单独设计规则。' },
        ],
      },
      {
        id: 'bad-status', label: '不良状态', sections: [table(
          'bad-statuses',
          '不良状态',
          ['类型', '当前', '轻度', '重度', '毁灭'],
          (derived?.badStatuses || []).map(status => [
            status.name,
            {
              value: status.current,
              level: statusLevel(status),
              operation: { type: 'bad-status.set-current', statusId: status.id },
              input: true,
              min: 0,
            },
            status.light,
            status.severe,
            status.destruction,
          ]),
          { help: '“当前”由玩家直接填写；轻度、重度、毁灭为当前形态的标准。切换形态只切换标准，不会清空已经受到的不良点数。' },
        )],
      },
    ],
  };
}

export const INFINITE_HORROR_ACTOR = Object.freeze({
  resourceDefinitions: INFINITE_HORROR_RESOURCE_DEFS,
  badStatusDefinitions: INFINITE_HORROR_BAD_STATUS_DEFS,
  createDefault: createDefaultInfiniteHorrorActor,
  createFromImport: createInfiniteHorrorActorFromImport,
  migrateLegacy: migrateInfiniteHorrorActor,
  normalizeSystem: normalizeInfiniteHorrorSystem,
  validateSystem: validateInfiniteHorrorSystem,
  derive: deriveInfiniteHorrorActor,
  attributePaths: infiniteHorrorAttributePaths,
  resolveAttribute: resolveInfiniteHorrorAttribute,
  applyRuntimeOperation: applyInfiniteHorrorActorOperation,
  presentation: Object.freeze({
    describe: describeInfiniteHorrorActor,
    describeSheet: describeInfiniteHorrorActorSheet,
  }),
});
