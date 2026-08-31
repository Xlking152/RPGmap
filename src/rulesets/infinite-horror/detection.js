export const INFINITE_HORROR_DETECTION_SENSES = Object.freeze([
  'trueSight',
  'xrayVision',
  'spiritSight',
  'lowLightVision',
  'darkvision',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function range(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function normalizeSenses(raw = {}, { partial = false } = {}) {
  const source = object(raw);
  const result = { ...structuredClone(source) };
  for (const key of INFINITE_HORROR_DETECTION_SENSES) {
    if (partial && source[key] === undefined) delete result[key];
    else result[key] = source[key] === true;
  }
  return result;
}

export function normalizeInfiniteHorrorDetection(raw = {}, { configured = null } = {}) {
  const source = object(raw);
  const preciseRangeMeters = range(source.preciseRangeMeters);
  const vagueRangeMeters = Math.max(preciseRangeMeters, range(source.vagueRangeMeters));
  return {
    ...structuredClone(source),
    configured: configured == null ? source.configured === true : configured === true,
    preciseRangeMeters,
    vagueRangeMeters,
    senses: normalizeSenses(source.senses),
  };
}

export function normalizeInfiniteHorrorDetectionOverride(raw = {}) {
  const source = object(raw);
  const result = { ...structuredClone(source) };
  if (source.preciseRangeMeters === undefined || source.preciseRangeMeters === null || source.preciseRangeMeters === '') {
    delete result.preciseRangeMeters;
  } else result.preciseRangeMeters = range(source.preciseRangeMeters);
  if (source.vagueRangeMeters === undefined || source.vagueRangeMeters === null || source.vagueRangeMeters === '') {
    delete result.vagueRangeMeters;
  } else result.vagueRangeMeters = range(source.vagueRangeMeters);
  result.senses = normalizeSenses(source.senses, { partial: true });
  if (!Object.keys(result.senses).length) delete result.senses;
  return result;
}

export function resolveInfiniteHorrorDetection({ form, runtime, perception = null, lighting = 'normal' } = {}) {
  const base = normalizeInfiniteHorrorDetection(form?.detection, {
    configured: form?.detection?.configured === true,
  });
  const perceptionValue = perception === null || perception === undefined ? 1 : Number(perception);
  const fallback = Math.max(20, Math.min(120, 30 + (Number.isFinite(perceptionValue) ? perceptionValue : 1) * 10));
  const override = normalizeInfiniteHorrorDetectionOverride(runtime?.detectionOverrides);
  let preciseRangeMeters = override.preciseRangeMeters ?? (base.configured ? base.preciseRangeMeters : fallback);
  let vagueRangeMeters = override.vagueRangeMeters ?? (base.configured ? base.vagueRangeMeters : preciseRangeMeters);
  vagueRangeMeters = Math.max(preciseRangeMeters, vagueRangeMeters);
  const senses = { ...base.senses, ...object(override.senses) };
  const normalizedLighting = ['normal', 'dim', 'dark'].includes(String(lighting)) ? String(lighting) : 'normal';

  if (normalizedLighting === 'dim' && !senses.lowLightVision) {
    vagueRangeMeters = Math.max(vagueRangeMeters, preciseRangeMeters);
    preciseRangeMeters = 0;
  } else if (normalizedLighting === 'dark' && !senses.darkvision) {
    preciseRangeMeters = 0;
    vagueRangeMeters = 0;
  }

  return Object.freeze({
    enabled: vagueRangeMeters > 0,
    rangeMeters: preciseRangeMeters,
    preciseRangeMeters,
    vagueRangeMeters: Math.max(preciseRangeMeters, vagueRangeMeters),
    senses: Object.freeze({ ...senses }),
    lighting: normalizedLighting,
    source: override.preciseRangeMeters !== undefined || override.vagueRangeMeters !== undefined
      ? 'system.runtime.detectionOverrides'
      : base.configured ? 'form.detection' : 'system.attributes.perception',
  });
}
