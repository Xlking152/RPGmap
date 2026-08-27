function id(value) {
  return String(value ?? '').trim();
}

function currentForm(actor) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  return forms.find(form => String(form?.id ?? '') === String(actor?.currentFormId ?? '')) || forms[0] || null;
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
      const form = currentForm(actor);
      return [{
        token,
        actor,
        baseActor: resolved.baseActor,
        synthetic: resolved.synthetic === true,
        name: String(actor.name || `Token ${token.id}`),
        avatarDataUrl: form?.avatarDataUrl || actor.img || null,
        color: form?.tokenAppearance?.color || '#3d9b63',
      }];
    });
}
