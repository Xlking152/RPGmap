import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { collectContentReferences } from '../../src/content/references.js';

export async function hasRetainedContentReference(storage, reference) {
  const contains = text => {
    if (!text.trim()) return false;
    try { return collectContentReferences(JSON.parse(text)).has(reference); }
    catch { throw Object.assign(new Error('content_backup_unreadable'), { code: 'content_backup_unreadable', status: 409 }); }
  };
  const files = [storage.worldFile];
  const backups = await readdir(storage.backupsDir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  for (const item of backups) if (item.isFile() && item.name.startsWith('world.') && item.name.endsWith('.json')) files.push(path.join(storage.backupsDir, item.name));
  for (const file of files) {
    let raw;
    try { raw = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (contains(raw)) return true;
  }
  const stream = createReadStream(storage.operationsFile, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (contains(line)) return true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { lines.close(); stream.destroy(); }
  return false;
}
