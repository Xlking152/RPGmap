import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppLifecycleSystem } from '../src/engine/lifecycle.js';

test('App lifecycle emits app:destroy before core teardown and only once', () => {
  const calls = [];
  const api = {
    emit(name, detail) {
      calls.push({ name, detail });
    },
    destroy() {
      calls.push({ name: 'core:destroy' });
    },
  };

  createAppLifecycleSystem().register(api);

  assert.equal(api.destroy(), true);
  assert.equal(api.destroy(), false);
  assert.deepEqual(calls, [
    { name: 'app:destroy', detail: null },
    { name: 'core:destroy' },
  ]);
});

test('App lifecycle registration is idempotent', () => {
  const calls = [];
  const api = {
    emit(name) { calls.push(name); },
    destroy() { calls.push('core'); },
  };
  const lifecycle = createAppLifecycleSystem();

  lifecycle.register(api);
  lifecycle.register(api);
  api.destroy();

  assert.deepEqual(calls, ['app:destroy', 'core']);
});
