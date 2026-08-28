import {
  deriveActorDocument,
  listActorAttributePaths,
  performActorOperation,
  resolveActorAttribute,
} from '../actor/index.js';

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

export { listActorAttributePaths, performActorOperation, resolveActorAttribute };
