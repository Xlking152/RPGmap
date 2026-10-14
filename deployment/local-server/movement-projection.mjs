// This only qualifies the existing incremental projection. A rejection still
// runs the complete audience projection, including fresh permission/detection
// checks. The caller supplies its validated canonical Scene and prior view.
export function hasCompletePreciseTokenProjection(projectedTokens, canonicalTokens) {
  if (projectedTokens.length < canonicalTokens.length
    || projectedTokens.some(token => token?.audienceRestricted === true
      || token?.audienceVisibility === 'vague')) return false;
  const byId = new Map(projectedTokens.map(token => [String(token?.id || ''), token]));
  return canonicalTokens.every(token => {
    const projected = byId.get(String(token?.id || ''));
    return projected && projected.audienceRestricted !== true && projected.audienceVisibility !== 'vague';
  });
}
