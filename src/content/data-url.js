import { inspectImage, MAX_IMAGE_BYTES } from './image.js';

export function decodeImageDataUrl(value, path = []) {
  try {
    if (typeof value !== 'string' || value.length > MAX_IMAGE_BYTES * 1.4) throw new Error();
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
    if (!match || match[2].length % 4) throw new Error();
    const decoded = atob(match[2]);
    const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
    inspectImage(bytes, match[1]);
    return new Blob([bytes], { type: match[1] });
  } catch {
    throw Object.assign(new Error(`Invalid image at ${JSON.stringify(path)}`), { code: 'invalid_image_data_url', path });
  }
}

export async function persistInlineImages(value, content, path = []) {
  if (!value || typeof value !== 'object') return value;
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const image = ['img', 'avatarDataUrl'].includes(key) || (key === 'src' && path.at(-1) === 'texture');
    result[key] = image && typeof child === 'string' && child.startsWith('data:')
      ? (await content.putImage(decodeImageDataUrl(child, [...path, key]))).reference
      : await persistInlineImages(child, content, [...path, key]);
  }
  return result;
}
