import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../src/app/storage.js';

test('server-runtime memory storage never depends on browser localStorage', () => {
  const storage = createMemoryStorage();
  assert.equal(storage.get('world'), null);
  storage.set('world', '{"revision":1}');
  assert.equal(storage.get('world'), '{"revision":1}');
  storage.remove('world');
  assert.equal(storage.get('world'), null);
});
