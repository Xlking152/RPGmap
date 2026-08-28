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

export function setResourceCurrent(actor, resourceId, value, context = {}) {
  return performActorOperation(actor, { type: 'resource.set-current', resourceId, value }, context).value;
}

export function setResourceMaxOverride(actor, resourceId, value, context = {}) {
  return performActorOperation(actor, { type: 'resource.set-max', resourceId, value }, context).value;
}

export function setAttributeAdjustment(actor, attributeId, value, context = {}) {
  return performActorOperation(actor, { type: 'attribute.set-adjustment', attributeId, value }, context).value;
}

export function addCustomResource(actor, { id, name, current = 0, max = 0 } = {}, context = {}) {
  return performActorOperation(actor, {
    type: 'resource.add-custom',
    resourceId: id,
    name,
    current,
    max,
  }, context).value;
}

export function removeCustomResource(actor, resourceId, context = {}) {
  return performActorOperation(actor, { type: 'resource.remove-custom', resourceId }, context).changed;
}

export function setActorForm(actor, formId, context = {}) {
  return performActorOperation(actor, { type: 'variant.set', variantId: formId }, context).value || null;
}

export function cycleActorForm(actor, direction = 1, context = {}) {
  return performActorOperation(actor, { type: 'variant.cycle', direction }, context).value || null;
}

function canonicalEffectPath(actor, target, context) {
  const raw = String(target || '');
  const paths = new Set(listActorAttributePaths(actor, context).map(item => String(item?.path || '')).filter(Boolean));
  if (paths.has(raw)) return raw;
  const systemPath = raw.startsWith('system.') ? raw : `system.${raw}`;
  if (paths.has(systemPath)) return systemPath;
  const error = new Error(`Unknown Actor attribute path: ${raw || '(empty)'}`);
  error.code = 'unknown_actor_attribute_path';
  throw error;
}

export function addEffect(actor, { name = '临时效果', enabled = true, changes = [] } = {}, context = {}) {
  actor.effects ||= [];
  const effect = {
    id: `effect-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
    name: String(name || '临时效果'),
    enabled,
    changes: changes.map(change => ({
      target: canonicalEffectPath(actor, change.target, context),
      mode: change.mode || 'add',
      value: finite(change.value),
    })).filter(change => change.target),
  };
  actor.effects.push(effect);
  return effect;
}

export { listActorAttributePaths, performActorOperation, resolveActorAttribute };
