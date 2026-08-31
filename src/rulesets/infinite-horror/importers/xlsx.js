import { readXlsxCachedWorkbook } from '../../../entities/xlsx-lite.js';

export const INFINITE_HORROR_XLSX_REQUIRED_SHEETS = Object.freeze(['角色概览', '具体数值表']);
const ATTRIBUTES = Object.freeze([
  ['intelligence', '智力', 21], ['perception', '感知', 22], ['resolve', '决心', 23],
  ['strength', '力量', 24], ['dexterity', '敏捷', 25], ['endurance', '耐力', 26],
  ['presence', '风度', 27], ['manipulation', '操控', 28], ['composure', '沉着', 29],
]);
const DETECTION_COLUMNS = Object.freeze(['S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC', 'AD']);
const DETECTION_SENSE_LABELS = Object.freeze({
  trueSight: Object.freeze(['真实视觉', '真实视野', '真视']),
  xrayVision: Object.freeze(['透视', '透视视觉']),
  spiritSight: Object.freeze(['灵视', '灵体视觉']),
  lowLightVision: Object.freeze(['昏暗视觉', '微光视觉', '低光视觉']),
  darkvision: Object.freeze(['黑暗视觉', '暗视']),
});

function value(sheet, ref, fallback = null) {
  const found = sheet?.cells?.get(ref);
  return found === undefined || found === null || found === '' ? fallback : found;
}

function number(sheet, ref, fallback = 0) {
  const parsed = Number(value(sheet, ref, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(raw, fallback = '') {
  return typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? fallback : String(raw);
}

export function normalizeInfiniteHorrorSheetLabel(raw) {
  return String(raw ?? '').normalize('NFKC').replace(/[\s\u00a0]+/g, '').replace(/[：:]/g, '').trim();
}

export function parseDetectionRangeValue(raw) {
  if (raw === null || raw === undefined || raw === '') return { meters: 0, valid: true, empty: true, raw };
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0
      ? { meters: raw, valid: true, empty: false, raw }
      : { meters: 0, valid: false, empty: false, raw };
  }
  const normalized = String(raw).normalize('NFKC').trim().replace(/米$/u, '').replace(/m$/iu, '').trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0
    ? { meters: parsed, valid: true, empty: false, raw }
    : { meters: 0, valid: false, empty: false, raw };
}

export function parseDetectionBoolean(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: false, valid: true, empty: true, raw };
  if (typeof raw === 'boolean') return { value: raw, valid: true, empty: false, raw };
  if (typeof raw === 'number') return raw === 0 || raw === 1
    ? { value: raw === 1, valid: true, empty: false, raw }
    : { value: false, valid: false, empty: false, raw };
  const normalized = normalizeInfiniteHorrorSheetLabel(raw).toLowerCase();
  if (['√', '✓', '✔', '是', '启用', 'true', '1', '有'].includes(normalized)) {
    return { value: true, valid: true, empty: false, raw };
  }
  if (['×', 'x', '✕', '否', '未启用', 'false', '0', '无', '-'].includes(normalized)) {
    return { value: false, valid: true, empty: false, raw };
  }
  return { value: false, valid: false, empty: false, raw };
}

function columnNumber(address) {
  return [...String(address).match(/^[A-Z]+/)?.[0] || ''].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function columnName(number) {
  let value = number;
  let name = '';
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function findSenseValueCell(sheet, labelAddress, row) {
  const start = columnNumber(labelAddress) + 1;
  const end = Math.min(columnNumber('AD'), start + 4);
  for (let column = start; column <= end; column += 1) {
    const address = `${columnName(column)}${row}`;
    const raw = sheet?.cells?.get(address);
    if (raw !== undefined && raw !== null && raw !== '') return { address, raw };
  }
  return { address: `${columnName(Math.min(columnNumber('AD'), start))}${row}`, raw: null };
}

export function parseInfiniteHorrorDetectionSheet(detailed) {
  const warnings = [];
  const precise = parseDetectionRangeValue(value(detailed, 'X62'));
  const vague = parseDetectionRangeValue(value(detailed, 'X63'));
  if (!precise.valid) warnings.push({ code: 'detection_range_unparseable', address: 'X62', raw: precise.raw });
  if (!vague.valid) warnings.push({ code: 'detection_range_unparseable', address: 'X63', raw: vague.raw });
  if (vague.valid && precise.valid && vague.meters < precise.meters) {
    warnings.push({ code: 'detection_vague_below_precise', precise: precise.meters, vague: vague.meters });
  }

  const aliases = new Map();
  for (const [key, labels] of Object.entries(DETECTION_SENSE_LABELS)) {
    for (const label of labels) aliases.set(normalizeInfiniteHorrorSheetLabel(label), key);
  }
  const matches = new Map();
  for (let row = 60; row <= 68; row += 1) {
    for (const column of DETECTION_COLUMNS) {
      const address = `${column}${row}`;
      const rawLabel = value(detailed, address, null);
      const key = aliases.get(normalizeInfiniteHorrorSheetLabel(rawLabel));
      if (!key) continue;
      const existing = matches.get(key) || [];
      existing.push({ address, row, rawLabel });
      matches.set(key, existing);
    }
  }

  const senses = {};
  const senseDiagnostics = {};
  for (const key of Object.keys(DETECTION_SENSE_LABELS)) {
    const found = matches.get(key) || [];
    if (!found.length) {
      warnings.push({ code: 'detection_label_missing', sense: key });
      senses[key] = false;
      senseDiagnostics[key] = { labelAddress: null, rawLabel: null, address: null, raw: null, value: false };
      continue;
    }
    if (found.length > 1) warnings.push({ code: 'detection_label_duplicate', sense: key, addresses: found.map(item => item.address) });
    const label = found[0];
    const cell = findSenseValueCell(detailed, label.address, label.row);
    const parsed = parseDetectionBoolean(cell.raw);
    if (!parsed.valid) warnings.push({ code: 'detection_boolean_unparseable', sense: key, address: cell.address, raw: cell.raw });
    senses[key] = parsed.value;
    senseDiagnostics[key] = {
      labelAddress: label.address,
      rawLabel: label.rawLabel,
      address: cell.address,
      raw: cell.raw,
      value: parsed.value,
    };
  }

  return {
    detection: {
      configured: true,
      preciseRangeMeters: precise.meters,
      vagueRangeMeters: vague.meters,
      senses,
      diagnostics: {
        precise: { address: 'X62', raw: precise.raw, meters: precise.meters },
        vague: { address: 'X63', raw: vague.raw, meters: vague.meters },
        senses: senseDiagnostics,
      },
    },
    warnings,
  };
}

export function guessInfiniteHorrorFormName(fileName = '') {
  if (/变身前/.test(fileName)) return '变身前';
  if (/变身后/.test(fileName)) return '变身后';
  const stem = String(fileName).replace(/\.xlsx$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  return stem || '默认形态';
}

export function resolveInfiniteHorrorWorkbookSheets(workbook) {
  const sheets = workbook?.sheets instanceof Map ? [...workbook.sheets.values()] : [];
  const matches = expected => sheets.filter(sheet => (
    normalizeInfiniteHorrorSheetLabel(sheet?.name) === normalizeInfiniteHorrorSheetLabel(expected)
  ));
  const overviewMatches = matches('角色概览');
  const detailedMatches = matches('具体数值表');
  const warnings = [];
  if (!overviewMatches.length) warnings.push({ code: 'sheet_missing', sheet: '角色概览' });
  if (!detailedMatches.length) warnings.push({ code: 'sheet_missing', sheet: '具体数值表' });
  if (overviewMatches.length > 1 || detailedMatches.length > 1) {
    warnings.push({ code: 'sheet_name_duplicate', sheets: [
      ...overviewMatches.map(sheet => sheet.name), ...detailedMatches.map(sheet => sheet.name),
    ] });
  }
  return {
    overview: overviewMatches[0] || null,
    detailed: detailedMatches[0] || null,
    sheets: [overviewMatches[0]?.name, detailedMatches[0]?.name].filter(Boolean),
    warnings,
  };
}

export function parseInfiniteHorrorActorSheets({ overview, detailed, fileName = '', avatarImage = null } = {}) {
  if (!overview || !detailed) throw new Error('角色卡必须包含“角色概览”和“具体数值表”');

  const identity = {
    name: clean(value(detailed, 'C1'), '未命名角色'),
    gender: clean(value(detailed, 'C3')),
    age: clean(value(detailed, 'C5')),
    height: value(detailed, 'C7'),
    weight: value(detailed, 'C9'),
    race: clean(value(detailed, 'C11')),
    nationality: clean(value(detailed, 'C13')),
    language: clean(value(detailed, 'C15')),
    virtueVice: clean(value(detailed, 'C17')),
  };

  const resources = {
    willpower: { id: 'willpower', name: clean(value(detailed, 'K1'), '意志'), max: number(detailed, 'M1') },
    stamina: { id: 'stamina', name: clean(value(detailed, 'K3'), '精力'), max: number(detailed, 'M3') },
    hp: { id: 'hp', name: clean(value(detailed, 'K5'), '生命'), max: number(detailed, 'M5') },
  };

  const attributes = ATTRIBUTES.map(([id, name, row]) => ({
    id,
    name,
    base: number(detailed, `N${row}`),
    legendaryBonus: number(detailed, `P${row}`),
  }));

  const skills = [];
  let category = '';
  for (let row = 31; row <= 59; row += 1) {
    const categoryCell = clean(value(detailed, `A${row}`)).replace(/\s/g, '');
    if (categoryCell) category = categoryCell;
    const name = clean(value(detailed, `B${row}`));
    if (!name) continue;
    const level = number(detailed, `E${row}`);
    const total = number(detailed, `I${row}`);
    const bonus = number(detailed, `M${row}`);
    const specialties = clean(value(detailed, `J${row}`));
    if (/[-－]$/.test(name) && !level && !total && !bonus && !specialties) continue;
    skills.push({
      id: `skill-${row}`,
      category: category || '技能',
      name,
      level,
      total,
      bonus,
      checkValue: level + bonus,
      specialties,
      sourceRow: row,
    });
  }

  const saves = [];
  for (let row = 72; row <= 74; row += 1) {
    const name = clean(value(detailed, `S${row}`));
    if (!name.includes('豁免')) continue;
    saves.push({
      id: `save-${row}`,
      name,
      checkValue: number(detailed, `AA${row}`),
      totalBonus: number(detailed, `AC${row}`),
      sourceRow: row,
    });
  }

  const badStatuses = [];
  let thresholds = { light: 0, severe: 0, destruction: 0 };
  for (let row = 32; row <= 52; row += 1) {
    const name = clean(value(detailed, `W${row}`));
    if (!name) continue;
    const light = Number(value(detailed, `AB${row}`, NaN));
    const severe = Number(value(detailed, `AC${row}`, NaN));
    const destruction = Number(value(detailed, `AD${row}`, NaN));
    if ([light, severe, destruction].every(Number.isFinite)) thresholds = { light, severe, destruction };
    badStatuses.push({
      id: `bad-status-${row}`,
      name,
      light: thresholds.light,
      severe: thresholds.severe,
      destruction: thresholds.destruction,
      sourceRow: row,
    });
  }

  const overviewText = clean(value(overview, 'I1'));
  const safeOverview = overviewText && !overviewText.startsWith('#') ? overviewText : '';
  const detectionResult = parseInfiniteHorrorDetectionSheet(detailed);

  return {
    templateId: 'rpgmap-character-card-v1',
    formName: guessInfiniteHorrorFormName(fileName),
    identity,
    description: {
      appearance: clean(value(detailed, 'O2')),
      personality: clean(value(detailed, 'O10')),
      summary: clean(value(detailed, 'S2')),
      overview: safeOverview,
    },
    resources,
    attributes,
    checks: { skills, saves },
    badStatuses,
    combat: { attacks: [], defenses: [] },
    detection: detectionResult.detection,
    tokenAppearance: { color: '#3d9b63', scale: 1 },
    avatarImage,
    source: {
      type: 'xlsx',
      template: 'rpgmap-character-card-v1',
      rulesetId: 'infinite-horror',
      fileName,
      importedAt: new Date().toISOString(),
      sheets: [...INFINITE_HORROR_XLSX_REQUIRED_SHEETS],
      warnings: detectionResult.warnings,
    },
  };
}

export async function importInfiniteHorrorActorXlsx(file) {
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const workbook = await readXlsxCachedWorkbook(arrayBuffer);
  const resolved = resolveInfiniteHorrorWorkbookSheets(workbook);
  const { overview, detailed } = resolved;
  if (!overview || !detailed) {
    const error = new Error('无法识别角色卡：缺少“角色概览”或“具体数值表”');
    error.code = 'xlsx_sheet_missing';
    error.warnings = resolved.warnings;
    throw error;
  }
  const avatarImage = detailed.images?.[0] || overview.images?.[0] || null;
  const result = parseInfiniteHorrorActorSheets({ overview, detailed, fileName: file?.name || '', avatarImage });
  result.source.sheets = resolved.sheets;
  result.source.warnings.push(...resolved.warnings);
  return result;
}
