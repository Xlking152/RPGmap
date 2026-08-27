function text(value) {
  return String(value ?? '').trim();
}

function formatCoordinate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '?';
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '');
}

function formatNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(fallback);
  return Number.isInteger(number) ? String(number) : number.toFixed(1).replace(/\.0$/, '');
}

export function formatCanonicalTokenPlacement(token) {
  if (!token || typeof token !== 'object') return '未知';
  if (token.placement === 'map') {
    return `x ${formatCoordinate(token.x)} · y ${formatCoordinate(token.y)}`;
  }
  if (token.placement === 'feature' && token.featureId) {
    return `Feature ${text(token.featureId)}`;
  }
  return '未放置';
}

export function listCanonicalActorTokens(api, actorId) {
  if (!api?.tokens?.list) throw new Error('Canonical Entity Token reads require api.tokens.list()');
  const id = String(actorId ?? '');
  return api.tokens.list().filter(token => String(token?.actorId ?? '') === id);
}

export function readCanonicalEntityToken(api, tokenId) {
  if (!api?.tokens?.get || !api?.tokens?.resolveActor) {
    throw new Error('Canonical Entity Token reads require api.tokens.get()/resolveActor()');
  }
  const token = api.tokens.get(tokenId);
  if (!token) return null;
  const resolved = api.tokens.resolveActor(token.id);
  return Object.freeze({
    token,
    actor: resolved.actor,
    baseActor: resolved.baseActor,
    synthetic: resolved.synthetic === true,
    actorLink: resolved.actorLink !== false,
    placementLabel: formatCanonicalTokenPlacement(token),
  });
}

function tokenIdFromCard(card) {
  const carrier = card?.querySelector?.(
    '[data-token-diameter], [data-sheet-action="reposition-token"], [data-sheet-action="edit-token-elevation"]',
  );
  return text(carrier?.dataset?.tokenId || carrier?.dataset?.characterId || card?.dataset?.tokenId) || null;
}

function setText(node, value) {
  const next = String(value ?? '');
  if (node && node.textContent !== next) node.textContent = next;
}

function tokenSummary(read) {
  const { token, synthetic, placementLabel } = read;
  const parts = [
    `位置：${placementLabel}`,
    `高度：${formatNumber(token.elevationFt)} ft`,
    `旋转：${formatNumber(token.rotation)}°`,
    token.hidden === true ? '已隐藏' : '显示中',
    synthetic ? '独立实例' : 'Actor 联动',
  ];
  return parts.join(' · ');
}

function actorFormName(actor) {
  const forms = Array.isArray(actor?.forms) ? actor.forms : [];
  const form = forms.find(item => String(item?.id ?? '') === String(actor?.currentFormId ?? '')) || forms[0];
  return text(form?.name);
}

export function createEntityTokenReadUiSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.tokens?.list || !api?.tokens?.get || !api?.tokens?.resolveActor) {
        throw new Error('Entity Token Read V2 requires canonical Token Runtime V2');
      }

      const mapElement = api.map?.getContainer?.();
      const documentNode = mapElement?.ownerDocument || document;
      let destroyed = false;
      let syncQueued = false;
      const off = [];

      function scheduleSync() {
        if (destroyed || syncQueued) return;
        syncQueued = true;
        queueMicrotask(syncEditorReads);
      }

      function syncActorTokenCounts(tokens) {
        const counts = new Map();
        for (const token of tokens) {
          const actorId = String(token?.actorId ?? '');
          if (!actorId) continue;
          counts.set(actorId, (counts.get(actorId) || 0) + 1);
        }

        for (const card of documentNode.querySelectorAll?.('[data-entity-list] .entity-card[data-actor-id]') || []) {
          const actorId = String(card.dataset.actorId || '');
          const summary = card.querySelector('.entity-card-copy small');
          if (!actorId || !summary) continue;
          const count = counts.get(actorId) || 0;
          const current = String(summary.textContent || '');
          const separator = current.indexOf(' · ');
          const formLabel = separator >= 0 ? current.slice(0, separator) : current;
          setText(summary, `${formLabel} · ${count ? `${count} 个 Token` : '未放置'}`);
          summary.dataset.tokenCountSource = 'api.tokens.list';
        }
      }

      function syncTokenCards() {
        for (const card of documentNode.querySelectorAll?.('.entity-sheet .entity-card') || []) {
          const tokenId = tokenIdFromCard(card);
          if (!tokenId) continue;
          let read;
          try { read = readCanonicalEntityToken(api, tokenId); }
          catch (error) {
            console.warn('[RPGmap Entity Token Read V2] cannot resolve Token', tokenId, error);
            continue;
          }
          if (!read) {
            card.remove();
            continue;
          }

          const { token, actor, synthetic } = read;
          card.dataset.tokenId = String(token.id);
          card.dataset.tokenReadV2 = 'canonical';
          for (const carrier of card.querySelectorAll?.('[data-character-id], [data-token-id]') || []) {
            carrier.dataset.tokenId = String(token.id);
          }

          const heading = card.querySelector(':scope > strong');
          const formName = actorFormName(actor);
          setText(heading, `Token ${token.id} · ${actor?.name || 'Actor'}${formName ? ` / ${formName}` : ''}`);
          if (heading) {
            heading.dataset.actorSource = 'api.tokens.resolveActor';
            heading.title = synthetic
              ? 'Synthetic Actor：显示数据由 Base Actor + Token actorDelta 解析'
              : 'Linked Actor：显示数据来自 World Actor';
          }

          const summary = card.querySelector(':scope > small');
          setText(summary, tokenSummary(read));
          if (summary) summary.dataset.tokenPlacementSource = 'api.tokens.get';
        }
      }

      function syncEditorReads() {
        syncQueued = false;
        if (destroyed) return;
        const tokens = api.tokens.list();
        syncActorTokenCounts(tokens);
        syncTokenCards();
      }

      const observer = new MutationObserver(scheduleSync);
      observer.observe(documentNode.body, { childList: true, subtree: true });

      for (const eventName of [
        'state:commit', 'state:import', 'token:create', 'token:delete', 'token:move',
        'token:property-change', 'token:size-change', 'elevation:token-change',
        'status:change', 'multiplayer:capabilities',
      ]) off.push(api.on?.(eventName, scheduleSync));

      api.entityTokenReads = Object.freeze({
        canonicalSceneTokens: true,
        list() { return api.tokens.list(); },
        listForActor(actorId) { return listCanonicalActorTokens(api, actorId); },
        get(tokenId) { return api.tokens.get(tokenId); },
        resolveActor(tokenId) { return api.tokens.resolveActor(tokenId); },
        read(tokenId) { return readCanonicalEntityToken(api, tokenId); },
        sync: scheduleSync,
      });

      off.push(api.on?.('app:destroy', () => {
        destroyed = true;
        observer.disconnect();
        off.splice(0).forEach(dispose => dispose?.());
      }));

      scheduleSync();
      api.emit?.('entity-token-reads:ready', { canonicalSceneTokens: true });
    },
  });
}
