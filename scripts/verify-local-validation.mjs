import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [directory, version, commit] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) {
  throw new Error('Expected candidate directory, version and full commit');
}
const validation = JSON.parse(await readFile(path.join(directory, 'local-validation.json'), 'utf8'));
if (validation.version !== version || validation.commit !== commit) throw new Error('Local validation source mismatch');
for (const check of ['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'edge', 'chrome']) {
  if (validation.checks?.[check] !== 'passed') throw new Error(`Local check missing: ${check}`);
}
const archive = await readFile(path.join(directory, `RPGmap-v${version}.zip`));
if (createHash('sha256').update(archive).digest('hex') !== validation.sha256) {
  throw new Error('Validated ZIP checksum mismatch');
}
console.log('Local validation source, checks and ZIP hash verified');
