import { INFINITE_HORROR_RESOURCE_DEFS, INFINITE_HORROR_BAD_STATUS_DEFS } from '../rulesets/infinite-horror/definitions.js';
import { STATUS_ICON_NAMES } from '../status/model.js';

// Both realms capture their own recipe. A main-thread table changed before
// this module loaded must also match the fresh Worker's built-in tables.
const ownKeys = Reflect.ownKeys;
const getDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const stringify = JSON.stringify;
const setHas = Set.prototype.has;
const setValues = Set.prototype.values;
const setIterator = Set.prototype[Symbol.iterator];
const functionSource = Function.prototype.toString;
const native = value => typeof value === 'function' && functionSource.call(value).includes('[native code]');
const platformNames = ['Object', 'Array', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'RegExp', 'ArrayBuffer', 'DataView',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Number', 'String', 'Boolean', 'BigInt', 'Function', 'Symbol', 'JSON', 'Reflect', 'Math',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite'];

function platformSurfaces() {
  const surfaces = [];
  for (const name of platformNames) {
    const descriptor = getDescriptor(globalThis, name);
    const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    surfaces.push([name, value]);
    const prototype = typeof value === 'function' ? getDescriptor(value, 'prototype') : null;
    if (prototype && Object.hasOwn(prototype, 'value')) surfaces.push([`${name}.prototype`, prototype.value]);
  }
  surfaces.push(['TypedArray.prototype', getPrototypeOf(Uint8Array.prototype)]);
  return surfaces;
}

// Capture complete small platform tables, including inherited defaults and
// native methods such as flatMap. This is constant-sized, never a World walk.
function capturePlatform() {
  const surfaces = platformSurfaces(), labels = new Map(surfaces.map(([name, value]) => [value, name]));
  const snapshots = [], visiting = new Set();
  function valueFingerprint(value) {
    if (typeof value === 'function') return ['function', functionSource.call(value)];
    if (value && typeof value === 'object') {
      if (labels.has(value)) return ['surface', labels.get(value)];
      if (visiting.has(value)) return ['cycle'];
      visiting.add(value);
      const fields = captureFields(value);
      visiting.delete(value);
      return ['object', fields];
    }
    if (typeof value === 'symbol') return ['symbol', String(value)];
    if (typeof value === 'number') return ['number', String(value)];
    return [typeof value, String(value)];
  }
  function captureFields(surface) {
    const descriptors = ownKeys(surface).map(key => [key, getDescriptor(surface, key)]);
    snapshots.push({ surface, descriptors, prototype: getPrototypeOf(surface) });
    const fields = descriptors.map(([key, descriptor]) => [typeof key === 'symbol' ? String(key) : key,
      descriptor.enumerable, descriptor.configurable,
      Object.hasOwn(descriptor, 'value')
        ? ['data', descriptor.writable, valueFingerprint(descriptor.value)]
        : ['accessor', valueFingerprint(descriptor.get), valueFingerprint(descriptor.set)]]);
    return [valueFingerprint(getPrototypeOf(surface)), fields];
  }
  const fingerprint = stringify([surfaces.map(([name, value]) => [name, value === undefined ? null : captureFields(value)]),
    functionSource.call(globalThis.structuredClone)]);
  return { surfaces, snapshots, fingerprint };
}

// Stock Node structuredClone is JS; the independent realm fingerprint checks
// it too. Browser native implementations produce the same native source text.
const initialPlatform = native(stringify) && native(functionSource)
  && [ownKeys, getDescriptor, getPrototypeOf, setHas, setValues, setIterator].every(native)
  ? capturePlatform() : null;

function plainDataRecord(source) {
  if (!source || typeof source !== 'object' || ![Object.prototype, null].includes(getPrototypeOf(source))) return null;
  const result = {};
  for (const key of ownKeys(source)) {
    const descriptor = getDescriptor(source, key);
    if (typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
      || !descriptor.enumerable || !['string', 'number', 'boolean'].includes(typeof descriptor.value)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function recipe() {
  if (getPrototypeOf(STATUS_ICON_NAMES) !== Set.prototype || ownKeys(STATUS_ICON_NAMES).length
    || STATUS_ICON_NAMES.has !== setHas || STATUS_ICON_NAMES.values !== setValues
    || STATUS_ICON_NAMES[Symbol.iterator] !== setIterator) return null;
  const resources = INFINITE_HORROR_RESOURCE_DEFS.map(plainDataRecord);
  const statuses = INFINITE_HORROR_BAD_STATUS_DEFS.map(plainDataRecord);
  if (resources.includes(null) || statuses.includes(null)) return null;
  return stringify([resources, statuses, [...setValues.call(STATUS_ICON_NAMES)], initialPlatform?.fingerprint]);
}

function sameDescriptor(a, b) {
  if (!a || !b) return a === b;
  return Object.is(a.value, b.value) && a.get === b.get && a.set === b.set
    && a.enumerable === b.enumerable && a.configurable === b.configurable && a.writable === b.writable;
}

function unchangedPlatform() {
  return JSON.stringify === stringify && Reflect.ownKeys === ownKeys
    && Object.getOwnPropertyDescriptor === getDescriptor && Object.getPrototypeOf === getPrototypeOf
    && initialPlatform && platformSurfaces().every(([name, value], index) => name === initialPlatform.surfaces[index]?.[0]
      && value === initialPlatform.surfaces[index][1])
    && initialPlatform.snapshots.every(({ surface, descriptors, prototype }) => {
      const keys = ownKeys(surface);
      return getPrototypeOf(surface) === prototype && keys.length === descriptors.length && descriptors.every(([key, descriptor], index) => keys[index] === key
        && sameDescriptor(getDescriptor(surface, key), descriptor));
    }) && functionSource.call(globalThis.structuredClone) === stringifyCloneSource;
}

const stringifyCloneSource = functionSource.call(globalThis.structuredClone);
const initialRecipe = recipe();

export function currentWorldValidationRecipe() {
  try {
    if (!initialPlatform || !unchangedPlatform() || Function.prototype.toString !== functionSource) return null;
    // Host constructors can expose different lazy global descriptors between
    // Window and Worker. Their normal methods are outside the JSON recipe;
    // an explicit JSON hook still requires the original local save path.
    for (const name of ['Blob', 'File', 'DOMException']) {
      const constructor = globalThis[name];
      if (typeof constructor !== 'function') continue;
      let prototype = getDescriptor(constructor, 'prototype')?.value;
      while (prototype && prototype !== Object.prototype) {
        if (getDescriptor(prototype, 'toJSON')) return null;
        prototype = getPrototypeOf(prototype);
      }
    }
    const current = recipe();
    return current && current === initialRecipe ? current : null;
  } catch { return null; }
}

const mapFields = ['mapId', 'id', 'mapVersion', 'version', 'title', 'name'];

function copyFields(source, fields) {
  if (!source || typeof source !== 'object' || ![Object.prototype, null].includes(getPrototypeOf(source))) return null;
  const result = {};
  for (const key of fields) {
    const descriptor = getDescriptor(source, key);
    if (!descriptor) {
      if (key in source) return null;
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value')) return null;
    const value = descriptor.value;
    if (value !== null && !['undefined', 'string', 'number', 'boolean'].includes(typeof value)) return null;
    result[key] = value;
  }
  return result;
}

/** Only the metadata actually read by the complete export continuation. */
export function copyWorldValidationMap(mapPackage) {
  try {
    const result = copyFields(mapPackage, mapFields);
    if (!result) return null;
    const manifestDescriptor = getDescriptor(mapPackage, 'manifest');
    if (manifestDescriptor ? !Object.hasOwn(manifestDescriptor, 'value') : 'manifest' in mapPackage) return null;
    // Prepared MapPackages always own id/version. These nonnull primitives
    // make all manifest aliases unreachable; no nested Proxy is transferred.
    if ((result.mapId ?? result.id) == null || (result.mapVersion ?? result.version) == null) return null;
    return result;
  } catch { return null; }
}

export function sameWorldValidationMap(a, b) {
  if (!a || !b) return false;
  const equalFields = (left, right, fields) => fields.every(key => Object.hasOwn(left, key) === Object.hasOwn(right, key)
    && Object.is(left[key], right[key]));
  return equalFields(a, b, mapFields);
}
