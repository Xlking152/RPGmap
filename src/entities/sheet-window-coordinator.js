import {
  actorSheetWindowKey,
  createActorSheetManager,
  tokenSheetWindowKey,
} from './sheet-manager.js';

function sheetKey(sheet) {
  if (!sheet) return '';
  const tokenId = String(sheet.dataset.tokenId || '').trim();
  if (tokenId) return tokenSheetWindowKey(tokenId);
  return actorSheetWindowKey(sheet.dataset.actorId);
}

function sheetTab(sheet) {
  return String(sheet?.querySelector?.('.entity-sheet-tab.active')?.dataset.sheetTab || '').trim() || null;
}

function sheetRect(sheet) {
  if (!sheet?.getBoundingClientRect) return null;
  const rect = sheet.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

export function createActorSheetWindowCoordinator({ api, documentNode, windowNode = documentNode?.defaultView } = {}) {
  if (!api || !documentNode) throw new Error('Actor Sheet window coordinator requires api and document');
  const worldId = String(api.world?.get?.()?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const manager = createActorSheetManager({
    storage: windowNode?.localStorage || null,
    storageKey: `rpgmap.ui.actor-sheets.v1.${worldId}`,
    baseZIndex: 4210,
  });
  const entityApi = api.entities;
  const originalOpenActor = entityApi?.openActor?.bind(entityApi);
  const originalOpenToken = entityApi?.openToken?.bind(entityApi);
  if (!originalOpenActor || !originalOpenToken) throw new Error('Actor Sheet coordinator requires Entity open APIs');

  let destroyed = false;
  let promoting = false;
  let scheduled = false;
  const staticSelector = '.entity-sheet-backdrop[data-sheet-manager-static="true"]';

  function backdrops() {
    return [...documentNode.querySelectorAll('.entity-sheet-backdrop')];
  }

  function liveBackdrop() {
    return backdrops().find(node => node.dataset.sheetManagerStatic !== 'true') || null;
  }

  function backdropForKey(key) {
    return backdrops().find(node => node.dataset.sheetWindowKey === key) || null;
  }

  function sheetForBackdrop(backdrop) {
    return backdrop?.querySelector?.('.entity-sheet') || null;
  }

  function markBackdrop(backdrop, record, { staticWindow = false } = {}) {
    if (!backdrop || !record) return;
    backdrop.dataset.sheetWindowKey = record.key;
    if (staticWindow) backdrop.dataset.sheetManagerStatic = 'true';
    else delete backdrop.dataset.sheetManagerStatic;
    backdrop.style.zIndex = String(record.zIndex);
    const sheet = sheetForBackdrop(backdrop);
    if (!sheet) return;
    sheet.dataset.sheetWindowKey = record.key;
    sheet.setAttribute('aria-modal', 'false');
  }

  function applyGeometry(backdrop, record) {
    const sheet = sheetForBackdrop(backdrop);
    if (!sheet || !record) return;
    if (record.left != null) sheet.style.left = `${Math.round(record.left)}px`;
    if (record.top != null) sheet.style.top = `${Math.round(record.top)}px`;
    if (record.width != null) sheet.style.width = `${Math.round(record.width)}px`;
    if (record.height != null) sheet.style.height = `${Math.round(record.height)}px`;
    backdrop.style.zIndex = String(record.zIndex);
  }

  function captureBackdrop(backdrop) {
    const sheet = sheetForBackdrop(backdrop);
    const key = backdrop?.dataset.sheetWindowKey || sheetKey(sheet);
    const record = manager.get(key);
    if (!record || !sheet) return record;
    const rect = sheetRect(sheet);
    if (rect) manager.capture(key, rect);
    const tab = sheetTab(sheet);
    if (tab) manager.update(key, { tab });
    return manager.get(key);
  }

  function refreshZOrder() {
    for (const record of manager.list()) {
      const backdrop = backdropForKey(record.key);
      if (backdrop) backdrop.style.zIndex = String(record.zIndex);
    }
  }

  function focusKey(key) {
    const record = manager.activate(key);
    if (!record) return null;
    const backdrop = backdropForKey(record.key);
    if (backdrop) backdrop.style.zIndex = String(record.zIndex);
    refreshZOrder();
    return record;
  }

  function removeStatic(key) {
    for (const node of documentNode.querySelectorAll(staticSelector)) {
      if (node.dataset.sheetWindowKey === key) node.remove();
    }
  }

  function archiveLive() {
    const live = liveBackdrop();
    const sheet = sheetForBackdrop(live);
    if (!live || !sheet) return null;
    const key = live.dataset.sheetWindowKey || sheetKey(sheet);
    const record = manager.get(key);
    if (!record) return null;
    captureBackdrop(live);
    removeStatic(key);
    const clone = live.cloneNode(true);
    markBackdrop(clone, manager.get(key), { staticWindow: true });
    documentNode.body.append(clone);
    return clone;
  }

  function ensureLiveTarget() {
    const live = liveBackdrop();
    if (live) return live;
    const placeholder = documentNode.createElement('div');
    placeholder.className = 'entity-sheet-backdrop';
    placeholder.dataset.sheetManagerPlaceholder = 'true';
    const firstStatic = documentNode.querySelector(staticSelector);
    if (firstStatic) documentNode.body.insertBefore(placeholder, firstStatic);
    else documentNode.body.append(placeholder);
    return placeholder;
  }

  function currentRecordFromDom() {
    const live = liveBackdrop();
    const sheet = sheetForBackdrop(live);
    if (!sheet) return null;
    const key = sheetKey(sheet);
    if (!key) return null;
    let record = manager.get(key);
    if (!record) {
      const tokenId = String(sheet.dataset.tokenId || '').trim() || null;
      record = manager.open({ actorId: sheet.dataset.actorId, tokenId, tab: sheetTab(sheet) }).record;
    }
    if (!record) return null;
    markBackdrop(live, record);
    applyGeometry(live, record);
    return record;
  }

  function finishOpen(record) {
    const live = liveBackdrop();
    if (!live || !record) return;
    markBackdrop(live, record);
    applyGeometry(live, record);
    refreshZOrder();
  }

  function openActor(actorId, tab = null) {
    const key = actorSheetWindowKey(actorId);
    if (!key) return false;
    const existingBackdrop = backdropForKey(key);
    if (existingBackdrop) {
      captureBackdrop(existingBackdrop);
      const record = manager.open({ actorId, tab }).record;
      if (existingBackdrop.dataset.sheetManagerStatic === 'true') return promote(key, tab);
      if (tab && tab !== sheetTab(sheetForBackdrop(existingBackdrop))) {
        promoting = true;
        try {
          const result = originalOpenActor(actorId, tab);
          finishOpen(record);
          return result;
        } finally { promoting = false; }
      }
      finishOpen(record);
      return true;
    }

    if (liveBackdrop()) archiveLive();
    ensureLiveTarget();
    const record = manager.open({ actorId, tab }).record;
    promoting = true;
    try {
      const result = originalOpenActor(actorId, tab || record?.tab);
      if (!result) { manager.close(record?.key); return false; }
      finishOpen(record);
      return true;
    } finally { promoting = false; }
  }

  function openToken(tokenId, tab = null) {
    const token = api.tokens?.get?.(tokenId);
    if (!token) return false;
    const key = tokenSheetWindowKey(token.id);
    const existingBackdrop = backdropForKey(key);
    if (existingBackdrop) {
      captureBackdrop(existingBackdrop);
      const record = manager.open({ actorId: token.actorId, tokenId: token.id, tab }).record;
      if (existingBackdrop.dataset.sheetManagerStatic === 'true') return promote(key, tab);
      if (tab && tab !== sheetTab(sheetForBackdrop(existingBackdrop))) {
        promoting = true;
        try {
          const result = originalOpenToken(token.id, tab);
          finishOpen(record);
          return result;
        } finally { promoting = false; }
      }
      finishOpen(record);
      return true;
    }

    if (liveBackdrop()) archiveLive();
    ensureLiveTarget();
    const record = manager.open({ actorId: token.actorId, tokenId: token.id, tab }).record;
    promoting = true;
    try {
      const result = originalOpenToken(token.id, tab || record?.tab);
      if (!result) { manager.close(record?.key); return false; }
      finishOpen(record);
      return true;
    } finally { promoting = false; }
  }

  function promote(key, preferredTab = null) {
    if (promoting) return true;
    const record = manager.get(key);
    if (!record) return false;
    const target = backdropForKey(key);
    if (target) captureBackdrop(target);
    const current = liveBackdrop();
    if (current && current !== target) archiveLive();
    removeStatic(key);
    ensureLiveTarget();
    const next = manager.open({
      actorId: record.actorId,
      tokenId: record.tokenId,
      tab: preferredTab || manager.get(key)?.tab,
    }).record;
    promoting = true;
    try {
      const result = next.tokenId
        ? originalOpenToken(next.tokenId, next.tab)
        : originalOpenActor(next.actorId, next.tab);
      if (!result) return false;
      finishOpen(next);
      return true;
    } finally { promoting = false; }
  }

  function promoteFallback() {
    if (liveBackdrop() || !manager.size()) return;
    const record = manager.active() || manager.list().at(-1);
    if (record) promote(record.key);
  }

  function reconcile() {
    scheduled = false;
    if (destroyed || promoting) return;
    const live = liveBackdrop();
    if (live?.dataset.sheetManagerPlaceholder === 'true' && !sheetForBackdrop(live)) return;
    if (live) {
      const record = currentRecordFromDom();
      if (record) focusKey(record.key);
    } else promoteFallback();
  }

  function scheduleReconcile() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(reconcile);
  }

  function activateEventSheet(event) {
    const sheet = event.target?.closest?.('.entity-sheet');
    if (!sheet) return null;
    const key = sheet.dataset.sheetWindowKey || sheetKey(sheet);
    if (!key) return null;
    const record = manager.get(key);
    if (!record) return null;
    const backdrop = sheet.closest('.entity-sheet-backdrop');
    if (backdrop?.dataset.sheetManagerStatic === 'true') {
      promote(key, sheetTab(sheet));
      return manager.get(key);
    }
    focusKey(key);
    return manager.get(key);
  }

  function handlePointerDown(event) {
    const sheet = event.target?.closest?.('.entity-sheet');
    if (!sheet) return;
    const backdrop = sheet.closest('.entity-sheet-backdrop');
    if (backdrop?.dataset.sheetManagerStatic === 'true') {
      activateEventSheet(event);
      if (event.target.closest?.('.entity-sheet-header') && !event.target.closest?.('input,button,select,textarea,a')) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    activateEventSheet(event);
  }

  function handleClickCapture(event) {
    const panelOpen = event.target?.closest?.('[data-entity-action="open"]');
    if (panelOpen) {
      const actorId = panelOpen.dataset.id;
      if (actorId) {
        event.preventDefault();
        event.stopPropagation();
        openActor(actorId);
        return;
      }
    }
    activateEventSheet(event);
    const tab = event.target?.closest?.('[data-sheet-tab]');
    if (tab) {
      const key = tab.closest('.entity-sheet')?.dataset.sheetWindowKey;
      if (key) manager.update(key, { tab: tab.dataset.sheetTab });
    }
    if (event.target?.closest?.('[data-sheet-action="close"]')) {
      const sheet = event.target.closest('.entity-sheet');
      const key = sheet?.dataset.sheetWindowKey || sheetKey(sheet);
      queueMicrotask(() => {
        if (!documentNode.querySelector(`.entity-sheet[data-sheet-window-key="${key.replace(/["\\]/g, '\\$&')}"]`)) manager.close(key);
        promoteFallback();
      });
    }
  }

  function handleGeometryEnd(event) {
    const sheet = event.target?.closest?.('.entity-sheet') || sheetForBackdrop(liveBackdrop());
    const key = sheet?.dataset.sheetWindowKey || sheetKey(sheet);
    const record = manager.get(key);
    const rect = sheetRect(sheet);
    if (record && rect) manager.capture(key, rect);
  }

  function handlePotentialDirectOpen(event) {
    if (event.target?.matches?.('input[type="file"][accept*="spreadsheetml"]')) archiveLive();
  }

  documentNode.addEventListener('pointerdown', handlePointerDown, true);
  documentNode.addEventListener('click', handleClickCapture, true);
  documentNode.addEventListener('focusin', activateEventSheet, true);
  documentNode.addEventListener('change', activateEventSheet, true);
  documentNode.addEventListener('submit', activateEventSheet, true);
  documentNode.addEventListener('pointerup', handleGeometryEnd, true);
  documentNode.addEventListener('change', handlePotentialDirectOpen, true);
  const Observer = windowNode?.MutationObserver || globalThis.MutationObserver;
  const observer = Observer ? new Observer(scheduleReconcile) : null;
  observer?.observe(documentNode.body, { childList: true, subtree: true });

  api.entities = Object.freeze({
    ...entityApi,
    openActor,
    openToken,
    sheetManager: manager,
  });

  api.on?.('token:delete', event => {
    const tokenId = String(event.detail?.tokenId || event.detail?.id || '').trim();
    const key = tokenSheetWindowKey(tokenId);
    if (!key || !manager.get(key)) return;
    backdropForKey(key)?.remove();
    manager.close(key);
    scheduleReconcile();
  });
  api.on?.('app:destroy', () => {
    destroyed = true;
    observer?.disconnect();
    documentNode.removeEventListener('pointerdown', handlePointerDown, true);
    documentNode.removeEventListener('click', handleClickCapture, true);
    documentNode.removeEventListener('focusin', activateEventSheet, true);
    documentNode.removeEventListener('change', activateEventSheet, true);
    documentNode.removeEventListener('submit', activateEventSheet, true);
    documentNode.removeEventListener('pointerup', handleGeometryEnd, true);
    documentNode.removeEventListener('change', handlePotentialDirectOpen, true);
  });

  return manager;
}
