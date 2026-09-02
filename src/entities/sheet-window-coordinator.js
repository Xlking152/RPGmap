import { actorSheetWindowKey, createActorSheetManager, tokenSheetWindowKey } from './sheet-manager.js';

function sheetKey(sheet) {
  if (!sheet) return '';
  const tokenId = String(sheet.dataset.tokenId || '').trim();
  return tokenId ? tokenSheetWindowKey(tokenId) : actorSheetWindowKey(sheet.dataset.actorId);
}

function sheetTab(sheet) {
  return String(sheet?.querySelector?.('.entity-sheet-tab.active')?.dataset.sheetTab || '').trim() || null;
}

export function createActorSheetWindowCoordinator({ api, documentNode, windowNode = documentNode?.defaultView } = {}) {
  if (!api || !documentNode) throw new Error('Actor Sheet window coordinator requires api and document');
  const worldId = String(api.world?.get?.()?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const manager = createActorSheetManager({
    storage: windowNode?.localStorage || null,
    storageKey: `rpgmap.ui.actor-sheets.v1.${worldId}`,
  });
  const entityApi = api.entities;
  const originalOpenActor = entityApi?.openActor?.bind(entityApi);
  const originalOpenToken = entityApi?.openToken?.bind(entityApi);
  if (!originalOpenActor || !originalOpenToken) throw new Error('Actor Sheet coordinator requires Entity open APIs');

  let destroyed = false;
  let promoting = false;
  let scheduled = false;
  const staticSelector = '.entity-sheet-backdrop[data-sheet-manager-static="true"]';
  const backdrops = () => [...documentNode.querySelectorAll('.entity-sheet-backdrop')];
  const liveBackdrop = () => backdrops().find(node => node.dataset.sheetManagerStatic !== 'true') || null;
  const backdropForKey = key => backdrops().find(node => node.dataset.sheetWindowKey === key) || null;
  const sheetForBackdrop = backdrop => backdrop?.querySelector?.('.entity-sheet') || null;

  function markBackdrop(backdrop, record, staticWindow = false) {
    if (!backdrop || !record) return;
    backdrop.dataset.sheetWindowKey = record.key;
    if (staticWindow) backdrop.dataset.sheetManagerStatic = 'true';
    else delete backdrop.dataset.sheetManagerStatic;
    backdrop.style.zIndex = String(record.zIndex);
    const sheet = sheetForBackdrop(backdrop);
    if (sheet) sheet.dataset.sheetWindowKey = record.key;
  }

  function applyGeometry(backdrop, record) {
    const sheet = sheetForBackdrop(backdrop);
    if (!sheet || !record) return;
    for (const field of ['left', 'top', 'width', 'height']) {
      if (record[field] != null) sheet.style[field] = `${Math.round(record[field])}px`;
    }
    backdrop.style.zIndex = String(record.zIndex);
  }

  function captureBackdrop(backdrop) {
    const sheet = sheetForBackdrop(backdrop);
    const key = backdrop?.dataset.sheetWindowKey || sheetKey(sheet);
    const record = manager.get(key);
    if (!record || !sheet) return record;
    manager.capture(key, sheet.getBoundingClientRect());
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
    const record = manager.get(live?.dataset.sheetWindowKey || sheetKey(sheet));
    if (!live || !sheet || !record) return null;
    captureBackdrop(live);
    removeStatic(record.key);
    const clone = live.cloneNode(true);
    markBackdrop(clone, manager.get(record.key), true);
    documentNode.body.append(clone);
    return clone;
  }

  function ensureLiveTarget() {
    if (liveBackdrop()) return;
    const placeholder = documentNode.createElement('div');
    placeholder.className = 'entity-sheet-backdrop';
    placeholder.dataset.sheetManagerPlaceholder = 'true';
    const firstStatic = documentNode.querySelector(staticSelector);
    if (firstStatic) documentNode.body.insertBefore(placeholder, firstStatic);
    else documentNode.body.append(placeholder);
  }

  function finishOpen(record) {
    const live = liveBackdrop();
    if (!live || !record) return;
    markBackdrop(live, record);
    applyGeometry(live, record);
    refreshZOrder();
  }

  function renderRecord(record, tab = record?.tab) {
    if (!record) return false;
    promoting = true;
    try {
      const result = record.tokenId
        ? originalOpenToken(record.tokenId, tab)
        : originalOpenActor(record.actorId, tab);
      if (!result) return false;
      finishOpen(record);
      return true;
    } finally { promoting = false; }
  }

  function managedOpen(actorId, tokenId = null, tab = null) {
    const key = tokenId ? tokenSheetWindowKey(tokenId) : actorSheetWindowKey(actorId);
    if (!key) return false;
    const existing = backdropForKey(key);
    if (existing) {
      captureBackdrop(existing);
      const record = manager.open({ actorId, tokenId, tab }).record;
      if (existing.dataset.sheetManagerStatic === 'true') return promote(key, tab);
      if (tab && tab !== sheetTab(sheetForBackdrop(existing))) return renderRecord(record, tab);
      finishOpen(record);
      return true;
    }
    if (liveBackdrop()) archiveLive();
    ensureLiveTarget();
    const record = manager.open({ actorId, tokenId, tab }).record;
    if (renderRecord(record, tab || record?.tab)) return true;
    manager.close(record?.key);
    return false;
  }

  function openActor(actorId, tab = null) {
    return managedOpen(String(actorId || '').trim(), null, tab);
  }

  function openToken(tokenId, tab = null) {
    const token = api.tokens?.get?.(tokenId);
    return token ? managedOpen(token.actorId, token.id, tab) : false;
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
    const next = manager.open({ actorId: record.actorId, tokenId: record.tokenId, tab: preferredTab || record.tab }).record;
    return renderRecord(next);
  }

  function promoteFallback() {
    if (liveBackdrop() || !manager.size()) return;
    const record = manager.list().at(-1);
    if (record) promote(record.key);
  }

  function reconcile() {
    scheduled = false;
    if (destroyed || promoting) return;
    const live = liveBackdrop();
    const sheet = sheetForBackdrop(live);
    if (live?.dataset.sheetManagerPlaceholder === 'true' && !sheet) return;
    if (!sheet) return promoteFallback();
    const key = sheetKey(sheet);
    if (!key) return;
    let record = manager.get(key);
    if (!record) {
      const tokenId = String(sheet.dataset.tokenId || '').trim() || null;
      record = manager.open({ actorId: sheet.dataset.actorId, tokenId, tab: sheetTab(sheet) }).record;
    }
    markBackdrop(live, record);
    applyGeometry(live, record);
    focusKey(record.key);
  }

  function scheduleReconcile() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(reconcile);
  }

  function activateEventSheet(event) {
    const sheet = event.target?.closest?.('.entity-sheet');
    const key = sheet?.dataset.sheetWindowKey || sheetKey(sheet);
    const record = manager.get(key);
    if (!record) return null;
    if (sheet.closest('.entity-sheet-backdrop')?.dataset.sheetManagerStatic === 'true') {
      promote(key, sheetTab(sheet));
      return manager.get(key);
    }
    return focusKey(key);
  }

  function handlePointerDown(event) {
    const sheet = event.target?.closest?.('.entity-sheet');
    if (!sheet) return;
    const staticWindow = sheet.closest('.entity-sheet-backdrop')?.dataset.sheetManagerStatic === 'true';
    activateEventSheet(event);
    if (staticWindow && event.target.closest?.('.entity-sheet-header') && !event.target.closest?.('input,button,select,textarea,a')) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  function handleClickCapture(event) {
    const panelOpen = event.target?.closest?.('[data-entity-action="open"]');
    if (panelOpen?.dataset.id) {
      event.preventDefault();
      event.stopPropagation();
      openActor(panelOpen.dataset.id);
      return;
    }
    activateEventSheet(event);
    const tab = event.target?.closest?.('[data-sheet-tab]');
    const tabKey = tab?.closest('.entity-sheet')?.dataset.sheetWindowKey;
    if (tabKey) manager.update(tabKey, { tab: tab.dataset.sheetTab });
    if (event.target?.closest?.('[data-sheet-action="close"]')) {
      const sheet = event.target.closest('.entity-sheet');
      const key = sheet?.dataset.sheetWindowKey || sheetKey(sheet);
      queueMicrotask(() => {
        if (![...documentNode.querySelectorAll('.entity-sheet')].some(node => node.dataset.sheetWindowKey === key)) manager.close(key);
        promoteFallback();
      });
    }
  }

  function handleGeometryEnd(event) {
    const sheet = event.target?.closest?.('.entity-sheet') || sheetForBackdrop(liveBackdrop());
    const record = manager.get(sheet?.dataset.sheetWindowKey || sheetKey(sheet));
    if (record && sheet) manager.capture(record.key, sheet.getBoundingClientRect());
  }

  documentNode.addEventListener('pointerdown', handlePointerDown, true);
  documentNode.addEventListener('click', handleClickCapture, true);
  documentNode.addEventListener('focusin', activateEventSheet, true);
  documentNode.addEventListener('pointerup', handleGeometryEnd, true);
  documentNode.addEventListener('change', event => {
    if (event.target?.matches?.('input[type="file"][accept*="spreadsheetml"]')) archiveLive();
  }, true);
  const Observer = windowNode?.MutationObserver || globalThis.MutationObserver;
  const observer = Observer ? new Observer(scheduleReconcile) : null;
  observer?.observe(documentNode.body, { childList: true, subtree: true });

  api.entities = Object.freeze({ ...entityApi, openActor, openToken });

  api.on?.('token:delete', event => {
    const key = tokenSheetWindowKey(event.detail?.tokenId || event.detail?.id);
    if (!manager.get(key)) return;
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
    documentNode.removeEventListener('pointerup', handleGeometryEnd, true);
  });
}
