import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mergeActorDelta } from '../src/token/actor.js';
import { createTokenViewModel } from '../src/render/token-view-model.js';

function actor() {
  return {
    id: 'actor-template',
    name: '模板士兵',
    currentFormId: 'form-a',
    forms: [{
      id: 'form-a',
      avatarDataUrl: 'data:image/webp;base64,BASE',
      tokenAppearance: { color: '#336699' },
    }],
  };
}

function token(overrides = {}) {
  return {
    id: 'token-instance',
    actorId: 'actor-template',
    actorLink: true,
    actorDelta: null,
    placement: 'map',
    x: 12.5,
    y: 18.5,
    diameterMeters: 5,
    hidden: false,
    showName: true,
    ...overrides,
  };
}

test('Token renderer view model uses canonical Token placement and resolved Actor display data', () => {
  const model = createTokenViewModel({ token: token(), actor: actor(), selected: true });
  assert.deepEqual({ id: model.id, x: model.x, y: model.y, diameterMeters: model.diameterMeters }, {
    id: 'token-instance', x: 12.5, y: 18.5, diameterMeters: 5,
  });
  assert.equal(model.name, '模板士兵');
  assert.equal(model.avatarDataUrl, 'data:image/webp;base64,BASE');
  assert.equal(model.color, '#336699');
  assert.equal(model.selected, true);
});

test('Token renderer displays Synthetic Actor instance overrides without mutating the template', () => {
  const base = actor();
  const synthetic = mergeActorDelta(base, {
    name: '士兵 A-17',
    forms: [{
      id: 'form-a',
      avatarDataUrl: 'data:image/webp;base64,INSTANCE',
      tokenAppearance: { color: '#884422' },
    }],
  });
  const model = createTokenViewModel({ token: token({ actorLink: false, actorDelta: { name: '士兵 A-17' } }), actor: synthetic });
  assert.equal(model.name, '士兵 A-17');
  assert.equal(model.avatarDataUrl, 'data:image/webp;base64,INSTANCE');
  assert.equal(model.color, '#884422');
  assert.equal(base.name, '模板士兵');
  assert.equal(base.forms[0].avatarDataUrl, 'data:image/webp;base64,BASE');
});

test('hidden or Feature-placed Tokens have no map view model', () => {
  assert.equal(createTokenViewModel({ token: token({ hidden: true }), actor: actor() }), null);
  assert.equal(createTokenViewModel({
    token: token({ placement: 'feature', x: null, y: null, featureId: 'building-1' }),
    actor: actor(),
  }), null);
});

test('canonical map Token and health overlay sources do not read compatibility projections', async () => {
  const rendererPath = fileURLToPath(new URL('../src/render/token-layer.js', import.meta.url));
  const healthPath = fileURLToPath(new URL('../src/health/token-bars.js', import.meta.url));
  const renderer = await readFile(rendererPath, 'utf8');
  const health = await readFile(healthPath, 'utf8');
  for (const source of [renderer, health]) {
    assert.match(source, /api\.tokens\.list\(\)/);
    assert.doesNotMatch(source, /state\.characters|preferences\.entitySystem/);
  }
  assert.match(renderer, /api\.tokens\.resolveActor/);
});
