import { assertDocumentJson } from '../documents/changes.js';

const BODY_REFERENCE = /^body:[a-f0-9]{64}$/;
const VISIBILITY_MODES = new Set(['gm', 'public', 'party', 'users']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function text(value, maximum = 160) {
  return String(value ?? '').trim().slice(0, maximum);
}

function identifier(value, label = 'journal_id_required') {
  const result = text(value);
  if (!result || FORBIDDEN_KEYS.has(result)) fail(label);
  return result;
}

function stringIds(value) {
  if (!Array.isArray(value)) return [];
  const values = [];
  const seen = new Set();
  for (const item of value) {
    const id = identifier(item, 'journal_user_id_invalid');
    if (!seen.has(id)) { seen.add(id); values.push(id); }
  }
  return values;
}

export function normalizeJournalEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('journal_invalid');
  assertDocumentJson(raw);
  const id = identifier(raw.id);
  const title = text(raw.title, 240);
  if (!title) fail('journal_title_required');
  const bodyRef = String(raw.bodyRef || '');
  if (!BODY_REFERENCE.test(bodyRef)) fail('journal_body_reference_invalid');
  const visibilitySource = raw.visibility && typeof raw.visibility === 'object' && !Array.isArray(raw.visibility)
    ? raw.visibility : {};
  const mode = VISIBILITY_MODES.has(String(visibilitySource.mode)) ? String(visibilitySource.mode) : 'gm';
  const userIds = stringIds(visibilitySource.userIds);
  const partyId = raw.partyId == null ? null : identifier(raw.partyId, 'journal_party_id_invalid');
  if (mode === 'party' && !partyId) fail('journal_party_required');
  return {
    ...structuredClone(raw),
    id,
    title,
    bodyRef,
    folder: text(raw.folder, 160),
    visibility: { ...structuredClone(visibilitySource), mode, userIds },
    partyId,
    updatedAt: text(raw.updatedAt, 80) || new Date(0).toISOString(),
  };
}

export function normalizeJournalCollection(value) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = normalizeJournalEntry(raw);
    if (seen.has(entry.id)) fail('journal_duplicate_id');
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}

export function journalVisibleToAudience(entry, { role = 'player', userId = '', partyIds = [] } = {}) {
  if (role === 'gm') return true;
  const mode = String(entry?.visibility?.mode || 'gm');
  if (mode === 'public') return true;
  if (mode === 'users') return (entry?.visibility?.userIds || []).map(String).includes(String(userId));
  if (mode === 'party') return Boolean(entry?.partyId && new Set(partyIds.map(String)).has(String(entry.partyId)));
  return false;
}

