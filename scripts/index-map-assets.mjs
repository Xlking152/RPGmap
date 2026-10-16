import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function dimensions(bytes, extension) {
  if (extension === '.png') return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (extension === '.svg') {
    const source = bytes.toString('utf8'), viewBox = /viewBox=["']([^"']+)["']/.exec(source)?.[1].trim().split(/\s+/).map(Number);
    const width = Number(/\bwidth=["']([\d.]+)/.exec(source)?.[1]) || viewBox?.[2];
    const height = Number(/\bheight=["']([\d.]+)/.exec(source)?.[1]) || viewBox?.[3];
    return { width, height };
  }
  if (extension === '.webp') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), payload = offset + 8;
      if (kind === 'VP8X') return { width: 1 + bytes.readUIntLE(payload + 4, 3), height: 1 + bytes.readUIntLE(payload + 7, 3) };
      if (kind === 'VP8 ') return { width: bytes.readUInt16LE(payload + 6) & 0x3fff, height: bytes.readUInt16LE(payload + 8) & 0x3fff };
      if (kind === 'VP8L') { const bits = bytes.readUInt32LE(payload + 1); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }; }
      offset = payload + size + (size % 2);
    }
  }
  throw new Error(`不能读取素材尺寸：${extension}`);
}
const sharedIds = {
  '房屋/rubble-atlas.webp': 'ruins-house-atlas',
  '城墙/wall-rubble.svg': 'ruins-wall', '城墙/wall-rubble-severe.svg': 'ruins-wall-severe',
  '植被/vegetation-rubble.svg': 'ruins-vegetation', '植被/vegetation-rubble-severe.svg': 'ruins-vegetation-severe',
  '地表/ground-rubble.svg': 'ruins-ground', '地表/ground-rubble-severe.svg': 'ruins-ground-severe',
};
const resources = [];
async function visit(directory, scope, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('素材索引不跟随链接');
    if (entry.isDirectory()) { await visit(absolute, scope, relative); continue; }
    const extension = path.extname(entry.name).toLowerCase();
    if (!['.webp', '.svg', '.png'].includes(extension)) continue;
    const bytes = await readFile(absolute), size = dimensions(bytes, extension);
    if (!size.width || !size.height) throw new Error(`素材尺寸无效：${relative}`);
    const id = scope === 'shared' ? sharedIds[relative] || `shared-${hash(Buffer.from(relative)).slice(0, 16)}` : `lanzhou-${path.basename(relative, extension)}`;
    const rubble = /rubble/.test(relative), category = /wall-rubble/.test(relative) ? 'wall' : /vegetation/.test(relative) ? 'vegetation' : /ground|terrain/.test(relative) ? 'terrain' : /river/.test(relative) ? 'water' : 'building';
    resources.push({ id, file: path.relative(root, absolute).split(path.sep).join('/'), ...size,
      bytes: bytes.length, sha256: hash(bytes), purpose: rubble ? '废墟贴图' : /river/.test(relative) ? '河流或桥梁画面' : /terrain/.test(relative) ? '地面画面' : '建筑或地物画面',
      source: '项目内既有素材；原始外部来源未登记',
      ruinBinding: rubble ? { category, severity: /severe/.test(relative) ? 'severe' : 'normal',
        ...(category === 'building' ? { style: 'tile-timber-earth-rubble', columns: 3, rows: 2 } : {}) }
        : category === 'building' ? { resourceId: 'lanzhou-rubble-atlas', style: 'tile-timber-earth-rubble' } : null });
  }
}
await visit(path.join(root, '素材库', '废墟'), 'shared');
await visit(path.join(root, 'maps', 'lanzhou', 'assets'), 'lanzhou');
resources.sort((a, b) => a.id.localeCompare(b.id));
if (new Set(resources.map(item => item.id)).size !== resources.length) throw new Error('重复素材 ID');
await writeFile(path.join(root, '素材库', '资源索引.json'), `${JSON.stringify({ formatVersion: 1, resources }, null, 2)}\n`);
console.log(`Indexed ${resources.length} assets`);
