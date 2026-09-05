export const CONTENT_ID = /^[a-f0-9]{64}$/;
const REFERENCE = /^(asset|body):([a-f0-9]{64})$/;

export function contentReference(value) {
  if (typeof value !== 'string') return null;
  const match = REFERENCE.exec(value);
  return match ? { kind: match[1], id: match[2] } : null;
}

export function collectContentReferences(value, { imagesOnly = false } = {}) {
  const references = new Map();
  const visit = (node, path = [], depth = 0) => {
    if (depth > 48) return;
    const reference = contentReference(node);
    if (reference) {
      const field = path.at(-1);
      const imageField = ['img', 'avatarDataUrl'].includes(field) || (field === 'src' && path.at(-2) === 'texture');
      if (!imagesOnly || (reference.kind === 'asset' && imageField)) {
        const paths = references.get(node) || [];
        paths.push(path); references.set(node, paths);
      }
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key], depth + 1);
    }
  };
  visit(value);
  return references;
}

export function readableImageReferences(state) {
  const world = state?.preferences?.worldV2;
  // Do not turn chat text, notes, or unrelated extensible data into read grants.
  return collectContentReferences({ actors: world?.actors || [], tokens: (world?.scenes || []).flatMap(scene => scene.tokens || []) }, { imagesOnly: true });
}

export function contentImageAttributes(value, escape) {
  const reference = contentReference(value);
  return reference?.kind === 'asset' ? `data-content-ref="${value}"` : `src="${escape(value)}"`;
}

export function hasStoredContentReference(storage, reference) {
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith('rpgmap:world:') && !key?.startsWith('rpg-map:')) continue;
    const raw = storage.getItem(key);
    if (!raw) continue;
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('content_backup_unreadable'); }
    if (collectContentReferences(value).has(reference)) return true;
  }
  return false;
}
