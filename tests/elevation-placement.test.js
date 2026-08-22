import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GROUND_PLACEMENT_MOVER_CONTEXT,
  createPlacementContextGuard,
  getActiveMoverContext,
  resetElevationNavigationRuntime,
  setActiveMoverContext,
} from '../src/elevation/index.js';

function fakePlacementRuntime() {
  let clickCapture = null;
  const shell = {
    addEventListener(type, listener, capture) {
      if (type === 'click' && capture === true) clickCapture = listener;
    },
    removeEventListener() {},
  };
  const mapElement = {
    closest(selector) { return selector === '.app-shell' ? shell : null; },
  };
  const api = {
    map: { getContainer() { return mapElement; } },
    on() { return () => {}; },
  };
  return {
    api,
    click(target) {
      assert.ok(clickCapture, 'placement guard must register a capture listener');
      clickCapture({ target });
    },
  };
}

test('legacy Place Character UI resets Navigation mover context to a 0 ft ground token before placement', () => {
  const runtime = fakePlacementRuntime();
  createPlacementContextGuard().register(runtime.api);

  setActiveMoverContext({ characterId: 'high-token', elevationFt: 80 });
  runtime.click({
    closest(selector) {
      return selector === '[data-action="place-character"]' ? { dataset: { action: 'place-character' } } : null;
    },
  });

  assert.deepEqual(getActiveMoverContext(), GROUND_PLACEMENT_MOVER_CONTEXT);
  resetElevationNavigationRuntime();
});

test('unrelated shell clicks do not change the active mover context', () => {
  const runtime = fakePlacementRuntime();
  createPlacementContextGuard().register(runtime.api);

  setActiveMoverContext({ characterId: 'flyer', elevationFt: 45 });
  runtime.click({ closest() { return null; } });
  assert.deepEqual(getActiveMoverContext(), { characterId: 'flyer', elevationFt: 45 });
  resetElevationNavigationRuntime();
});
