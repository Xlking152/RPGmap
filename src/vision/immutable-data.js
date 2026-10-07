// Shared structural facts only: no user, permission or visibility result is
// stored here. Frozen own data lets geometry and audience preparation avoid
// independently traversing the same unchanged Token graphs.
const known = new WeakSet();

function stableJsonPrototypes() {
  for (const prototype of [Array.prototype, Object.prototype]) {
    for (let current = prototype; current; current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON');
      if (descriptor && (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function')) return false;
    }
  }
  return true;
}

function inspect(value, visiting) {
  if (value === null || !['object', 'function'].includes(typeof value))
    return !['function', 'symbol', 'bigint'].includes(typeof value);
  if (typeof value !== 'object' || !Object.isFrozen(value)
    || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (known.has(value)) return true;
  if (visiting.has(value)) return false;
  visiting.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Reflect.ownKeys(descriptors).every(key => typeof key === 'string'
    && Object.hasOwn(descriptors[key], 'value') && inspect(descriptors[key].value, visiting));
  visiting.delete(value);
  if (valid) known.add(value);
  return valid;
}

export function isImmutableVisionData(value) {
  return stableJsonPrototypes() && inspect(value, new WeakSet());
}

export function hasImmutableVisionData(value) {
  return stableJsonPrototypes() && known.has(value);
}

// Reuse descriptors already read by a container relationship check. Verify
// every descriptor against the current frozen container before recording it;
// callers cannot mint a proof by supplying a fabricated descriptor snapshot.
export function recordImmutableVisionData(value, descriptors) {
  if (!stableJsonPrototypes() || !value || !Object.isFrozen(value)
    || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value), descriptorKeys = Reflect.ownKeys(descriptors);
  if (keys.length !== descriptorKeys.length) return false;
  const visiting = new WeakSet([value]);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index], saved = descriptors[key], current = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || descriptorKeys[index] !== key || !current || !saved
      || !Object.hasOwn(current, 'value') || !Object.hasOwn(saved, 'value')
      || !Object.is(current.value, saved.value) || current.enumerable !== saved.enumerable
      || current.configurable !== saved.configurable || current.writable !== saved.writable
      || !inspect(current.value, visiting)) return false;
  }
  if (!stableJsonPrototypes()) return false;
  known.add(value);
  return true;
}
