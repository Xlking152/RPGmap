export const ACTOR_TYPES = Object.freeze(['pc', 'npc', 'summon', 'other']);

const ACTOR_TYPE_SET = new Set(ACTOR_TYPES);

export function normalizeActorType(value, fallback = 'pc') {
  const type = String(value ?? '').trim().toLowerCase();
  return ACTOR_TYPE_SET.has(type) ? type : fallback;
}

export function normalizePartyId(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const partyId = String(value).trim().slice(0, 80);
  return partyId || fallback;
}

export function normalizeActorClassification(raw = {}, { legacy = false } = {}) {
  const type = normalizeActorType(raw?.type, 'pc');
  const defaultPartyId = legacy || type === 'pc' ? 'party-default' : null;
  return Object.freeze({
    type,
    partyId: normalizePartyId(raw?.partyId, defaultPartyId),
  });
}

export function actorUsesIndependentInstances(actor) {
  return actor?.type === 'npc' || actor?.type === 'summon';
}
