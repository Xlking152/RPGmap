import test from 'node:test';
import assert from 'node:assert/strict';

import { createTokenGhostDescriptor, isMovementEndpointLayer } from '../src/engine/token-ghost.js';

test('token ghost descriptor preserves the Token appearance and endpoint state', () => {
  const descriptor = createTokenGhostDescriptor({
    id: 'hero', name: 'Han', color: '#123abc', avatarDataUrl: 'data:image/webp;base64,AAAA'
  }, { x: 125.5, y: 88.25 }, { blocked: true });
  assert.deepEqual(descriptor.point, { x: 125.5, y: 88.25 });
  assert.equal(descriptor.tokenId, 'hero');
  assert.equal(descriptor.color, '#123abc');
  assert.equal(descriptor.avatarDataUrl, 'data:image/webp;base64,AAAA');
  assert.equal(descriptor.blocked, true);
});

test('ghost only follows the dedicated movement endpoint circle marker', () => {
  assert.equal(isMovementEndpointLayer({ pane: 'measurePane', radius: 9, interactive: false }), true);
  assert.equal(isMovementEndpointLayer({ pane: 'measurePane', radius: 5, interactive: false }), false);
  assert.equal(isMovementEndpointLayer({ pane: 'tokenPane', radius: 9, interactive: false }), false);
  assert.equal(isMovementEndpointLayer({ pane: 'measurePane', radius: 9, interactive: true }), false);
});
