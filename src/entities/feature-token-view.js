function id(value) {
  return String(value ?? '').trim();
}

export function listFeatureTokenViews(api, featureId) {
  if (!api?.tokens?.list || !api?.tokens?.resolveActor) {
    throw new Error('Feature Token views require api.tokens.list()/resolveActor()');
  }
  const target = id(featureId);
  return api.tokens.list()
    .filter(token => token?.placement === 'feature' && id(token.featureId) === target)
    .flatMap(token => {
      let resolved;
      try { resolved = api.tokens.resolveActor(token.id); }
      catch { return []; }
      const actor = resolved?.actor;
      if (!actor) return [];
      const presentation = describeActor(actor) || {};
      return [{
        token,
        actor,
        baseActor: resolved.baseActor,
        synthetic: resolved.synthetic === true,
        name: String(presentation.name || actor.name || `Token ${token.id}`),
        avatarDataUrl: presentation.avatarDataUrl || actor.img || null,
        color: presentation.color || '#3d9b63',
      }];
    });
}
import { describeActor } from '../actor/index.js';
