import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30000);

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.ico', 'image/x-icon'], ['.woff2', 'font/woff2'],
]);

async function ensureRuntimeDirs() {
  await Promise.all([
    mkdir(path.join(DATA_DIR, 'worlds'), { recursive: true }),
    mkdir(path.join(DATA_DIR, 'uploads'), { recursive: true }),
    mkdir(path.join(DATA_DIR, 'backups'), { recursive: true }),
  ]);
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function safePublicPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.resolve(PUBLIC_DIR, relative || 'index.html');
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + path.sep)) return null;
  return candidate;
}

async function serveFile(req, res, filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME.get(ext) || 'application/octet-stream',
    'Content-Length': info.size,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

await ensureRuntimeDirs();
let version = { app: 'RPGmap', packageVersion: 'unknown', serverMode: 'local-static-s0' };
try { version = JSON.parse(await readFile(path.join(ROOT, 'VERSION.json'), 'utf8')); } catch {}

const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) return json(res, 405, { error: 'method_not_allowed' });
    if (req.url === '/api/health') return json(res, 200, { status: 'ok', app: version.app, version: version.packageVersion, mode: version.serverMode });
    if (req.url === '/api/version') return json(res, 200, version);

    const candidate = safePublicPath(req.url || '/');
    if (!candidate) return json(res, 400, { error: 'bad_path' });
    try {
      await serveFile(req, res, candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      await serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
    }
  } catch (error) {
    console.error('[RPGmap] request failed:', error);
    if (!res.headersSent) json(res, 500, { error: 'internal_server_error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('============================================================');
  console.log(` RPGmap Local Server  |  ${version.packageVersion}`);
  console.log('============================================================');
  console.log(` Local   : http://127.0.0.1:${PORT}`);
  for (const url of networkUrls(PORT)) console.log(` Network : ${url}`);
  console.log(` Data    : ${DATA_DIR}`);
  console.log(` Build   : ${version.commit || 'unknown'}`);
  console.log(' Status  : READY');
  console.log('============================================================');
  console.log(' Press Ctrl+C to stop the server.');
  console.log('');
});
