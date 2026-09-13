export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8192;

function invalid(code = 'invalid_image') { throw Object.assign(new Error(code), { code }); }

// Inspect bounded container headers only; browser uploads also pass through an
// actual image decoder. Never trust the filename, client MIME, or dimensions.
export function inspectImage(input, declaredType = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) invalid('image_size_exceeded');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const four = offset => offset + 4 <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + 4)) : '';
  let type, width, height;
  if (bytes.length >= 45 && bytes[0] === 137 && four(1) === 'PNG\r'
    && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) {
    type = 'image/png';
    if (view.getUint32(8) !== 13 || four(12) !== 'IHDR') invalid();
    width = view.getUint32(16); height = view.getUint32(20);
    let offset = 8, imageData = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset), kind = four(offset + 4);
      if (size > bytes.length - offset - 12) invalid();
      if (kind === 'IDAT' && size > 0) imageData = true;
      offset += size + 12;
      if (kind === 'IEND') { ended = size === 0 && offset === bytes.length; break; }
    }
    if (!imageData || !ended) invalid();
  } else if (bytes.length >= 26 && bytes[0] === 255 && bytes[1] === 216) {
    type = 'image/jpeg';
    if (bytes.at(-2) !== 255 || bytes.at(-1) !== 217) invalid();
    let offset = 2, scan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218) { scan = true; break; }
      if (marker === 0 || marker === 216 || marker === 217) invalid();
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) invalid();
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) invalid();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (size < 8 || width !== undefined) invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += size;
    }
    if (!scan) invalid();
  } else if (bytes.length >= 30 && four(0) === 'RIFF' && four(8) === 'WEBP') {
    type = 'image/webp';
    if (view.getUint32(4, true) + 8 !== bytes.length) invalid();
    let offset = 12, imageData = false;
    while (offset + 8 <= bytes.length) {
      const kind = four(offset), size = view.getUint32(offset + 4, true), data = offset + 8;
      if (size > bytes.length - data) invalid();
      if (kind === 'VP8X') {
        if (offset !== 12 || size !== 10) invalid();
        width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      } else if (kind === 'VP8 ') {
        if (size < 10 || bytes[data + 3] !== 157 || bytes[data + 4] !== 1 || bytes[data + 5] !== 42) invalid();
        width ??= view.getUint16(data + 6, true) & 16383;
        height ??= view.getUint16(data + 8, true) & 16383;
        imageData = true;
      } else if (kind === 'VP8L') {
        if (size < 5 || bytes[data] !== 47) invalid();
        const bits = view.getUint32(data + 1, true);
        width ??= 1 + (bits & 16383); height ??= 1 + ((bits >>> 14) & 16383);
        imageData = true;
      } else if (kind === 'ANMF') {
        if (size < 24) invalid();
        imageData = true;
      }
      offset = data + size + (size % 2);
    }
    if (!imageData || offset !== bytes.length) invalid();
  } else invalid('image_type_unsupported');
  if (declaredType && declaredType.split(';')[0].trim().toLowerCase() !== type) invalid('image_type_mismatch');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) invalid('image_dimensions_exceeded');
  return { type, width, height, size: bytes.length };
}
