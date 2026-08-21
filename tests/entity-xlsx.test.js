import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorksheetCells, parseSharedStrings, parseRelationships, parseWorkbookSheets, resolveZipPath } from '../src/entities/xlsx-lite.js';
import { guessFormName, parseCharacterSheets } from '../src/entities/xlsx-importer.js';

function sheet(values) { return { cells: new Map(Object.entries(values)), images: [] }; }

test('xlsx-lite reads cached formula values and shared strings without evaluating formulas', () => {
  const shared = parseSharedStrings('<sst><si><t>银</t></si><si><r><t>变</t></r><r><t>身</t></r></si></sst>');
  const cells = parseWorksheetCells('<worksheet><sheetData><row><c r="C1" t="s"><v>0</v></c><c r="M5"><f>SUM(A1:A2)</f><v>41</v></c><c r="A3" t="str"><f>TEXT()</f><v>最终</v></c></row></sheetData></worksheet>', shared);
  assert.equal(cells.get('C1'), '银');
  assert.equal(cells.get('M5'), 41);
  assert.equal(cells.get('A3'), '最终');
  assert.deepEqual(shared, ['银', '变身']);
});

test('workbook relationship helpers resolve requested sheets', () => {
  const sheets = parseWorkbookSheets('<workbook><sheets><sheet name="角色概览" sheetId="1" r:id="rId1"/><sheet name="具体数值表" sheetId="2" r:id="rId2"/></sheets></workbook>');
  const rels = parseRelationships('<Relationships><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>');
  assert.equal(sheets[1].name, '具体数值表');
  assert.equal(resolveZipPath('xl/workbook.xml', rels.get('rId2')), 'xl/worksheets/sheet2.xml');
});

test('character card parser imports only final resources, attributes, skills and saves', () => {
  const detailed = sheet({
    C1:'银', C3:'女', C5:'16（12）', C11:'人造人', C13:'中', C15:'汉语', C17:'信念/骄傲',
    K1:'意志', M1:12, K3:'精力', M3:26, K5:'生命', M5:41,
    O2:'银发', O10:'温柔', S2:'人物概述',
    N21:11, P21:2, N22:3, N23:6, N24:24, P24:4, N25:20, N26:5, N27:8, N28:2, N29:5,
    A43:'生\n理', B43:'运动', E43:1, I43:1, M43:0,
    B46:'枪械', E46:4, I46:4, J46:'机枪，炮', M46:0,
    AA32:'力+敏', AB32:22, AC32:132, AD32:176,
    AA36:'耐+决', AB36:5, AC36:33, AD36:44,
  });
  const parsed = parseCharacterSheets({ overview: sheet({ I1:'#NAME?' }), detailed, fileName:'银（变身后）(1).xlsx' });
  assert.equal(parsed.formName, '变身后');
  assert.equal(parsed.resources.hp.max, 41);
  assert.equal(parsed.attributes.find(item => item.id === 'strength').base, 24);
  assert.equal(parsed.checks.skills.find(item => item.name === '枪械').checkValue, 4);
  assert.equal(parsed.checks.saves[0].devastating, 176);
  assert.equal(parsed.description.overview, '');
  assert.equal(parsed.combat.attacks.length, 0);
});

test('form name is inferred from file name', () => {
  assert.equal(guessFormName('银（变身前）(1).xlsx'), '变身前');
  assert.equal(guessFormName('银（变身后）.xlsx'), '变身后');
});
