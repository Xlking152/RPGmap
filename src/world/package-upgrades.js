const clone = structuredClone;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function upgradeBuiltInRulesetReference(reference, schemaVersion = null) {
  const source = plainObject(reference) ? reference : {};
  if (Number(schemaVersion) < 4 && source.id === 'infinite-horror' && source.version === '1.0.0') {
    return Object.freeze({ ...clone(source), version: '1.1.0' });
  }
  return Object.freeze(clone(source));
}
export function upgradeBuiltInMapReference(reference, schemaVersion = null) {
  const source = plainObject(reference) ? reference : {};
  if (Number(schemaVersion) < 4 && source.id === 'northern-song-lanzhou-1104'
    && ['1.0.5', '1.0.6'].includes(String(source.version))) {
    return Object.freeze({ ...clone(source), version: '1.1.0' });
  }
  return Object.freeze(clone(source));
}
