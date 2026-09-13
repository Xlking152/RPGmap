import { assertDocumentJson } from '../documents/changes.js';
import { collectContentReferences } from './references.js';
import { inspectImage } from './image.js';

export const TEMPLATE_BODY_TYPE = 'application/vnd.rpgmap.actor-template+json';
export const JOURNAL_BODY_TYPE = 'application/vnd.rpgmap.journal+json';
export const MAX_BODY_BYTES = 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function parseBody(bytes) {
  if (!bytes.length || bytes.length > MAX_BODY_BYTES) fail('body_size_exceeded');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); assertDocumentJson(value); }
  catch { fail('invalid_content_body'); }
  return value;
}

function inspectJournalBody(bytes) {
  const value = parseBody(bytes);
  if (value?.schemaVersion !== 1 || value.kind !== 'journal-page' || typeof value.markdown !== 'string'
    || value.markdown.length > 256 * 1024 || !Array.isArray(value.images) || value.images.length > 64
    || value.images.some(reference => !/^asset:[a-f0-9]{64}$/.test(String(reference)))) fail('invalid_journal_body');
  if (/<\/?[A-Za-z][^>]*>/.test(value.markdown)) fail('journal_raw_html_forbidden');
  if (/!\[[^\]]*\]\([^)]+\)/.test(value.markdown) || /(?:javascript|data|file):/i.test(value.markdown)) {
    fail('journal_embed_forbidden');
  }
  return { kind: 'body', type: JOURNAL_BODY_TYPE, size: bytes.length, dependencies: [...new Set(value.images)] };
}

export function inspectContent(bytes, type) {
  if (type === JOURNAL_BODY_TYPE) return inspectJournalBody(bytes);
  if (type !== TEMPLATE_BODY_TYPE) return { kind: 'asset', ...inspectImage(bytes, type) };
  const value = parseBody(bytes);
  if (value?.schemaVersion !== 1 || value.kind !== 'actor-template' || typeof value.actor?.id !== 'string' || !value.actor.id
    || !value.actor.system || typeof value.actor.system !== 'object' || Array.isArray(value.actor.system)
    || typeof value.ruleset?.id !== 'string' || !value.ruleset.id || typeof value.ruleset?.version !== 'string' || !value.ruleset.version
    || !Array.isArray(value.statusDefinitions) || value.statusDefinitions.some(definition => !definition || typeof definition.id !== 'string')) {
    fail('invalid_template_body');
  }
  const dependencies = [...collectContentReferences(value).keys()];
  if (dependencies.some(ref => !ref.startsWith('asset:'))) fail('nested_body_forbidden');
  const checkImages = (node, parent = '') => {
    for (const [key, child] of Object.entries(node)) {
      if ((['img', 'avatarDataUrl'].includes(key) || (parent === 'texture' && key === 'src'))
        && typeof child === 'string' && child.startsWith('data:')) fail('template_inline_image_forbidden');
      if (child && typeof child === 'object') checkImages(child, key);
    }
  };
  checkImages(value);
  return { kind: 'body', type, size: bytes.length, dependencies };
}

export function templateBodyBlob(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  inspectContent(bytes, TEMPLATE_BODY_TYPE);
  return new Blob([bytes], { type: TEMPLATE_BODY_TYPE });
}

export function journalBodyBlob({ markdown = '', images = [] } = {}) {
  const value = { schemaVersion: 1, kind: 'journal-page', markdown: String(markdown), images: [...new Set(images.map(String))] };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  inspectContent(bytes, JOURNAL_BODY_TYPE);
  return new Blob([bytes], { type: JOURNAL_BODY_TYPE });
}
