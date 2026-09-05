import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, link, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CONTENT_ID, collectContentReferences, readableImageReferences } from '../../src/content/references.js';
import { inspectContent } from '../../src/content/body.js';

const fail = (code, status = 400) => { throw Object.assign(new Error(code), { code, status }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export function createContentStorage({ directory, getState, getProjection, authenticate, serialize, retainedReference = async () => false }) {
  const root = path.resolve(directory);
  const file = id => {
    if (!CONTENT_ID.test(id)) fail('content_not_found', 404);
    return path.join(root, `${id}.content`);
  };
  const authorized = (session, id) => session.role === 'gm'
    || readableImageReferences(getProjection(session)).has(`asset:${id}`);
  const read = async id => {
    try {
      const target = file(id), info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 15 * 1024 * 1024) fail('content_corrupt', 500);
      const record = JSON.parse(await readFile(target, 'utf8'));
      const bytes = Buffer.from(record.data, 'base64');
      if (hash(bytes) !== id || record.id !== id) fail('content_corrupt', 500);
      const metadata = inspectContent(bytes, record.type);
      return { ...metadata, id, bytes };
    } catch (error) {
      if (error.code === 'ENOENT') fail('content_not_found', 404);
      throw error;
    }
  };
  return {
    async handle(req, res, sendJson) {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/api/content')) return false;
      try {
        const session = authenticate(req);
        if (!session) fail('identity_required', 401);
        const match = /^\/api\/content(?:\/([a-f0-9]{64})(\/references)?)?$/.exec(pathname);
        if (!match) fail('content_not_found', 404);
        const [, id, references] = match;
        const isGm = session.role === 'gm';
        if (req.method === 'POST' && !id) {
          if (!isGm) fail('content_gm_only', 403);
          const limit = 10 * 1024 * 1024;
          if (Number(req.headers['content-length']) > limit) fail('image_size_exceeded', 413);
          const chunks = []; let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > limit) fail('image_size_exceeded', 413);
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks), metadata = inspectContent(bytes, req.headers['content-type']);
          const id = hash(bytes), record = { id, ...metadata, data: bytes.toString('base64') };
          await serialize(async () => {
            if (!authenticate(req)) fail('identity_required', 401);
            for (const ref of metadata.dependencies || []) {
              const dependency = await read(ref.slice(6));
              if (dependency.kind !== 'asset') fail('content_type_unsupported');
            }
            await mkdir(root, { recursive: true });
            await syncDirectory(path.dirname(root));
            const temporary = path.join(root, `.${randomUUID()}.tmp`);
            try {
              const handle = await open(temporary, 'wx');
              try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
              // Publish an already-durable immutable file without overwriting a
              // prior record; duplicate uploads share exactly one content ID.
              try { await link(temporary, file(id)); } catch (error) { if (error.code !== 'EEXIST') throw error; await read(id); }
              await syncDirectory(root);
            } finally { await rm(temporary, { force: true }); }
          });
          sendJson(res, 201, { id, reference: `${metadata.kind}:${id}`, ...metadata });
        } else if (req.method === 'GET' && !id) {
          if (!isGm) fail('content_gm_only', 403);
          const entries = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
          const records = [];
          for (const name of entries.sort()) {
            const match = /^([a-f0-9]{64})\.content$/.exec(name);
            if (!match) continue;
            const { bytes, ...metadata } = await read(match[1]);
            records.push({ ...metadata, reference: `${metadata.kind}:${metadata.id}` });
          }
          if (!authenticate(req)) fail('identity_required', 401);
          sendJson(res, 200, { records });
        } else if (id && references && req.method === 'GET') {
          if (!isGm) fail('content_gm_only', 403);
          const record = await read(id);
          const paths = collectContentReferences(getState()?.preferences?.worldV2).get(`${record.kind}:${id}`) || [];
          sendJson(res, 200, { count: paths.length, paths });
        } else if (id && !references && ['GET', 'HEAD'].includes(req.method)) {
          if (!authorized(session, id)) fail('content_not_found', 404);
          const record = await read(id);
          if (record.kind === 'body' && !isGm) fail('content_not_found', 404);
          if (!authenticate(req) || !authorized(session, id)) fail('content_not_found', 404);
          res.writeHead(200, {
            'Content-Type': record.type, 'Content-Length': record.bytes.length,
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin',
          });
          res.end(req.method === 'HEAD' ? undefined : record.bytes);
        } else if (req.method === 'DELETE' && id && !references) {
          if (!isGm) fail('content_gm_only', 403);
          await serialize(async () => {
            if (!authenticate(req)) fail('identity_required', 401);
            const record = await read(id), reference = `${record.kind}:${id}`;
            if (collectContentReferences(getState()).has(reference)) fail('content_in_use', 409);
            if (await retainedReference(reference)) fail('content_in_use', 409);
            if (record.kind === 'asset') {
              for (const name of await readdir(root)) {
                const match = /^([a-f0-9]{64})\.content$/.exec(name);
                if (match && (await read(match[1])).dependencies?.includes(reference)) fail('content_in_use', 409);
              }
            }
            await rm(file(id), { force: true });
          });
          sendJson(res, 200, { removed: true });
        } else fail('method_not_allowed', 405);
      } catch (error) {
        if (!res.headersSent) sendJson(res, error.status || 400, { error: error.code || 'content_storage_failed' });
        else res.end();
      }
      return true;
    },
    async validateReferences(payload, session) {
      const references = collectContentReferences(payload);
      if (!references.size) return;
      const granted = session.role === 'gm' ? null : readableImageReferences(getProjection(session));
      for (const ref of references.keys()) {
        if (session.role !== 'gm' && !granted.has(ref)) fail('content_reference_forbidden', 403);
        const [kind, id] = ref.split(':');
        const record = await read(id);
        if (kind !== record.kind || (kind === 'body' && session.role !== 'gm')) fail('content_type_unsupported');
        for (const dependency of record.dependencies || []) {
          if ((await read(dependency.slice(6))).kind !== 'asset') fail('content_type_unsupported');
        }
      }
    },
  };
}
