import { readXlsxCachedWorkbook } from './xlsx-lite.js';

const REQUIRED_SHEETS = Object.freeze(['角色概览', '具体数值表']);
const ATTRIBUTES = Object.freeze([
  ['intelligence', '智力', 21], ['perception', '感知', 22], ['resolve', '决心', 23],
  ['strength', '力量', 24], ['dexterity', '敏捷', 25], ['endurance', '耐力', 26],
  ['presence', '风度', 27], ['manipulation', '操控', 28], ['composure', '沉着', 29],
]);

function value(sheet, ref, fallback = null) {
  const found = sheet?.cells?.get(ref);
  return found === undefined || found === null || found === '' ? fallback : found;
}

function number(sheet, ref, fallback = 0) {
  const parsed = Number(value(sheet, ref, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? fallback : String(value);
}

export function guessFormName(fileName = '') {
  if (/变身前/.test(fileName)) return '变身前';
  if (/变身后/.test(fileName)) return '变身后';
  const stem = String(fileName).replace(/\.xlsx$/i, '').replace(/\s*\(\d+\)\s*$/, '').trim();
  return stem || '默认形态';
}

export function parseCharacterSheets({ overview, detailed, fileName = '', avatarImage = null } = {}) {
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
    id, name, base: number(detailed, `N${row}`), legendaryBonus: number(detailed, `P${row}`),
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
    if ([light, severe, destruction].every(Number.isFinite)) {
      thresholds = { light, severe, destruction };
    }
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
  return {
    templateId: 'rpgmap-character-card-v1',
    formName: guessFormName(fileName),
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
    tokenAppearance: { color: '#3d9b63', scale: 1 },
    avatarImage,
    source: {
      type: 'xlsx',
      template: 'rpgmap-character-card-v1',
      fileName,
      importedAt: new Date().toISOString(),
      sheets: [...REQUIRED_SHEETS],
    },
  };
}

export async function importCharacterXlsx(file) {
  const arrayBuffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const workbook = await readXlsxCachedWorkbook(arrayBuffer, REQUIRED_SHEETS);
  const overview = workbook.sheets.get('角色概览');
  const detailed = workbook.sheets.get('具体数值表');
  if (!overview || !detailed) throw new Error('无法识别角色卡：缺少“角色概览”或“具体数值表”');
  const avatarImage = detailed.images?.[0] || overview.images?.[0] || null;
  return parseCharacterSheets({ overview, detailed, fileName: file?.name || '', avatarImage });
}
