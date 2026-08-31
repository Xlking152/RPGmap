import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { importInfiniteHorrorActorXlsx } from '../src/rulesets/infinite-horror/importers/xlsx.js';

function argumentsMap(argv) {
  const result = { senses: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--file') result.file = argv[++index];
    else if (key === '--expect-precise') result.precise = Number(argv[++index]);
    else if (key === '--expect-vague') result.vague = Number(argv[++index]);
    else if (key === '--expect-sense') {
      const [sense, raw] = String(argv[++index] || '').split('=');
      result.senses[sense] = ['true', '1', 'yes'].includes(String(raw).toLowerCase());
    }
  }
  return result;
}

const options = argumentsMap(process.argv.slice(2));
if (!options.file) {
  console.error('Usage: npm run test:xlsx -- --file <character.xlsx> [--expect-precise N --expect-vague N --expect-sense key=true]');
  process.exitCode = 2;
} else {
  try {
    const filePath = resolve(options.file);
    const bytes = await readFile(filePath);
    const imported = await importInfiniteHorrorActorXlsx({
      name: basename(filePath),
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    });
    const detection = imported.detection || {};
    const diagnostics = detection.diagnostics || {};
    const output = {
      file: filePath,
      sheets: imported.source?.sheets || [],
      identity: imported.identity,
      resources: Object.fromEntries(Object.entries(imported.resources || {}).map(([key, item]) => [key, item.max])),
      attributes: Object.fromEntries((imported.attributes || []).map(item => [item.id, item.base + item.legendaryBonus])),
      detection: {
        precise: diagnostics.precise,
        vague: diagnostics.vague,
        senses: diagnostics.senses,
      },
      warnings: imported.source?.warnings || [],
    };
    console.log(JSON.stringify(output, null, 2));

    const failures = [];
    if (!String(imported.identity?.name || '').trim()) failures.push('identity.name is empty');
    if (Number.isFinite(options.precise) && Number(detection.preciseRangeMeters) !== options.precise) {
      failures.push(`precise range expected ${options.precise}, got ${detection.preciseRangeMeters}`);
    }
    if (Number.isFinite(options.vague) && Number(detection.vagueRangeMeters) !== options.vague) {
      failures.push(`vague range expected ${options.vague}, got ${detection.vagueRangeMeters}`);
    }
    for (const [sense, expected] of Object.entries(options.senses)) {
      if (detection.senses?.[sense] !== expected) failures.push(`${sense} expected ${expected}, got ${detection.senses?.[sense]}`);
    }
    const criticalWarnings = (imported.source?.warnings || []).filter(warning => [
      'detection_range_unparseable', 'detection_boolean_unparseable', 'detection_label_missing',
    ].includes(warning.code));
    if (criticalWarnings.length) failures.push(`${criticalWarnings.length} critical detection warning(s)`);
    if (failures.length) {
      console.error(`XLSX validation failed:\n- ${failures.join('\n- ')}`);
      process.exitCode = 1;
    }
  } catch (error) {
    if (Array.isArray(error?.warnings)) {
      console.error(JSON.stringify({ warnings: error.warnings }, null, 2));
    }
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
