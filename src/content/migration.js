import { decodeImageDataUrl } from './data-url.js';
import { inspectImage } from './image.js';

/** Validate the complete input before any host writes durable content or World data. */
export async function prepareInlineImageMigration(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const images = new Map(), paths = [];
  let nodes = 0;
  const visit = (node, path = []) => {
    if (path.length > 48 || ++nodes > 500000) throw Object.assign(new Error('migration_input_limit'), { code: 'migration_input_limit', path });
    if (!node || typeof node !== 'object') return node;
    const next = Array.isArray(node) ? [] : {};
    for (const [key, child] of Object.entries(node)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Object.assign(new Error('migration_unsafe_key'), { code: 'migration_unsafe_key', path: [...path, key] });
      const image = ['img', 'avatarDataUrl'].includes(key) || (key === 'src' && path.at(-1) === 'texture');
      if (image && typeof child === 'string' && child.startsWith('data:')) {
        if (!images.has(child)) images.set(child, { blob: decodeImageDataUrl(child, [...path, key]), targets: [] });
        images.get(child).targets.push({ next, key }); paths.push([...path, key]);
      } else next[key] = visit(child, [...path, key]);
    }
    return next;
  };
  const state = visit(value), records = new Map();
  for (const { blob, targets } of images.values()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))]
      .map(value => value.toString(16).padStart(2, '0')).join('');
    records.set(id, { id, kind: 'asset', ...inspectImage(bytes, blob.type), bytes });
    for (const { next, key } of targets) next[key] = `asset:${id}`;
  }
  return { state, records: [...records.values()], paths, migrated: paths.length > 0 };
}
