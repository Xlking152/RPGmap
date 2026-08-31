import { getCompatibilityRuleset } from '../ruleset/active-compat.js';
import { normalizeActorClassification } from './classification.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || fallback;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function image(value) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || null;
}

function normalizePrototypeToken(raw, actorImg = null) {
  const source = object(raw);
  const textureSource = typeof source.texture === 'string'
    ? source.texture
    : object(source.texture).src;
  return {
    ...clone(source),
    texture: {
      ...clone(object(source.texture)),
      src: image(textureSource) || image(actorImg),
    },
    color: text(source.color, '#3d9b63'),
    diameterMeters: Math.max(0.1, finite(source.diameterMeters ?? source.size, 1)),
    showName: source.showName !== false,
  };
}

function uid(prefix) {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return `${prefix}-${value}`;
}

function actorRules(ruleset = getCompatibilityRuleset()) {
  const actor = ruleset?.actor;
  const required = [
    'createDefault', 'createFromImport', 'migrateLegacy', 'normalizeSystem',
    'validateSystem', 'derive', 'attributePaths', 'resolveAttribute', 'applyRuntimeOperation',
  ];
  for (const key of required) {
    if (typeof actor?.[key] !== 'function') throw new Error(`Active ruleset does not implement actor.${key}`);
  }
  return actor;
}

function compatibleActor(actor, ruleset = getCompatibilityRuleset()) {
  if (actor?.system && typeof actor.system === 'object' && !Array.isArray(actor.system)) return actor;
  return createActorDocument(actor, { ruleset });
}

function shell(raw = {}, {
  name = '',
  system = {},
  img = undefined,
  prototypeToken = undefined,
} = {}) {
  const source = object(raw);
  const now = new Date().toISOString();
  const actorImg = image(img === undefined ? source.img : img);
  const prototype = prototypeToken === undefined ? source.prototypeToken : prototypeToken;
  const classification = normalizeActorClassification(source, {
    legacy: source.type === undefined && source.partyId === undefined,
  });
  const document = {
    ...clone(source),
    id: text(source.id == null ? '' : String(source.id), uid('actor')),
    name: text(name, text(source.name, '未命名角色')).slice(0, 80),
    img: actorImg,
    prototypeToken: normalizePrototypeToken(prototype, actorImg),
    type: classification.type,
    partyId: classification.partyId,
    system: clone(object(system)),
    effects: Array.isArray(source.effects) ? clone(source.effects) : [],
    notes: typeof source.notes === 'string' ? source.notes : '',
    createdAt: text(source.createdAt, now),
    updatedAt: text(source.updatedAt, text(source.createdAt, now)),
  };
  delete document.forms;
  delete document.currentFormId;
  delete document.runtime;
  return document;
}

export function createActorDocument(raw = {}, { ruleset = getCompatibilityRuleset() } = {}) {
  const rules = actorRules(ruleset);
  const migrated = object(rules.migrateLegacy(clone(object(raw)), { ruleset }));
  const normalized = rules.normalizeSystem(migrated.system, { actor: raw, ruleset });
  return shell(raw, {
    name: migrated.name,
    system: normalized,
    img: migrated.img === undefined ? raw?.img : migrated.img,
    prototypeToken: migrated.prototypeToken === undefined ? raw?.prototypeToken : migrated.prototypeToken,
  });
}

export function createDefaultActor({ id, name, type = 'pc', partyId = undefined, ruleset = getCompatibilityRuleset() } = {}) {
  const rules = actorRules(ruleset);
  const created = object(rules.createDefault({ id, name, ruleset }));
  const raw = { id, name: name || created.name, type, partyId };
  return shell(raw, {
    name: name || created.name,
    img: created.img,
    prototypeToken: created.prototypeToken,
    system: rules.normalizeSystem(created.system, { actor: raw, ruleset }),
  });
}

export function createActorFromRulesetImport(imported, {
  id,
  name,
  type = 'pc',
  partyId = undefined,
  variantId,
  variantName,
  ruleset = getCompatibilityRuleset(),
} = {}) {
  const rules = actorRules(ruleset);
  const created = object(rules.createFromImport(clone(imported), {
    actorId: id,
    name,
    variantId,
    variantName,
    idFactory: uid,
    ruleset,
  }));
  const raw = { id, name: name || created.name, type, partyId };
  return shell(raw, {
    name: name || created.name,
    img: created.img,
    prototypeToken: created.prototypeToken,
    system: rules.normalizeSystem(created.system, { actor: raw, ruleset }),
  });
}

export function normalizeActorDocument(actor, { ruleset = getCompatibilityRuleset() } = {}) {
  return createActorDocument(actor, { ruleset });
}

export function validateActorDocument(actor, { ruleset = getCompatibilityRuleset() } = {}) {
  const documentErrors = [];
  if (!text(actor?.id == null ? '' : String(actor.id))) documentErrors.push('actor.id is required');
  if (!text(actor?.name)) documentErrors.push('actor.name is required');
  if (!actor?.prototypeToken || typeof actor.prototypeToken !== 'object' || Array.isArray(actor.prototypeToken)) {
    documentErrors.push('actor.prototypeToken must be an object');
  }
  if (!actor?.system || typeof actor.system !== 'object' || Array.isArray(actor.system)) {
    documentErrors.push('actor.system must be an object');
  }
  const systemErrors = actorRules(ruleset).validateSystem(actor?.system, { actor, ruleset });
  return [...documentErrors, ...(Array.isArray(systemErrors) ? systemErrors.map(String) : [])];
}

export function deriveActorDocument(actor, context = {}) {
  if (!actor) return null;
  const ruleset = getCompatibilityRuleset(context.ruleset);
  return actorRules(ruleset).derive(compatibleActor(actor, ruleset), context);
}

export function describeActor(actor, context = {}) {
  if (!actor) return null;
  const ruleset = getCompatibilityRuleset(context.ruleset);
  return actorRules(ruleset).presentation.describe(compatibleActor(actor, ruleset), context);
}

export function describeActorSheet(actor, context = {}) {
  if (!actor) return null;
  const ruleset = getCompatibilityRuleset(context.ruleset);
  return actorRules(ruleset).presentation.describeSheet(compatibleActor(actor, ruleset), context);
}

export function listActorAttributePaths(actor, context = {}) {
  if (!actor) return [];
  const ruleset = getCompatibilityRuleset(context.ruleset);
  const value = actorRules(ruleset).attributePaths(compatibleActor(actor, ruleset), context);
  return Array.isArray(value) ? value : [];
}

export function resolveActorAttribute(actor, path, context = {}) {
  if (!actor) return null;
  const ruleset = getCompatibilityRuleset(context.ruleset);
  return actorRules(ruleset).resolveAttribute(compatibleActor(actor, ruleset), String(path || ''), context);
}

export function performActorOperation(actor, operation = {}, context = {}) {
  if (!actor) return { changed: false, blocked: 'missing_actor' };
  const ruleset = getCompatibilityRuleset(context.ruleset);
  if (!actor.system || typeof actor.system !== 'object' || Array.isArray(actor.system)) {
    const normalized = createActorDocument(actor, { ruleset });
    for (const key of Object.keys(actor)) delete actor[key];
    Object.assign(actor, normalized);
  }
  actor.system = actorRules(ruleset).normalizeSystem(actor.system, { actor, ...context });
  const result = actorRules(ruleset).applyRuntimeOperation(actor, clone(operation), context) || {};
  if (result.changed) actor.updatedAt = new Date().toISOString();
  return {
    changed: result.changed === true,
    blocked: result.blocked || null,
    ...result,
  };
}
