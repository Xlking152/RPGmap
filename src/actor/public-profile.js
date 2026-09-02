export const ACTOR_PUBLIC_PROFILE_SCHEMA_VERSION = 1;
export const ACTOR_PUBLIC_PROFILE_LIMITS = Object.freeze({
  text: 2_000,
  facts: 20,
  fact: 200,
  statuses: 128,
});

function text(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function uniqueTextList(value, { count, length }) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const normalized = text(item, length);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= count) break;
  }
  return result;
}

function extensionFields(source) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (['schemaVersion', 'summary', 'appearance', 'knownFacts', 'visibleStatusDefinitionIds'].includes(key)) continue;
    if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    result[key] = structuredClone(value);
  }
  return result;
}

export function normalizeActorPublicProfile(raw = {}, { statusDefinitionIds = null, preserveUnknown = true } = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = statusDefinitionIds == null
    ? null
    : new Set((Array.isArray(statusDefinitionIds) ? statusDefinitionIds : [...statusDefinitionIds]).map(String));
  const visibleStatusDefinitionIds = uniqueTextList(source.visibleStatusDefinitionIds, {
    count: ACTOR_PUBLIC_PROFILE_LIMITS.statuses,
    length: 160,
  }).filter(id => !allowed || allowed.has(id));
  return {
    ...(preserveUnknown ? extensionFields(source) : {}),
    schemaVersion: ACTOR_PUBLIC_PROFILE_SCHEMA_VERSION,
    summary: text(source.summary, ACTOR_PUBLIC_PROFILE_LIMITS.text),
    appearance: text(source.appearance, ACTOR_PUBLIC_PROFILE_LIMITS.text),
    knownFacts: uniqueTextList(source.knownFacts, {
      count: ACTOR_PUBLIC_PROFILE_LIMITS.facts,
      length: ACTOR_PUBLIC_PROFILE_LIMITS.fact,
    }),
    visibleStatusDefinitionIds,
  };
}

export function actorPublicProfileHasContent(profile) {
  const value = normalizeActorPublicProfile(profile);
  return Boolean(value.summary || value.appearance || value.knownFacts.length || value.visibleStatusDefinitionIds.length);
}
