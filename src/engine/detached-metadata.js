// Copy extensions once; separately prepared replacement fields need not be
// copied first. Preserve source key order for stable saved JSON bytes.
export function cloneWithReplacements(source, replacements, { preserveContainer = false } = {}) {
  const prototype = source && typeof source === 'object' ? Object.getPrototypeOf(source) : undefined;
  if (prototype !== Object.prototype && prototype !== null) {
    const next = preserveContainer ? structuredClone(source) : { ...structuredClone(source) };
    for (const [key, value] of Object.entries(replacements)) next[key] = value;
    return next;
  }
  const keys = Object.keys(source);
  for (const key of keys) {
    if (!Object.hasOwn(replacements, key)) continue;
    const value = source[key];
    // Direct callers still reject unsupported scalar values even when a
    // normalizer would replace them with a default. Nested documents continue
    // through their existing full validation/normalization boundaries.
    if (typeof value === 'function' || typeof value === 'symbol') structuredClone(value);
  }
  const metadata = structuredClone(Object.fromEntries(keys
    .filter(key => !Object.hasOwn(replacements, key)).map(key => [key, source[key]])));
  return Object.fromEntries([
    ...keys.map(key => [key, Object.hasOwn(replacements, key) ? replacements[key] : metadata[key]]),
    ...Object.entries(replacements).filter(([key]) => !Object.hasOwn(source, key)),
  ]);
}
