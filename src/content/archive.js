import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { collectContentReferences, contentReference } from './references.js';
import { inspectImage, MAX_IMAGE_BYTES } from './image.js';

export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export async function exportContentArchive(state, content) {
  const files = { 'world.json': strToU8(JSON.stringify(state)) }, records = [];
  for (const reference of collectContentReferences(state).keys()) {
    const { id, kind } = contentReference(reference);
    if (kind !== 'asset') throw new Error('content_type_unsupported');
    const blob = await content.get(reference), bytes = new Uint8Array(await blob.arrayBuffer());
    const metadata = inspectImage(bytes, blob.type);
    files[`content/${id}`] = [bytes, { level: 0 }];
    records.push({ reference, path: `content/${id}`, ...metadata });
  }
  files['manifest.json'] = strToU8(JSON.stringify({ format: 'rpgmap-world', version: 1, world: 'world.json', content: records }));
  const bytes = zipSync(files, { level: 1 });
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('archive_size_exceeded');
  return new Blob([bytes], { type: 'application/zip' });
}

export function readContentArchive(bytes) {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error('archive_size_exceeded');
  let total = 0; const seen = new Set();
  const files = unzipSync(bytes, { filter(entry) {
    if (seen.has(entry.name) || !/^(manifest\.json|world\.json|content\/[a-f0-9]{64})$/.test(entry.name)) throw new Error('invalid_archive_entry');
    seen.add(entry.name); total += entry.originalSize;
    const limit = entry.name === 'world.json' ? 5 * 1024 * 1024 : entry.name === 'manifest.json' ? 1024 * 1024 : MAX_IMAGE_BYTES;
    if (entry.originalSize > limit || total > MAX_ARCHIVE_BYTES || seen.size > 4096) throw new Error('archive_size_exceeded');
    return true;
  } });
  if (!files['manifest.json'] || !files['world.json']) throw new Error('invalid_archive_manifest');
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.format !== 'rpgmap-world' || manifest.version !== 1 || manifest.world !== 'world.json' || !Array.isArray(manifest.content)) throw new Error('invalid_archive_manifest');
  const state = JSON.parse(strFromU8(files['world.json'])), refs = collectContentReferences(state), records = [];
  const references = new Set();
  for (const record of manifest.content) {
    const reference = contentReference(record?.reference);
    if (reference?.kind !== 'asset' || record.path !== `content/${reference.id}` || !files[record.path]
      || references.has(record.reference) || !refs.has(record.reference)) throw new Error('invalid_archive_reference');
    references.add(record.reference);
    const bytes = files[record.path], metadata = inspectImage(bytes, record.type);
    if (metadata.width !== record.width || metadata.height !== record.height || metadata.size !== record.size) throw new Error('invalid_archive_content');
    records.push({ reference: record.reference, blob: new Blob([bytes], { type: metadata.type }) });
  }
  if (refs.size !== references.size || Object.keys(files).length !== records.length + 2) throw new Error('archive_content_missing');
  return { state, records };
}

export async function persistArchiveContent(records, content) {
  for (const record of records) {
    const stored = await content.putImage(record.blob);
    if (stored.reference !== record.reference) throw new Error('archive_content_hash_mismatch');
  }
}
