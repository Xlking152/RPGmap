import { getActiveRuleset } from '../ruleset/index.js';

function xlsxImporter() {
  const importer = getActiveRuleset().importers?.xlsx;
  if (!importer || typeof importer !== 'object') throw new Error('Active ruleset does not provide an XLSX importer');
  return importer;
}

export function guessFormName(fileName = '') {
  const guess = xlsxImporter().guessFormName;
  return typeof guess === 'function' ? guess(fileName) : String(fileName || '').trim() || '默认形态';
}

export function parseCharacterSheets(input = {}) {
  const parse = xlsxImporter().parse;
  if (typeof parse !== 'function') throw new Error('Active ruleset XLSX importer does not implement parse()');
  return parse(input);
}

export async function importCharacterXlsx(file) {
  const importFile = xlsxImporter().importFile;
  if (typeof importFile !== 'function') throw new Error('Active ruleset XLSX importer does not implement importFile()');
  return importFile(file);
}
