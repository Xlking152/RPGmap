import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { completeBrowserBenchmarkReport, finishBrowserBenchmarkReport } from '../scripts/browser-benchmark-report.mjs';

const measurements = () => ({ build: { metadata: { sourceCommit: 'frozen-app' }, fileHashes: { 'app/index.html': 'hash' } },
  fixture: { sessions: 7, actors: 100, tokens: 500, viewport: '1920x1080' },
  phases: [{ name: 'normal', seconds: 60, operations: 119 }, { name: 'los-light', seconds: 60, operations: 118 }],
  recovery: { recoveredMs: 6500, projectionMatches: Array(7).fill(true) } });
const json = async (root, name) => JSON.parse(await readFile(path.join(root, name), 'utf8'));
async function output(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-benchmark-report-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('completed phase/recovery/build/fixture checkpoint exists before the supplementary audit begins', async t => {
  const directory = await output(t), measured = measurements();
  const audit = { passed: true, rounds: 12, samples: Array(72).fill({}) };
  const result = await completeBrowserBenchmarkReport(directory, measured, { runAudit: async () => {
    assert.deepEqual(await json(directory, 'checkpoint.json'), { ...measured,
      incrementalEnvironment: null, measurementStatus: 'environment-audit-pending' });
    return audit;
  } });
  assert.deepEqual(result, { ...measured, incrementalEnvironment: audit, measurementStatus: 'measurements-complete' });
  assert.deepEqual(await json(directory, 'report.json'), result);
  assert.notEqual(result.measurementStatus, 'passed');
});

test('supplementary audit failure preserves completed measurements, records failure and rethrows without retry', async t => {
  const directory = await output(t), measured = measurements();
  const refusal = Object.assign(new Error('cleanup refused'), { code: 'scene_setting_forbidden' });
  let calls = 0;
  await assert.rejects(completeBrowserBenchmarkReport(directory, measured, { runAudit: async () => {
    calls += 1;
    assert.equal((await json(directory, 'checkpoint.json')).measurementStatus, 'environment-audit-pending');
    throw refusal;
  } }), error => error === refusal);
  const report = await json(directory, 'report.json');
  assert.equal(calls, 1);
  assert.equal(report.measurementStatus, 'failed');
  assert.equal(report.incrementalEnvironment, null);
  assert.equal(report.failure.stage, 'incremental-environment-audit');
  assert.equal(report.failure.code, refusal.code);
  assert.equal(report.failure.message, refusal.message);
  for (const key of ['build', 'fixture', 'phases', 'recovery']) assert.deepEqual(report[key], measured[key]);
});

test('final acceptance and session failures overwrite only report status while preserving every measured result', async t => {
  const directory = await output(t);
  const measured = await completeBrowserBenchmarkReport(directory, measurements());
  const failure = Object.assign(new Error('original network gate failed'), { code: 'acceptance_failed' });
  const failed = await finishBrowserBenchmarkReport(directory, measured, { error: failure });
  assert.equal(failed.measurementStatus, 'failed');
  assert.equal(failed.failure.stage, 'acceptance-validation');
  assert.equal(failed.failure.message, failure.message);
  assert.deepEqual(failed.phases, measured.phases);
  assert.deepEqual(failed.recovery, measured.recovery);
  assert.deepEqual(await json(directory, 'report.json'), failed);
  assert.equal((await json(directory, 'checkpoint.json')).measurementStatus, 'measurements-complete');
  const checked = await finishBrowserBenchmarkReport(directory, measured, { asserted: true });
  assert.equal(checked.measurementStatus, 'passed');
  const unchecked = await finishBrowserBenchmarkReport(directory, measured);
  assert.equal(unchecked.measurementStatus, 'measurements-complete');
});

test('audit and cleanup errors both survive serialization without replacing completed browser measurements', async t => {
  const directory = await output(t), measured = measurements();
  const primary = Object.assign(new Error('No acknowledged Document commit'), { code: 'audit_commit_unproven' });
  const cleanup = Object.assign(new Error('Cleanup refused'), { code: 'revision_conflict' });
  const error = new AggregateError([primary, cleanup], 'Audit and cleanup both failed');
  await assert.rejects(completeBrowserBenchmarkReport(directory, measured,
    { runAudit: async () => { throw error; } }), value => value === error);
  const report = await json(directory, 'report.json');
  assert.equal(report.measurementStatus, 'failed');
  assert.deepEqual(report.failure.errors.map(child => [child.message, child.code]),
    [[primary.message, primary.code], [cleanup.message, cleanup.code]]);
  assert.deepEqual(report.phases, measured.phases);
  assert.deepEqual(report.recovery, measured.recovery);
});
