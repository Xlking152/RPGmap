import {
  deriveActorDocument,
  listActorAttributePaths,
  performActorOperation,
  resolveActorAttribute,
} from '../actor/index.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function resolveActor(actor, context = {}) {
  return deriveActorDocument(actor, context);
}

export function resolveAttribute(actor, attributeId, context = {}) {
  return deriveActorDocument(actor, context)?.attributes?.find(item => String(item.id) === String(attributeId)) || null;
}

export function resolveResource(actor, resourceId, context = {}) {
  return deriveActorDocument(actor, context)?.resources?.find(item => String(item.id) === String(resourceId)) || null;
}

export function setResourceCurrent(actor, resourceId, value) {
  return performActorOperation(actor, { type: 'resource.set-current', resourceId, value }).value;
}

export function setResourceMaxOverride(actor, resourceId, value) {
  return performActorOperation(actor, { type: 'resource.set-max', resourceId, value }).value;
}

export function setAttributeAdjustment(actor, attributeId, value) {
  return performActorOperation(actor, { type: 'attribute.set-adjustment', attributeId, value }).value;
}

export function addCustomResource(actor, { id, name, current = 0, max = 0 } = {}) {
  return performActorOperation(actor, {
    type: 'resource.add-custom',
    resourceId: id,
    name,
    current,
    max,
  }).value;
}

export function removeCustomResource(actor, resourceId) {
  return performActorOperation(actor, { type: 'resource.remove-custom', resourceId }).changed;
}

export function setActorForm(actor, formId) {
  return performActorOperation(actor, { type: 'variant.set', variantId: formId }).value || null;
}

export function cycleActorForm(actor, direction = 1) {
  return performActorOperation(actor, { type: 'variant.cycle', direction }).value || null;
}

function canonicalEffectPath(actor, target) {
  const raw = String(target || '');
  const paths = new Set(listActorAttributePaths(actor).map(item => String(item?.path || '')).filter(Boolean));
  if (paths.has(raw)) return raw;
  const systemPath = raw.startsWith('system.') ? raw : `system.${raw}`;
  return paths.has(systemPath) ? systemPath : raw;
}

export function addEffect(actor, { name = '临时效果', enabled = true, changes = [] } = {}) {
  actor.effects ||= [];
  const effect = {
    id: `effect-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    name: String(name || '临时效果'),
    enabled,
    changes: changes.map(change => ({
      target: canonicalEffectPath(actor, change.target),
      mode: change.mode || 'add',
      value: finite(change.value),
    })).filter(change => change.target),
  };
  actor.effects.push(effect);
  return effect;
}

export { listActorAttributePaths, performActorOperation, resolveActorAttribute };
