function decodeXml(value = '') {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attrs(text = '') {
  const result = {};
  for (const match of text.matchAll(/([\w:.-]+)="([^"]*)"/g)) result[match[1]] = decodeXml(match[2]);
  return result;
}

function allText(xml = '') {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
}

export function parseSharedStrings(xml = '') {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => allText(match[1]));
}

export function parseWorksheetCells(xml = '', sharedStrings = []) {
  const cells = new Map();
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const a = attrs(match[1]);
    if (!a.r || match[2] === undefined) continue;
    const body = match[2];
    let value = null;
    if (a.t === 'inlineStr') value = allText(body);
    else {
      const valueMatch = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
      if (!valueMatch) continue;
      const raw = decodeXml(valueMatch[1]);
      if (a.t === 's') value = sharedStrings[Number(raw)] ?? '';
      else if (a.t === 'str') value = raw;
      else if (a.t === 'b') value = raw === '1';
      else if (a.t === 'e') value = null;
      else {
        const number = Number(raw);
        value = raw !== '' && Number.isFinite(number) ? number : raw;
      }
    }
    cells.set(a.r, value);
  }
  return cells;
}

export function parseRelationships(xml = '') {
  const result = new Map();
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g)) {
    const a = attrs(match[1]);
    if (a.Id && a.Target) result.set(a.Id, a.Target);
  }
  return result;
}

export function parseWorkbookSheets(xml = '') {
  const result = [];
  for (const match of xml.matchAll(/<sheet\b([^>]*?)(?:\/>|>)/g)) {
    const a = attrs(match[1]);
    if (a.name && (a['r:id'] || a.id)) result.push({ name: a.name, relationshipId: a['r:id'] || a.id });
  }
  return result;
}

function normalizePath(path) {
  const output = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') output.pop(); else output.push(part);
  }
  return output.join('/');
}

export function resolveZipPath(baseFile, target) {
  if (target.startsWith('/')) return normalizePath(target.slice(1));
  const base = baseFile.split('/'); base.pop();
  return normalizePath([...base, target].join('/'));
}

function relsPath(file) {
  const parts = file.split('/');
  const name = parts.pop();
  return [...parts, '_rels', `${name}.rels`].join('/');
}

function findEocd(view) {
  const signature = 0x06054b50;
  const start = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  throw new Error('不是有效的 XLSX/ZIP 文件');
}

function parseZipDirectory(buffer) {
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('XLSX ZIP 中央目录损坏');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, fileNameLength));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

async function unzipEntry(buffer, entry) {
  const view = new DataView(buffer);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`XLSX ZIP 条目损坏：${entry.name}`);
  const fileNameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  const compressed = new Uint8Array(buffer, dataStart, entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(compressed);
  if (entry.method !== 8) throw new Error(`不支持的 XLSX ZIP 压缩方式：${entry.method}`);
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持 XLSX 解压，请升级浏览器');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function mimeForPath(path) {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] || 'application/octet-stream';
}

export async function readXlsxCachedWorkbook(arrayBuffer, requestedSheetNames = []) {
  const buffer = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : await arrayBuffer.arrayBuffer();
  const entries = parseZipDirectory(buffer);
  const textDecoder = new TextDecoder('utf-8');
  const text = async path => {
    const entry = entries.get(path);
    if (!entry) return '';
    return textDecoder.decode(await unzipEntry(buffer, entry));
  };
  const bytes = async path => {
    const entry = entries.get(path);
    return entry ? unzipEntry(buffer, entry) : null;
  };

  const workbookPath = 'xl/workbook.xml';
  const workbookXml = await text(workbookPath);
  if (!workbookXml) throw new Error('XLSX 缺少 workbook.xml');
  const workbookRels = parseRelationships(await text(relsPath(workbookPath)));
  const sharedStrings = parseSharedStrings(await text('xl/sharedStrings.xml'));
  const sheetDefs = parseWorkbookSheets(workbookXml);
  const names = requestedSheetNames.length ? new Set(requestedSheetNames) : null;
  const sheets = new Map();

  for (const sheetDef of sheetDefs) {
    if (names && !names.has(sheetDef.name)) continue;
    const target = workbookRels.get(sheetDef.relationshipId);
    if (!target) continue;
    const sheetPath = resolveZipPath(workbookPath, target);
    const sheetXml = await text(sheetPath);
    const cells = parseWorksheetCells(sheetXml, sharedStrings);
    const sheetRels = parseRelationships(await text(relsPath(sheetPath)));
    const drawingMatch = sheetXml.match(/<drawing\b[^>]*r:id="([^"]+)"[^>]*\/?\s*>/);
    let images = [];
    if (drawingMatch) {
      const drawingTarget = sheetRels.get(drawingMatch[1]);
      if (drawingTarget) {
        const drawingPath = resolveZipPath(sheetPath, drawingTarget);
        const drawingXml = await text(drawingPath);
        const drawingRels = parseRelationships(await text(relsPath(drawingPath)));
        const ids = [...drawingXml.matchAll(/<a:blip\b[^>]*r:embed="([^"]+)"/g)].map(match => match[1]);
        for (const id of ids) {
          const imageTarget = drawingRels.get(id);
          if (!imageTarget) continue;
          const imagePath = resolveZipPath(drawingPath, imageTarget);
          const data = await bytes(imagePath);
          if (data) images.push({ path: imagePath, mime: mimeForPath(imagePath), data });
        }
      }
    }
    sheets.set(sheetDef.name, { name: sheetDef.name, path: sheetPath, cells, images });
  }
  return { sheets };
}
