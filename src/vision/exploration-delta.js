import { computeFogExplorationAsync, finishFogWork, normalizeFogState } from './fog.js';

// Both inputs are normalized, sorted closed integer intervals. The result owns
// its spans so it cannot modify confirmed history or the calculation's base.
function* unexploredRowsSteps(rows, exploredRows) {
  const result = {};
  for (const [row, spans] of Object.entries(rows)) {
    const known = exploredRows[row] || [];
    const next = [];
    let knownIndex = 0;
    for (const [start, end] of spans) {
      while (knownIndex < known.length && known[knownIndex][1] < start) knownIndex++;
      let cursor = start, index = knownIndex;
      while (index < known.length && known[index][0] <= end) {
        const [knownStart, knownEnd] = known[index];
        if (knownStart > cursor) next.push([cursor, Math.min(end, knownStart - 1)]);
        cursor = Math.max(cursor, knownEnd + 1);
        if (cursor > end) break;
        index++;
      }
      if (cursor <= end) next.push([cursor, end]);
      knownIndex = index;
    }
    if (next.length) result[row] = next;
    yield;
  }
  return result;
}

export async function computeFogExplorationDeltaAsync(input, options = {}) {
  // Existing callers and durable jobs without an explicit current-history
  // snapshot keep the complete exploration result and original entry point.
  if (!Object.hasOwn(input, 'exploredRows')) return computeFogExplorationAsync(input, {}, options);
  options.signal?.throwIfAborted();
  const partyId = String(input.partyId ?? '').trim().slice(0, 80);
  const base = normalizeFogState({ exploredByParty: Object.fromEntries([
    [partyId, { rows: input.exploredRows }],
  ]) }, input.map);
  const known = base.exploredByParty[partyId]?.rows || {};
  const result = await computeFogExplorationAsync(input, base, options);
  result.exploredByParty[partyId].rows = await finishFogWork(
    unexploredRowsSteps(result.exploredByParty[partyId].rows, known), options);
  return result;
}
