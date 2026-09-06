const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

function join(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function writeStoredZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, source] of Object.entries(files || {})) {
    const nameBytes = encoder.encode(name);
    const bytes = source instanceof Uint8Array ? source : source?.[0];
    if (!(bytes instanceof Uint8Array) || !nameBytes.length || nameBytes.length > 0xffff) throw new Error('invalid_archive_entry');
    const crc = crc32(bytes);
    const localHeader = header(30);
    localHeader.view.setUint32(0, 0x04034b50, true);
    localHeader.view.setUint16(4, 20, true);
    localHeader.view.setUint16(6, 0x0800, true);
    localHeader.view.setUint16(10, 0, true);
    localHeader.view.setUint16(12, 0x21, true);
    localHeader.view.setUint32(14, crc, true);
    localHeader.view.setUint32(18, bytes.length, true);
    localHeader.view.setUint32(22, bytes.length, true);
    localHeader.view.setUint16(26, nameBytes.length, true);
    local.push(localHeader.bytes, nameBytes, bytes);

    const centralHeader = header(46);
    centralHeader.view.setUint32(0, 0x02014b50, true);
    centralHeader.view.setUint16(4, 20, true);
    centralHeader.view.setUint16(6, 20, true);
    centralHeader.view.setUint16(8, 0x0800, true);
    centralHeader.view.setUint16(12, 0, true);
    centralHeader.view.setUint16(14, 0x21, true);
    centralHeader.view.setUint32(16, crc, true);
    centralHeader.view.setUint32(20, bytes.length, true);
    centralHeader.view.setUint32(24, bytes.length, true);
    centralHeader.view.setUint16(28, nameBytes.length, true);
    centralHeader.view.setUint32(42, offset, true);
    central.push(centralHeader.bytes, nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }
  const centralBytes = join(central);
  const count = central.length / 2;
  if (count > 0xffff || offset > 0xffffffff || centralBytes.length > 0xffffffff) throw new Error('archive_size_exceeded');
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, count, true);
  end.view.setUint16(10, count, true);
  end.view.setUint32(12, centralBytes.length, true);
  end.view.setUint32(16, offset, true);
  return join([...local, centralBytes, end.bytes]);
}

export function readStoredZip(bytes, accept = () => {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) throw new Error('invalid_archive_entry');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22, limit = Math.max(0, bytes.length - 65557); offset >= limit; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
    || view.getUint16(end + 8, true) !== view.getUint16(end + 10, true)
    || end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw new Error('invalid_archive_entry');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true), centralOffset = view.getUint32(end + 16, true);
  if (centralOffset + centralSize !== end) throw new Error('invalid_archive_entry');
  const files = {};
  let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('invalid_archive_entry');
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true), compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true), nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || method !== 0 || compressedSize !== size || flags & 0x0009) throw new Error('invalid_archive_entry');
    let name;
    try { name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw new Error('invalid_archive_entry'); }
    if (!name || Object.hasOwn(files, name) || localOffset + 30 > centralOffset
      || view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('invalid_archive_entry');
    const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
    if (view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== method
      || view.getUint32(localOffset + 14, true) !== crc || view.getUint32(localOffset + 18, true) !== compressedSize
      || view.getUint32(localOffset + 22, true) !== size || localNameLength !== nameLength) throw new Error('invalid_archive_entry');
    for (let nameIndex = 0; nameIndex < nameLength; nameIndex++) {
      if (bytes[localOffset + 30 + nameIndex] !== bytes[cursor + 46 + nameIndex]) throw new Error('invalid_archive_entry');
    }
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + size > centralOffset) throw new Error('invalid_archive_entry');
    const value = bytes.slice(dataOffset, dataOffset + size);
    if (crc32(value) !== crc) throw new Error('invalid_archive_entry');
    accept({ name, originalSize: size });
    files[name] = value;
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('invalid_archive_entry');
  return files;
}
