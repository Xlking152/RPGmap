import assert from 'node:assert/strict';
import test from 'node:test';
import { readUiReviewOptions } from '../scripts/ui-review-options.mjs';

test('default session and existing first art review retain their original data roots', () => {
  assert.equal(readUiReviewOptions([]).sessionName, 'ui-local-session');
  assert.equal(readUiReviewOptions([]).mapVersion, '1.1.0');
  assert.equal(readUiReviewOptions(['--art-review']).sessionName, 'ui-art-session');
  assert.equal(readUiReviewOptions([], { defaultArtReview: true }).mapVersion, '1.1.1');
});

test('a second art candidate has a separate World, browser profile and archive directory', () => {
  const next = readUiReviewOptions(['--art-version', '1.1.2', '--interactive']);
  assert.equal(next.sessionName, 'ui-art-session-1.1.2');
  assert.equal(next.archiveDirectory, 'art-map-slice-v2');
  assert.equal(next.artReview, true);
  assert.equal(next.interactive, true);
  assert.notEqual(next.sessionName, readUiReviewOptions(['--art-review']).sessionName);
});

test('unknown versions, traversal, published version reuse and malformed arguments fail closed', () => {
  for (const version of ['1.1.0', '1.1.99', '../ui-art-session', '', '1.1.2/../data']) {
    assert.throws(() => readUiReviewOptions(['--art-version', version]));
  }
  assert.throws(() => readUiReviewOptions(['--art-version']));
  assert.throws(() => readUiReviewOptions(['--unknown']));
});
