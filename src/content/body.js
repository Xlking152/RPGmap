import { assertDocumentJson } from '../documents/changes.js';
import { collectContentReferences } from './references.js';
import { inspectImage } from './image.js';

export const TEMPLATE_BODY_TYPE = 'application/vnd.rpgmap.actor-template+json';
export const MAX_BODY_BYTES = 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

export function inspectContent(bytes, type) {
  if (type !== TEMPLATE_BODY_TYPE) return { kind: 'asset', ...inspectImage(bytes, type) };
  if (!bytes.length || bytes.length > MAX_BODY_BYTES) fail('body_size_exceeded');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); assertDocumentJson(value); }
  catch { fail('invalid_content_body'); }
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
