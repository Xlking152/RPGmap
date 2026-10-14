import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildRulesetArchive, inspectRulesetArchive } from '../deployment/local-server/ruleset-store.mjs';
import { mapFileHash } from '../src/packages/map-archive.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { minimalRuleset } from '../src/rulesets/minimal/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const option = process.argv.indexOf('--out');
if (option >= 0 && !process.argv[option + 1]) throw new Error('--out requires a directory');
const { version: applicationVersion } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const output = path.resolve(option >= 0 ? process.argv[option + 1] : path.join(root, 'release', `RPGmap-v${applicationVersion}-验收`));
await mkdir(output, { recursive: true });
let sourceCommit = 'uncommitted';
try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch {}
const receipts = [];
for (const candidate of [
  { source: 'src/rulesets/infinite-horror/index.js', ruleset: infiniteHorrorRuleset, filename: `无限规则-${infiniteHorrorRuleset.version}.rpgrules` },
  { source: 'src/rulesets/minimal/index.js', ruleset: minimalRuleset, filename: `验收附件/最小测试规则-${minimalRuleset.version}.rpgrules` },
]) {
  const result = await build({
    configFile: false, root, logLevel: 'warn',
    build: { write: false, target: 'esnext', sourcemap: false, minify: true,
      lib: { entry: path.join(root, candidate.source), formats: ['es'], fileName: () => 'entry.mjs' },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const emitted = (Array.isArray(result) ? result : [result]).flatMap(item => item.output || []);
  const entry = emitted.find(item => item.type === 'chunk' && item.isEntry);
  if (!entry || emitted.some(item => item.type === 'chunk' && (item.imports.length || item.dynamicImports.length))) {
    throw new Error('Ruleset export must be self-contained and browser/server compatible');
  }
  const files = new Map(emitted.filter(item => item.type === 'asset').map(item => [`assets/${item.fileName}`, Buffer.from(item.source)]));
  const bytes = buildRulesetArchive({ ruleset: candidate.ruleset, entry: entry.code, files, metadata: { sourceCommit, author: 'RPGmap' } });
  const inspected = inspectRulesetArchive(bytes), target = path.join(output, ...candidate.filename.split('/'));
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
  receipts.push({ filename: candidate.filename, id: inspected.manifest.id, version: inspected.manifest.version,
    fingerprint: inspected.fingerprint, sha256: mapFileHash(bytes), size: bytes.length, sourceCommit });
  console.log(`Exported ${candidate.filename} (${bytes.length} bytes)`);
}
await writeFile(path.join(output, '规则打包记录.json'), JSON.stringify({ formatVersion: 1, packages: receipts }, null, 2));
