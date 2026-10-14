import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const failureDetails = (error, stage) => ({ stage, message: error?.message || String(error),
  code: error?.code || null, stack: error?.stack || null, failedAt: new Date().toISOString() });

// Persist completed ordinary measurements before a supplementary audit can
// throw. A checkpoint records progress, never a passing acceptance result.
export async function completeBrowserBenchmarkReport(outputRoot, measurements, { runAudit = null } = {}) {
  const checkpoint = { ...measurements, incrementalEnvironment: null,
    measurementStatus: runAudit ? 'environment-audit-pending' : 'measurements-complete' };
  const save = (file, report) => writeFile(path.join(outputRoot, file), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await save('checkpoint.json', checkpoint);
  let incrementalEnvironment;
  try { incrementalEnvironment = runAudit ? await runAudit() : null; }
  catch (error) {
    await save('report.json', { ...checkpoint, measurementStatus: 'failed',
      failure: failureDetails(error, 'incremental-environment-audit') });
    throw error;
  }
  const report = { ...measurements, incrementalEnvironment, measurementStatus: 'measurements-complete' };
  await save('report.json', report);
  return report;
}

export async function finishBrowserBenchmarkReport(outputRoot, measurements,
  { error = null, stage = 'acceptance-validation', asserted = false } = {}) {
  const report = { ...measurements, measurementStatus: error ? 'failed'
    : asserted ? 'passed' : 'measurements-complete',
    ...(error ? { failure: failureDetails(error, stage) } : {}) };
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
