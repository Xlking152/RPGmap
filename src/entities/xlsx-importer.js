import { getCompatibilityRuleset } from '../ruleset/active-compat.js';

function xlsxImporter(ruleset = getCompatibilityRuleset()) {
  const importer = ruleset?.importers?.xlsx;
  if (!importer || typeof importer !== 'object') {
    const error = new Error('Ruleset does not provide an XLSX importer');
    error.code = 'ruleset_capability_missing';
    throw error;
  }
  return importer;
}

export function guessFormName(fileName = '', { ruleset = getCompatibilityRuleset() } = {}) {
  const guess = xlsxImporter(ruleset).guessFormName;
  return typeof guess === 'function' ? guess(fileName) : String(fileName || '').trim() || '默认形态';
}

export function parseActorSheets(input = {}, { ruleset = getCompatibilityRuleset() } = {}) {
  const parse = xlsxImporter(ruleset).parse;
  if (typeof parse !== 'function') {
    const error = new Error('Ruleset XLSX importer does not implement parse()');
    error.code = 'ruleset_capability_missing';
    throw error;
  }
  return parse(input);
}

export async function importActorXlsx(file, { ruleset = getCompatibilityRuleset() } = {}) {
  const importFile = xlsxImporter(ruleset).importFile;
  if (typeof importFile !== 'function') {
    const error = new Error('Ruleset XLSX importer does not implement importFile()');
    error.code = 'ruleset_capability_missing';
    throw error;
  }
  return importFile(file);
}
