import { defaultHealthMode, normalizeHealthRuntime, resolveHealth } from '../health/model.js';
import { currentForm } from './model.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function applyMode(current, mode, value) {
  const amount = finite(value);
  if (mode === 'set') return amount;
  if (mode === 'multiply') return current * amount;
  if (mode === 'min') return Math.min(current, amount);
  if (mode === 'max') return Math.max(current, amount);
  return current + amount;
}

function effectsFor(actor, target) {
  return (actor?.effects || []).filter(effect => effect?.enabled !== false)
    .flatMap(effect => (effect.changes || []).map(change => ({
      ...change,
      // Stackable definitions are restricted to additive changes. Project the
      // linear stack value here so every existing resource/attribute resolver
      // consumes the canonical status semantics without a second code path.
      value: change?.mode === 'add'
        ? finite(change?.value) * Math.max(1, Math.floor(finite(effect?.stacks, 1)))
        : change?.value,
    })))
    .filter(change => change?.target === target);
}

export function resolveAttribute(actor, attributeId) {
  const form = currentForm(actor);
  const source = form?.attributes?.find(item => item.id === attributeId);
  if (!source) return null;
  let value = finite(source.base ?? source.value);
  value += finite(actor.runtime?.attributeAdjustments?.[attributeId]);
  for (const change of effectsFor(actor, `attributes.${attributeId}`)) {
    value = applyMode(value, change.mode, change.value);
  }
  return { ...source, base: finite(source.base ?? source.value), value };
}

export function resolveResource(actor, resourceId) {
  const form = currentForm(actor);
  const custom = actor?.runtime?.customResources?.find(item => item.id === resourceId);
  if (custom) {
    let max = Math.max(0, finite(custom.max));
    for (const change of effectsFor(actor, `resources.${resourceId}.max`)) max = applyMode(max, change.mode, change.value);
    let current = finite(custom.current);
    for (const change of effectsFor(actor, `resources.${resourceId}.current`)) current = applyMode(current, change.mode, change.value);
    return { ...custom, max, current, custom: true };
  }
  const base = form?.resourceBases?.[resourceId];
  if (!base) return null;
  const runtime = actor.runtime?.resources?.[resourceId] || { current: base.baseMax, maxOverride: null, policy: 'preserve' };
  let max = runtime.maxOverride === null || runtime.maxOverride === undefined
    ? finite(base.baseMax)
    : finite(runtime.maxOverride);
  for (const change of effectsFor(actor, `resources.${resourceId}.max`)) max = applyMode(max, change.mode, change.value);
  let current = finite(runtime.current, max);
  for (const change of effectsFor(actor, `resources.${resourceId}.current`)) current = applyMode(current, change.mode, change.value);
  return { id: resourceId, name: base.name, kind: base.kind, baseMax: finite(base.baseMax), max, current, policy: runtime.policy || 'preserve', custom: false };
}

export function resolveBadStatus(actor, statusId) {
  const form = currentForm(actor);
  const base = form?.badStatuses?.find(item => item.id === statusId);
  if (!base) return null;
  return {
    ...base,
    light: Math.max(0, finite(base.light)),
    severe: Math.max(0, finite(base.severe)),
    destruction: Math.max(0, finite(base.destruction)),
    current: Math.max(0, finite(actor.runtime?.badStatuses?.[statusId])),
  };
}

export function resolveActor(actor) {
  const form = currentForm(actor);
  if (!form) return null;
  const resources = [...Object.keys(form.resourceBases || {}), ...(actor.runtime?.customResources || []).map(item => item.id)]
    .map(id => resolveResource(actor, id)).filter(Boolean);
  const hp = resources.find(resource => resource.id === 'hp') || { max: 0, current: 0 };
  const healthRuntime = normalizeHealthRuntime(actor.runtime?.health, {
    defaultMode: defaultHealthMode(form.source?.type),
    max: hp.max,
    simpleCurrent: hp.current,
  });
  return {
    id: actor.id,
    name: actor.name,
    form,
    resources,
    health: resolveHealth(healthRuntime, { max: hp.max, simpleCurrent: hp.current }),
    attributes: (form.attributes || []).map(item => resolveAttribute(actor, item.id)).filter(Boolean),
    checks: form.checks || { skills: [], saves: [] },
    badStatuses: (form.badStatuses || []).map(item => resolveBadStatus(actor, item.id)).filter(Boolean),
    combat: form.combat || { attacks: [], defenses: [] },
  };
}

export function setResourceCurrent(actor, resourceId, value) {
  const custom = actor.runtime?.customResources?.find(item => item.id === resourceId);
  if (custom) {
    custom.current = finite(value);
    return custom.current;
  }
  actor.runtime.resources ||= {};
  actor.runtime.resources[resourceId] ||= { current: 0, maxOverride: null, policy: 'preserve' };
  actor.runtime.resources[resourceId].current = finite(value);
  return actor.runtime.resources[resourceId].current;
}

export function setResourceMaxOverride(actor, resourceId, value) {
  const custom = actor.runtime?.customResources?.find(item => item.id === resourceId);
  if (custom) {
    custom.max = Math.max(0, finite(value));
    return custom.max;
  }
  actor.runtime.resources ||= {};
  actor.runtime.resources[resourceId] ||= { current: 0, maxOverride: null, policy: 'preserve' };
  actor.runtime.resources[resourceId].maxOverride = value === '' || value === null || value === undefined ? null : Math.max(0, finite(value));
  return actor.runtime.resources[resourceId].maxOverride;
}

export function setAttributeAdjustment(actor, attributeId, value) {
  actor.runtime.attributeAdjustments ||= {};
  const number = finite(value);
  if (!number) delete actor.runtime.attributeAdjustments[attributeId];
  else actor.runtime.attributeAdjustments[attributeId] = number;
  return number;
}

export function setBadStatusCurrent(actor, statusId, value) {
  actor.runtime.badStatuses ||= {};
  const current = Math.max(0, finite(value));
  actor.runtime.badStatuses[statusId] = current;
  return current;
}

export function addCustomResource(actor, { id, name, current = 0, max = 0 } = {}) {
  actor.runtime.customResources ||= [];
  const resourceId = id || `resource-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
  const resource = { id: resourceId, name: String(name || '特殊能量').trim() || '特殊能量', current: finite(current), max: Math.max(0, finite(max)), policy: 'preserve' };
  actor.runtime.customResources.push(resource);
  return resource;
}

export function removeCustomResource(actor, resourceId) {
  const before = actor.runtime?.customResources?.length || 0;
  actor.runtime.customResources = (actor.runtime?.customResources || []).filter(item => item.id !== resourceId);
  return actor.runtime.customResources.length !== before;
}

export function setActorForm(actor, formId) {
  const next = actor.forms?.find(form => form.id === formId);
  if (!next) return null;
  actor.currentFormId = next.id;
  actor.updatedAt = new Date().toISOString();
  return next;
}

export function cycleActorForm(actor, direction = 1) {
  const forms = actor?.forms || [];
  if (forms.length < 2) return currentForm(actor);
  const index = Math.max(0, forms.findIndex(form => form.id === actor.currentFormId));
  const nextIndex = (index + (direction >= 0 ? 1 : -1) + forms.length) % forms.length;
  return setActorForm(actor, forms[nextIndex].id);
}

export function addEffect(actor, { name = '临时效果', enabled = true, changes = [] } = {}) {
  actor.effects ||= [];
  const effect = {
    id: `effect-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    name: String(name || '临时效果'),
    enabled,
    changes: changes.map(change => ({ target: String(change.target || ''), mode: change.mode || 'add', value: finite(change.value) })).filter(change => change.target),
  };
  actor.effects.push(effect);
  return effect;
}
