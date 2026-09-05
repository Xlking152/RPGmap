import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { collectContentReferences, contentReference } from './references.js';
import { MAX_IMAGE_BYTES } from './image.js';
import { inspectContent, templateBodyBlob, MAX_BODY_BYTES } from './body.js';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

async function exportArchive(state, content, format, root) {
  const files = { [root]: strToU8(JSON.stringify(state)) }, records = [];
  const references = new Set(collectContentReferences(state).keys());
  for (const reference of references) {
    const { id, kind } = contentReference(reference);
    const blob = await content.get(reference), bytes = new Uint8Array(await blob.arrayBuffer());
    const metadata = inspectContent(bytes, blob.type);
    if (metadata.kind !== kind) throw new Error('content_type_unsupported');
    for (const dependency of metadata.dependencies || []) references.add(dependency);
    files[`content/${id}`] = [bytes, { level: 0 }];
    records.push({ reference, path: `content/${id}`, ...metadata });
  }
  files['manifest.json'] = strToU8(JSON.stringify({ format, version: 1, [root === 'world.json' ? 'world' : 'template']: root, content: records }));
  const bytes = zipSync(files, { level: 1 });
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('archive_size_exceeded');
  return new Blob([bytes], { type: 'application/zip' });
}

function readArchive(bytes, format, root) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('archive_size_exceeded');
  let total = 0; const seen = new Set();
  const files = unzipSync(bytes, { filter(entry) {
    if (seen.has(entry.name) || (entry.name !== root && entry.name !== 'manifest.json' && !/^content\/[a-f0-9]{64}$/.test(entry.name))) throw new Error('invalid_archive_entry');
    seen.add(entry.name); total += entry.originalSize;
    const limit = entry.name === root ? (root === 'world.json' ? 5 * 1024 * 1024 : MAX_BODY_BYTES) : entry.name === 'manifest.json' ? 1024 * 1024 : MAX_IMAGE_BYTES;
    if (entry.originalSize > limit || total > MAX_ARCHIVE_BYTES || seen.size > 4096) throw new Error('archive_size_exceeded');
    return true;
  } });
  if (!files['manifest.json'] || !files[root]) throw new Error('invalid_archive_manifest');
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.format !== format || manifest.version !== 1 || manifest[root === 'world.json' ? 'world' : 'template'] !== root || !Array.isArray(manifest.content)) throw new Error('invalid_archive_manifest');
  const state = JSON.parse(strFromU8(files[root])), refs = collectContentReferences(state), records = [];
  const references = new Set();
  for (const record of manifest.content) {
    const reference = contentReference(record?.reference);
    if (!reference || record.path !== `content/${reference.id}` || !files[record.path]
      || references.has(record.reference)) throw new Error('invalid_archive_reference');
    references.add(record.reference);
    const bytes = files[record.path], metadata = inspectContent(bytes, record.type);
    if (metadata.kind !== reference.kind || metadata.width !== record.width || metadata.height !== record.height || metadata.size !== record.size) throw new Error('invalid_archive_content');
    if (metadata.kind === 'body' && refs.has(record.reference)) for (const dependency of metadata.dependencies) refs.set(dependency, []);
    records.push({ reference: record.reference, blob: new Blob([bytes], { type: metadata.type }) });
  }
  if (refs.size !== references.size || [...refs.keys()].some(ref => !references.has(ref))
    || Object.keys(files).length !== records.length + 2) throw new Error('archive_content_missing');
  return { state, records };
}

export async function persistArchiveContent(records, content) {
  await verifyArchiveHashes(records);
  for (const record of records.toSorted((a, b) => Number(a.reference.startsWith('body:')) - Number(b.reference.startsWith('body:')))) {
    const stored = record.reference.startsWith('body:') ? await content.putBody(record.blob) : await content.putImage(record.blob);
    if (stored.reference !== record.reference) throw new Error('archive_content_hash_mismatch');
  }
}

export async function verifyArchiveHashes(records) {
  for (const record of records) {
    const bytes = await record.blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (contentReference(record.reference)?.id !== hash) throw new Error('archive_content_hash_mismatch');
  }
}

export const exportContentArchive = (state, content) => exportArchive(state, content, 'rpgmap-world', 'world.json');
export const readContentArchive = bytes => readArchive(bytes, 'rpgmap-world', 'world.json');

export async function exportTemplateArchive(bundle, content) {
  templateBodyBlob(bundle);
  return exportArchive(bundle, content, 'rpgmap-actor-template', 'template.json');
}

export async function readTemplateArchive(bytes) {
  const { state: bundle, records } = readArchive(bytes, 'rpgmap-actor-template', 'template.json');
  templateBodyBlob(bundle);
  await verifyArchiveHashes(records);
  return { bundle, records };
}
