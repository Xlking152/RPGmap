import test from 'node:test';
import assert from 'node:assert/strict';
import { hasCompletePreciseTokenProjection } from '../deployment/local-server/movement-projection.mjs';

function instrumentedTokens(tokens) {
  let indexed = 0;
  const projected = tokens.slice();
  Object.defineProperty(projected, 'map', { value(callback) {
    indexed += this.length;
    return Array.prototype.map.call(this, callback);
  } });
  return { projected, indexed: () => indexed };
}

const canonical = Array.from({ length: 500 }, (_, index) => ({ id: `token-${index}` }));

test('six-party source views choose full projection before preparing a discarded 500-token index', () => {
  for (let party = 0; party < 6; party++) {
    const { projected, indexed } = instrumentedTokens(canonical.map((token, index) => ({ ...token,
      ...(index % 6 === party ? {} : { audienceRestricted: true }),
    })));
    assert.equal(hasCompletePreciseTokenProjection(projected, canonical), false);
    assert.equal(indexed(), 0);
  }
  for (const hidden of ['omitted', 'vague']) {
    const tokens = hidden === 'omitted' ? canonical.slice(1)
      : canonical.map((token, index) => index === 0 ? { ...token, audienceVisibility: 'vague' } : token);
    const { projected, indexed } = instrumentedTokens(tokens);
    assert.equal(hasCompletePreciseTokenProjection(projected, canonical), false);
    assert.equal(indexed(), 0);
  }
});

test('fully precise source views retain the complete identity check, including reordered and missing IDs', () => {
  const { projected, indexed } = instrumentedTokens(canonical.toReversed());
  const before = JSON.stringify(projected);
  assert.equal(hasCompletePreciseTokenProjection(projected, canonical), true);
  assert.equal(indexed(), 500);
  assert.equal(JSON.stringify(projected), before);
  const sameCountWrongIdentity = canonical.map((token, index) => index === 0 ? { id: 'unexpected-token' } : token);
  assert.equal(hasCompletePreciseTokenProjection(sameCountWrongIdentity, canonical), false);
  const duplicateIdentity = canonical.map((token, index) => index === 0 ? canonical[1] : token);
  assert.equal(hasCompletePreciseTokenProjection(duplicateIdentity, canonical), false);
  assert.equal(hasCompletePreciseTokenProjection([null], [{ id: 'token' }]), false);
  assert.equal(hasCompletePreciseTokenProjection([], []), true);
});
