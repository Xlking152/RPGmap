import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { prepareMapPackage, MAP_PACKAGE_API_VERSION } from '../map-package/contract.js';

export const MAP_ARCHIVE_FORMAT = 'rpgmap';
export const MAP_ARCHIVE_VERSION = 1;
const LIMITS = Object.freeze({ archive: 256 * 1024 * 1024, file: 64 * 1024 * 1024, total: 512 * 1024 * 1024, files: 4096 });
const utf8 = new TextDecoder('utf-8', { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function fail(message, code = 'map_archive_invalid') {
  const error = new Error(message); error.code = code; throw error;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ value) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
export const mapFileHash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Provenance changes do not replace immutable game content. Artifact SHA covers the full transport. */
export function packageContentFingerprint(manifest, files) {
  const semantic = { ...manifest };
  delete semantic.sourceCommit; delete semantic.generatedAt;
  if (Array.isArray(semantic.files)) semantic.files = [...semantic.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  const payloads = [...files].filter(([name]) => name !== 'manifest.json').map(([name, bytes]) => [name, mapFileHash(bytes)])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return mapFileHash(Buffer.from(JSON.stringify({ manifest: canonical(semantic), payloads })));
}

/** Canonical archive paths must also be safe when unpacked on Windows. */
export function validateMapArchivePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== value.normalize('NFC')
    || /[\\\x00-\x1f\x7f:%?#]/.test(value) || value.startsWith('/') || value.endsWith('/')) fail(`Invalid package path: ${value}`, 'map_archive_path_invalid');
  const segments = value.split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(`Unsafe package path: ${value}`, 'map_archive_path_invalid');
  return value;
}
function identifier(value, name) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)
    || /[.]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) fail(`Invalid package ${name}`, 'map_archive_identity_invalid');
  return value;
}
function decode(bytes, label) {
  try { return utf8.decode(bytes); } catch { fail(`${label} is not valid UTF-8`); }
}
function json(bytes, label) {
  try { return JSON.parse(decode(bytes, label)); } catch (error) { fail(`${label}: ${error.message}`); }
}
function graph(value, label = 'map.json', depth = 0) {
  if (depth > 40) fail(`${label} exceeds maximum nesting`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail(`${label} must contain JSON data only`);
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(`${label} contains a reserved property`);
    graph(child, `${label}.${key}`, depth + 1);
  }
}
function assetPath(value, files, label) {
  const path = validateMapArchivePath(value);
  if (!path.startsWith('assets/') || !files.has(path)) fail(`Missing package resource ${value} (${label})`, 'map_archive_resource_missing');
  return path;
}
function decodeEntities(value) {
  return value.replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (_, hex, decimal) => {
    const number = parseInt(hex || decimal, hex ? 16 : 10);
    if (!Number.isFinite(number) || number > 0x10ffff) fail('Invalid XML character reference');
    return String.fromCodePoint(number);
  }).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// A small static SVG profile deliberately supports only canonical namespace
// spellings. XML aliases would otherwise change the meaning of attributes that
// our resource scanner and browser renderer see under different names.
function validateSvgNamespaces(svg, label) {
  const namespaces = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    'xmlns:xml': 'http://www.w3.org/XML/1998/namespace' };
  const prefixedAttributes = new Set(['xlink:href', 'xml:space', 'xml:lang', 'xml:id']);
  for (const tag of svg.matchAll(/<\s*\/?\s*([a-zA-Z][\w:.-]*)\b[^>]*>/g)) {
    if (tag[1].includes(':')) fail(`${label} contains an unsupported element namespace`, 'map_archive_svg_unsafe');
    const attributes = new Set();
    for (const attribute of tag[0].matchAll(/\s([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      const name = attribute[1], canonical = name.toLowerCase();
      if (attributes.has(canonical)) fail(`${label} contains duplicate XML attributes`, 'map_archive_svg_unsafe');
      attributes.add(canonical);
      if (canonical === 'xmlns' || canonical.startsWith('xmlns:')) {
        if (!Object.hasOwn(namespaces, name) || decodeEntities(attribute[3]) !== namespaces[name]) {
          fail(`${label} contains an unsupported namespace declaration`, 'map_archive_svg_unsafe');
        }
      } else if (name.includes(':') && !prefixedAttributes.has(name)) {
        fail(`${label} contains an unsupported attribute namespace`, 'map_archive_svg_unsafe');
      }
    }
  }
}

/** SVG is deliberately static: no animation, HTML, external fetches or handlers. */
export function validateStaticMapSvg(svg, files = new Map(), label = 'map.svg') {
  if (typeof svg !== 'string' || !/^\s*<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) fail(`${label} must be an SVG document`);
  validateSvgNamespaces(svg, label);
  if (/<!DOCTYPE|<!ENTITY|<\?|<\s*(?:[\w-]+:)?(?:script|foreignObject|iframe|object|embed|audio|video|animate\w*|set|discard)\b/i.test(svg)
    || /\s(?:[\w-]+:)?on[a-z]+\s*=/i.test(svg) || /xml:base\s*=/i.test(svg)) fail(`${label} contains executable or unsupported SVG`, 'map_archive_svg_unsafe');
  const decoded = decodeEntities(svg);
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:[\w-]+:)?(?:script|foreignObject)\b/i.test(decoded)
    || /(?:javascript|vbscript|data|file|https?):\s*/i.test(decoded.replace(/xmlns(?:[:\w-]*)\s*=\s*(["']).*?\1/g, ''))
    || /@import|expression\s*\(/i.test(decoded)) fail(`${label} contains external or executable content`, 'map_archive_svg_unsafe');
  // CSS escapes can conceal URLs and property names. Map CSS needs no escapes.
  for (const style of decoded.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>|\sstyle\s*=\s*(["'])([\s\S]*?)\2/gi)) {
    if (/\\|@|expression\s*\(/i.test(style[1] || style[3] || '')) fail(`${label} contains unsupported CSS`, 'map_archive_svg_unsafe');
  }
  for (const match of decoded.matchAll(/\s(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!match[2].startsWith('#')) assetPath(match[2], files, label);
  }
  for (const match of decoded.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    const value = match[2].trim();
    if (!value.startsWith('#')) assetPath(value, files, label);
  }
  // Unquoted attributes are invalid XML and bypass normal resource scanning.
  for (const tag of svg.matchAll(/<[a-zA-Z][^>]*>/g)) {
    if (/\\/.test(decodeEntities(tag[0]))) fail(`${label} contains unsupported attribute escapes`, 'map_archive_svg_unsafe');
    const rest = tag[0].replace(/\s[\w:.-]+\s*=\s*(["'])[\s\S]*?\1/g, '');
    if (/=/.test(rest)) fail(`${label} contains malformed XML attributes`);
  }
  return svg;
}

function validatePolygon(points, label) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 2048) fail(`${label} requires 3-2048 points`, 'map_archive_geometry_invalid');
  if (points.every(point => Array.isArray(point) && point.length === 2 && point.every(v => typeof v === 'number' && Number.isFinite(v)))
    && points.length > 3 && points[0].every((value, index) => value === points.at(-1)[index])) points = points.slice(0, -1);
  let area = 0;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const onSegment = (a, b, p) => Math.abs(cross(a, b, p)) < 1e-9 && p[0] >= Math.min(a[0], b[0]) - 1e-9
    && p[0] <= Math.max(a[0], b[0]) + 1e-9 && p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
  const intersects = (a, b, c, d) => (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
  if (!points.every(point => Array.isArray(point) && point.length === 2 && point.every(v => typeof v === 'number' && Number.isFinite(v)))) {
    fail(`${label} contains invalid coordinates`, 'map_archive_geometry_invalid');
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (a[0] === b[0] && a[1] === b[1]) fail(`${label} has a duplicate edge point`, 'map_archive_geometry_invalid');
    area += a[0] * b[1] - b[0] * a[1];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) fail(`${label} is self-intersecting`, 'map_archive_geometry_invalid');
    }
  }
  if (Math.abs(area) < 1e-9) fail(`${label} has zero area`, 'map_archive_geometry_invalid');
}
function visitAssets(value, files, label = 'artAssets') {
  if (typeof value === 'string') { assetPath(value, files, label); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' || typeof child === 'object') visitAssets(child, files, `${label}.${key}`);
  }
}
function validateData(data, svg, files, manifest) {
  graph(data);
  if (data.id !== manifest.id || data.version !== manifest.version) fail('Map identity differs from manifest', 'map_archive_identity_mismatch');
  for (const key of ['svg', 'createSvg', 'tokens', 'actors', 'sceneEvents', 'featureStates', 'world', 'characters', 'markers', 'attackAreas', 'fog']) {
    if (Object.hasOwn(data, key)) fail(`map.json cannot contain ${key}`);
  }
  const normalized = prepareMapPackage({ ...data, svg }, { source: 'map-archive' });
  const ids = new Set(normalized.features.map(feature => feature.id));
  if (normalized.features.length > 20000) fail('Map exceeds 20000 features');
  for (const feature of normalized.features) {
    if (feature.geometry?.type !== 'polygon') fail(`Feature ${feature.id} requires polygon geometry`, 'map_archive_geometry_invalid');
    validatePolygon(feature.geometry.points, `Feature ${feature.id}`);
    for (const polygon of [feature.capabilities.navigation?.blockingPolygon, feature.capabilities.navigation?.passagePolygon, feature.capabilities.vision?.polygon]) {
      if (polygon) validatePolygon(polygon, `Feature ${feature.id} physical geometry`);
    }
    const host = feature.interaction?.hostFeatureId ?? feature.hostFeatureId;
    if (host && (!ids.has(host) || host === feature.id)) fail(`Feature ${feature.id} has an invalid host`, 'map_archive_reference_invalid');
    if (feature.ruinStyle && data.artAssets?.ruins && !data.artAssets.ruins[feature.ruinStyle] && !data.artAssets.ruins.default) fail(`Feature ${feature.id} has missing ruin style ${feature.ruinStyle}`, 'map_archive_resource_missing');
  }
  for (const body of data.liquidBodies || []) validatePolygon(body.polygon, `Liquid ${body.id}`);
  for (const buffer of data.roadBuffers || []) validatePolygon(buffer.geometry?.points, `Road buffer ${buffer.id}`);
  for (const gateway of data.navigation?.gateways || []) {
    if (!ids.has(gateway.featureId)) fail(`Gateway references unknown Feature ${gateway.featureId}`, 'map_archive_reference_invalid');
    validatePolygon(gateway.polygon, `Gateway ${gateway.featureId}`);
  }
  for (const match of svg.matchAll(/\sdata-(?:feature-id|label-for)\s*=\s*(["'])(.*?)\1/g)) {
    if (!ids.has(decodeEntities(match[2]))) fail(`SVG references unknown Feature ${match[2]}`, 'map_archive_reference_invalid');
  }
  visitAssets(data.artAssets, files);
  return data;
}

function allowedFile(path) {
  if (['manifest.json', 'map.json', 'map.svg', 'README.md', 'preview.webp'].includes(path)) return;
  if (!path.startsWith('assets/') || !/\.(png|webp|jpe?g|gif|svg)$/i.test(path)) fail(`Unsupported map package file: ${path}`, 'map_archive_file_unsupported');
}

/** ZIP Store/Deflate reader. Central and local records are cross-checked before unpacking. */
export function readMapArchiveFiles(input, { validateFile = allowedFile } = {}) {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > LIMITS.archive) fail('Invalid archive size');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('ZIP end record is missing');
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
    || !count || count > LIMITS.files || centralStart + centralSize !== end) fail('Unsupported ZIP layout');
  const files = new Map(), names = new Set(), ranges = [];
  let cursor = centralStart, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('Invalid ZIP central record');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), attributes = bytes.readUInt32LE(cursor + 38);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || bytes.readUInt16LE(cursor + 34) || (flags & ~0x0808) || ![0, 8].includes(method)
      || size > LIMITS.file || (total += size) > LIMITS.total || ((attributes >>> 16) & 0xf000) === 0xa000) fail('Unsupported ZIP entry');
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    const name = validateMapArchivePath(decode(nameBytes, 'ZIP filename'));
    const canonical = name.toLowerCase();
    if (names.has(canonical)) fail(`Duplicate ZIP path ${name}`, 'map_archive_duplicate_path');
    names.add(canonical); validateFile(name);
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x04034b50
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail('ZIP local record differs from central record');
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameSize + localExtraSize;
    if (dataStart + compressed > centralStart || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) fail('ZIP local filename or bounds mismatch');
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) fail('ZIP local size or CRC mismatch');
    let rangeEnd = dataStart + compressed;
    if (flags & 8) {
      const descriptor = bytes.readUInt32LE(rangeEnd) === 0x08074b50 ? rangeEnd + 4 : rangeEnd;
      if (descriptor + 12 > centralStart || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== size) fail('ZIP data descriptor mismatch');
      rangeEnd = descriptor + 12;
    }
    ranges.push([local, rangeEnd]);
    let payload;
    try { payload = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataStart + compressed)) : inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), { maxOutputLength: Math.max(1, size) }); }
    catch { fail(`ZIP decompression failed for ${name}`); }
    if (payload.length !== size || crc32(payload) !== crc) fail(`ZIP integrity failed for ${name}`, 'map_archive_corrupt');
    files.set(name, payload); cursor = next;
  }
  if (cursor !== end) fail('ZIP central size mismatch');
  ranges.sort((a, b) => a[0] - b[0]);
  let position = 0;
  for (const [start, stop] of ranges) { if (start !== position) fail('ZIP contains gaps or overlapping entries'); position = stop; }
  if (position !== centralStart) fail('ZIP payload layout mismatch');
  return files;
}

export function inspectMapArchive(input) {
  const files = readMapArchiveFiles(input);
  for (const name of ['manifest.json', 'map.json', 'map.svg']) if (!files.has(name)) fail(`Missing ${name}`, 'map_archive_resource_missing');
  const manifest = json(files.get('manifest.json'), 'manifest.json'); graph(manifest, 'manifest.json');
  if (manifest.format !== MAP_ARCHIVE_FORMAT || manifest.formatVersion !== MAP_ARCHIVE_VERSION
    || manifest.mapPackageApiVersion !== MAP_PACKAGE_API_VERSION) fail('Incompatible map package format', 'map_archive_incompatible');
  identifier(manifest.id, 'id'); identifier(manifest.version, 'version');
  if (!Array.isArray(manifest.files) || manifest.files.length !== files.size - 1) fail('Manifest file inventory mismatch');
  const declared = new Set();
  for (const record of manifest.files) {
    const name = validateMapArchivePath(record?.path);
    const bytes = files.get(name);
    if (name === 'manifest.json' || declared.has(name) || !bytes || record.size !== bytes.length || record.sha256 !== mapFileHash(bytes)) fail(`Manifest integrity mismatch for ${name}`, 'map_archive_corrupt');
    declared.add(name);
  }
  for (const [name, bytes] of files) if (/\.svg$/i.test(name)) validateStaticMapSvg(decode(bytes, name), files, name);
  const svg = decode(files.get('map.svg'), 'map.svg');
  const data = validateData(json(files.get('map.json'), 'map.json'), svg, files, manifest);
  const fingerprint = packageContentFingerprint(manifest, files);
  return { manifest, data, svg, files, fingerprint };
}

/** Deterministic ZIP writer used by map authors and the official export command. */
export function writeMapArchiveFiles(entries, { compress = true } = {}) {
  const files = entries instanceof Map ? entries : new Map(Object.entries(entries));
  const localRecords = [], centralRecords = [];
  let offset = 0;
  for (const [rawPath, rawBytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const name = Buffer.from(validateMapArchivePath(rawPath)), bytes = Buffer.from(rawBytes), packed = compress ? deflateRawSync(bytes, { level: 9 }) : bytes;
    const method = compress && packed.length < bytes.length ? 8 : 0, payload = method === 8 ? packed : bytes;
    const crc = crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x0021, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x0021, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    localRecords.push(local, name, payload); centralRecords.push(central, name); offset += local.length + name.length + payload.length;
  }
  const central = Buffer.concat(centralRecords), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, central, end]);
}

export function buildMapArchive({ data, svg, assets = new Map(), metadata = {} }) {
  const { createSvg: _createSvg, svg: _svg, manifest: _manifest, fingerprint: _fingerprint, source: _source, ...sourceData } = data;
  const jsonData = JSON.parse(JSON.stringify(sourceData));
  const files = new Map(assets instanceof Map ? assets : Object.entries(assets));
  for (const [path, bytes] of files) { validateMapArchivePath(path); allowedFile(path); files.set(path, Buffer.from(bytes)); }
  if (files.has('manifest.json') || files.has('map.json') || files.has('map.svg')) fail('Assets cannot replace required package files');
  files.set('map.json', Buffer.from(JSON.stringify(jsonData)));
  files.set('map.svg', Buffer.from(svg ?? data.svg ?? data.createSvg?.() ?? ''));
  const manifest = { ...metadata, format: MAP_ARCHIVE_FORMAT, formatVersion: MAP_ARCHIVE_VERSION,
    mapPackageApiVersion: MAP_PACKAGE_API_VERSION, id: jsonData.id, version: jsonData.version,
    title: jsonData.title || jsonData.name || jsonData.id,
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: mapFileHash(bytes) })).sort((a, b) => a.path.localeCompare(b.path)) };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const archive = writeMapArchiveFiles(files);
  inspectMapArchive(archive);
  return archive;
}

export function mapArchiveAssetUrl(reference, path, assetBase = '/api/packages/maps') {
  const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${assetBase}/${encode(reference.id)}/${encode(reference.version)}/files/${path.split('/').map(encode).join('/')}`;
}

export function rewriteMapArchiveResources({ data, svg, files }, reference, assetBase = '/api/packages/maps') {
  const url = path => mapArchiveAssetUrl(reference, path, assetBase);
  const rewrite = value => {
    if (typeof value === 'string' && files.has(value) && value.startsWith('assets/')) return url(value);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]));
    return value;
  };
  const rewrittenSvg = svg.replace(/(\s(?:xlink:)?href\s*=\s*)(["'])(.*?)\2/gi, (full, prefix, quote, raw) => {
    const value = decodeEntities(raw); return files.has(value) ? `${prefix}${quote}${url(value)}${quote}` : full;
  }).replace(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi, (full, _quote, raw) => files.has(raw.trim()) ? `url(${url(raw.trim())})` : full);
  return { ...rewrite(data), svg: rewrittenSvg, createSvg: () => rewrittenSvg };
}
