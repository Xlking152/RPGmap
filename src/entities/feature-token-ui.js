import { listFeatureTokenViews } from './feature-token-view.js';

function id(value) {
  return String(value ?? '').trim();
}

function setPortrait(documentNode, button, view) {
  const portrait = documentNode.createElement('span');
  portrait.className = 'character-portrait small';
  portrait.style.setProperty('--character-color', view.color || '#3d9b63');
  if (view.avatarDataUrl) {
    const image = documentNode.createElement('img');
    image.src = view.avatarDataUrl;
    image.alt = '';
    portrait.append(image);
  } else {
    portrait.textContent = (String(view.name || '?').trim()[0] || '?').toUpperCase();
  }
  const name = documentNode.createElement('span');
  name.textContent = view.name;
  button.append(portrait, name);
}

export function createFeatureTokenUiSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.list || !api?.tokens?.resolveActor) {
        throw new Error('Feature Token UI V2 requires canonical Token Runtime V2');
      }
      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || document;
      const shell = mapElement?.closest?.('.app-shell') || documentNode;
      const panel = shell.querySelector?.('[data-panel="inspect"]');
      if (!panel) return;

      let destroyed = false;
      let syncQueued = false;
      const off = [];

      function scheduleSync() {
        if (destroyed || syncQueued) return;
        syncQueued = true;
        queueMicrotask(syncOccupants);
      }

      function selectedFeatureId() {
        const action = panel.querySelector?.('[data-action="focus-feature"][data-id]');
        return id(action?.dataset?.id) || null;
      }

      function syncOccupants() {
        syncQueued = false;
        if (destroyed) return;
        const section = panel.querySelector?.('.building-occupants');
        const featureId = selectedFeatureId();
        if (!section || !featureId) return;

        const views = listFeatureTokenViews(api, featureId);
        const signature = JSON.stringify(views.map(view => [
          view.token.id,
          view.actor?.id,
          view.name,
          view.avatarDataUrl,
          view.color,
          view.synthetic,
        ]));
        if (section.dataset.tokenViewSignature === signature) return;

        section.replaceChildren();
        section.dataset.tokenViewSignature = signature;
        section.dataset.occupantSource = 'api.tokens.list+resolveActor';
        const heading = documentNode.createElement('h3');
        heading.textContent = `内部 Token · ${views.length}`;
        section.append(heading);
        if (!views.length) {
          const empty = documentNode.createElement('div');
          empty.className = 'empty-state compact';
          empty.textContent = '当前无人';
          section.append(empty);
          return;
        }

        for (const view of views) {
          const button = documentNode.createElement('button');
          button.type = 'button';
          button.className = 'occupant-button';
          button.dataset.action = 'select-character';
          button.dataset.id = String(view.token.id);
          button.dataset.tokenId = String(view.token.id);
          button.dataset.actorId = String(view.actor?.id || view.token.actorId || '');
          button.dataset.actorSource = 'api.tokens.resolveActor';
          button.dataset.tokenSource = 'api.tokens.list';
          button.title = view.synthetic ? 'Synthetic Actor Token' : 'Linked Actor Token';
          setPortrait(documentNode, button, view);
          section.append(button);
        }
      }

      function captureOccupantSelection(event) {
        const button = event.target?.closest?.('.building-occupants [data-token-id]');
        if (!button) return;
        const tokenId = id(button.dataset.tokenId);
        if (!tokenId || !api.tokens.get?.(tokenId)) return;
        api.selection?.replace?.([tokenId], tokenId);
      }

      panel.addEventListener('click', captureOccupantSelection, true);
      const observer = new MutationObserver(scheduleSync);
      observer.observe(panel, { childList: true, subtree: true });
      for (const eventName of [
        'state:commit', 'state:import', 'feature:select', 'token:create', 'token:delete',
        'token:move', 'token:property-change', 'status:change',
      ]) off.push(api.on?.(eventName, scheduleSync));

      api.featureTokenViews = Object.freeze({
        canonicalSceneTokens: true,
        list(featureId) { return listFeatureTokenViews(api, featureId); },
        sync: scheduleSync,
      });

      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        observer.disconnect();
        panel.removeEventListener('click', captureOccupantSelection, true);
        off.splice(0).forEach(dispose => dispose?.());
      }));

      scheduleSync();
      api.emit?.('feature-token-views:ready', { canonicalSceneTokens: true });
    },
  });
}
