import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorFromRulesetImport, normalizeActorDocument } from '../src/actor/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { createTokenViewModel } from '../src/render/token-view-model.js';

function importedCard() {
  return {
    formName: '默认形态',
    identity: { name: '角色A' },
    avatarDataUrl: 'data:image/png;base64,FORM',
    tokenAppearance: { color: '#224466', scale: 1 },
    resources: { hp: { max: 10 } },
    attributes: [], checks: { skills: [], saves: [] }, badStatuses: [],
    combat: { attacks: [], defenses: [] }, source: { type: 'manual' },
  };
}

test('Core Actor normalization owns img and prototypeToken as canonical fields', () => {
  const actor = normalizeActorDocument({
    id: 'actor-a', name: 'A', img: 'actor.png',
    prototypeToken: { texture: { src: 'proto.png' }, color: '#112233', diameterMeters: 2, showName: false },
    system: infiniteHorrorRuleset.actor.createDefault({ name: 'A' }).system,
  }, { ruleset: infiniteHorrorRuleset });
  assert.equal(actor.img, 'actor.png');
  assert.equal(actor.prototypeToken.texture.src, 'proto.png');
  assert.equal(actor.prototypeToken.color, '#112233');
  assert.equal(actor.prototypeToken.diameterMeters, 2);
  assert.equal(actor.prototypeToken.showName, false);
});

test('Infinite Horror import seeds Core Actor defaults while keeping Form presentation override', () => {
  const actor = createActorFromRulesetImport(importedCard(), { id: 'actor-a', ruleset: infiniteHorrorRuleset });
  assert.equal(actor.img, 'data:image/png;base64,FORM');
  assert.equal(actor.prototypeToken.texture.src, 'data:image/png;base64,FORM');
  assert.equal(actor.prototypeToken.color, '#224466');
});

test('Token appearance precedence is explicit Token override then Form then Core Actor fallback', () => {
  const actor = createActorFromRulesetImport(importedCard(), { id: 'actor-a', ruleset: infiniteHorrorRuleset });
  actor.img = 'core.png';
  actor.prototypeToken.texture.src = 'prototype.png';
  actor.prototypeToken.color = '#113355';
  const baseToken = {
    id: 'token-a', actorId: 'actor-a', placement: 'map', x: 1, y: 2,
    diameterMeters: 1, rotation: 0, elevationFt: 0, showName: true, hidden: false,
  };
  const formModel = createTokenViewModel({ token: baseToken, actor, ruleset: infiniteHorrorRuleset });
  assert.equal(formModel.avatarDataUrl, 'data:image/png;base64,FORM');
  assert.equal(formModel.color, '#224466');

  const tokenModel = createTokenViewModel({
    token: { ...baseToken, texture: { src: 'token.png' }, color: '#abcdef' },
    actor,
    ruleset: infiniteHorrorRuleset,
  });
  assert.equal(tokenModel.avatarDataUrl, 'token.png');
  assert.equal(tokenModel.color, '#abcdef');
});
