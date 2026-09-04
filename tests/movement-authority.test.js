import test from 'node:test';
import assert from 'node:assert/strict';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { validateAuthoritativeTokenMovePath } from '../src/server/movement-authority-entry.js';

function context(overrides = {}) {
  const mapPackage = createMinimalReferencePackage();
  const token = {
    id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
    placement: 'map', x: 700, y: 430, diameterMeters: 1,
    elevationFt: 0, locked: false,
    ...overrides,
  };
  const scene = {
    id: 'scene-a', mapPackage: { id: mapPackage.id, version: mapPackage.version },
    tokens: [token], featureStates: {}, sceneEvents: [],
  };
  return {
    state: { preferences: { worldV2: { activeSceneId: scene.id, scenes: [scene] } } },
    scene, token, origin: { x: token.x, y: token.y }, capabilities: { canMove: true },
  };
}

test('server movement authority accepts a clear path on a built-in map', () => {
  const result = validateAuthoritativeTokenMovePath({
    ...context(), waypoints: [{ x: 740, y: 430 }],
  });
  assert.equal(result.valid, true);
  assert.equal(result.collisionValidation, 'server');
});

test('server movement authority rejects locked and status-blocked Tokens', () => {
  const locked = context({ locked: true });
  assert.equal(validateAuthoritativeTokenMovePath({ ...locked, waypoints: [{ x: 740, y: 430 }] }).code, 'token_locked');
  const status = context();
  assert.equal(validateAuthoritativeTokenMovePath({
    ...status, capabilities: { canMove: false, reasons: ['Immobilized'] }, waypoints: [{ x: 740, y: 430 }],
  }).code, 'status_movement_forbidden');
});

test('server movement authority validates every segment and rejects collision', () => {
  const start = context();
  const result = validateAuthoritativeTokenMovePath({
    ...start,
    origin: { x: 500, y: 430 },
    waypoints: [{ x: 500, y: 470 }],
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'path_blocked');
  assert.equal(result.segmentIndex, 0);
});

test('unknown external MapPackages use the explicit bounds-only fallback', () => {
  const value = context();
  value.scene.mapPackage = { id: 'external-map', version: '9.9.9' };
  assert.deepEqual(validateAuthoritativeTokenMovePath({
    ...value, waypoints: [{ x: 9999, y: 9999 }],
  }), { valid: true, collisionValidation: 'bounds-only' });
});
