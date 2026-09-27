import { readFile } from 'node:fs/promises';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) throw new Error('Expected baseline and candidate benchmark JSON files');
const [before, after] = await Promise.all([beforePath, afterPath].map(async path =>
  JSON.parse(await readFile(path, 'utf8'))));

if (before.occluders !== after.occluders) throw new Error('Vision benchmark geometry count differs');
const cases = [
  ...[120, 500, 1000, 10000].map(range => [`visibility.${range}`, before.visibility?.[range], after.visibility?.[range], range === 1000 ? 0.30 : null]),
  ['sweep', before.sweep, after.sweep, 0.50],
  ['multiLight500', before.multiLight500, after.multiLight500, null],
];
const report = {};
for (const [name, baseline, candidate, minimumReduction] of cases) {
  if (!baseline || !candidate || baseline.hash !== candidate.hash) throw new Error(`${name} visible cells differ`);
  if (!(baseline.medianMs > 0) || !(candidate.medianMs > 0)) throw new Error(`${name} has no valid timings`);
  const reduction = 1 - candidate.medianMs / baseline.medianMs;
  report[name] = { baselineMs: baseline.medianMs, candidateMs: candidate.medianMs, reduction };
  if (minimumReduction !== null && reduction < minimumReduction) {
    throw new Error(`${name} reduced by ${(reduction * 100).toFixed(1)}%; expected at least ${(minimumReduction * 100).toFixed(0)}%`);
  }
}
console.log(JSON.stringify(report, null, 2));
