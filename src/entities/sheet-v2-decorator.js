import { actorSheetDescriptionFor } from './sheet-policy.js';

const STYLE_ID = 'rpgmap-actor-sheet-v2-style';

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .entity-sheet-v2 { min-width:560px; }
    .entity-sheet-v2 .entity-sheet-header { gap:12px; padding:11px 13px; }
    .entity-sheet-v2 .entity-sheet-header .entity-avatar,
    .entity-sheet-v2 .entity-sheet-header .entity-avatar img { width:58px; height:58px; border-radius:10px; }
    .entity-sheet-v2 .entity-sheet-title { display:grid; gap:4px; }
    .entity-sheet-v2 .entity-sheet-title input { font-size:21px; }
    .entity-sheet-v2-badges { display:flex; gap:5px; flex-wrap:wrap; align-items:center; }
    .entity-sheet-v2-badge { padding:2px 7px; border:1px solid #cbd6d2; border-radius:999px; background:#eef3ef; color:#536366; font-size:10px; font-weight:800; letter-spacing:.35px; }
    .entity-sheet-v2-badge.is-limited { border-color:#d6c8a0; background:#f8f2df; color:#705d27; }
    .entity-sheet-v2-badge.is-readonly { border-color:#c7d5dd; background:#eef4f7; color:#526775; }
    .entity-sheet-v2-badge.is-character { border-color:#b9d2c3; background:#edf7f0; color:#35634a; }
    .entity-sheet-v2-badge.is-monster { border-color:#dec4bc; background:#fbefeb; color:#7b4639; }
    .entity-sheet-v2-badge.is-npc { border-color:#c7cae1; background:#f1f1fa; color:#555b83; }
    .entity-sheet-v2-mode-toggle { border:1px solid #cbd6d2; border-radius:7px; padding:4px 8px; background:#fff; color:#45585b; cursor:pointer; font-size:11px; font-weight:800; }
    .entity-sheet-v2-mode-toggle[aria-pressed="true"] { border-color:#176d76; background:#e9f4f4; color:#176d76; }
    .entity-sheet-v2[data-sheet-interaction-mode="play"] [data-sheet-v2-edit-only] { display:none !important; }
    .entity-sheet-v2[data-sheet-interaction-mode="play"] [data-actor-name]:disabled { border-bottom-color:transparent; color:inherit; opacity:1; cursor:default; }
    .entity-sheet-v2 .entity-sheet-tabs { gap:0; padding:0 10px; overflow-x:auto; }
    .entity-sheet-v2 .entity-sheet-tab { flex:0 0 auto; padding:9px 11px; font-size:12px; }
    .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body { grid-template-columns:minmax(210px,250px) minmax(0,1fr); align-items:start; }
    .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body > [data-health-panel] { grid-column:1; grid-row:1 / span 40; position:sticky; top:142px; }
    .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body > :not([data-health-panel]) { grid-column:2; }
    .entity-sheet-v2[data-sheet-kind="monster"][data-sheet-v2-tab="combat"] .entity-sheet-body,
    .entity-sheet-v2[data-sheet-kind="npc"] .entity-sheet-body { align-content:start; }
    .entity-limited-sheet.entity-sheet-v2 { min-width:360px; width:min(520px,92vw); }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header { padding:18px; }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header .entity-avatar,
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header .entity-avatar img { width:78px; height:78px; }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-body { padding:18px; }
    @media(max-width:760px){
      .entity-sheet-v2 { min-width:0; }
      .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body { grid-template-columns:1fr; }
      .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body > [data-health-panel],
      .entity-sheet-v2[data-sheet-kind="character"][data-sheet-v2-tab="overview"] .entity-sheet-body > :not([data-health-panel]) { grid-column:1; grid-row:auto; position:static; }
    }
  `;
  documentNode.head.append(style);
}

function sheetKey(sheet) {
  const tokenId = String(sheet?.dataset?.tokenId || '').trim();
  if (tokenId) return `token:${tokenId}`;
  const actorId = String(sheet?.dataset?.actorId || '').trim();
  return actorId ? `actor:${actorId}` : '';
}

function kindLabel(kind) {
  return ({ character: '角色卡', monster: '怪物卡', npc: 'NPC 卡', generic: 'Actor' })[kind] || 'Actor';
}

function kindClass(kind) {
  return ['character', 'monster', 'npc'].includes(kind) ? ` is-${kind}` : '';
}

function readStoredMode(storage, storageKey, key) {
  if (!storage || !key) return 'play';
  try {
    return storage.getItem(`${storageKey}.${key}`) === 'edit' ? 'edit' : 'play';
  } catch {
    return 'play';
  }
}

function writeStoredMode(storage, storageKey, key, mode) {
  if (!storage || !key) return;
  try { storage.setItem(`${storageKey}.${key}`, mode === 'edit' ? 'edit' : 'play'); }
  catch { /* local UI preference failure must not block sheet use */ }
}

function interactionMode(sheet, storage, storageKey) {
  const mode = String(sheet.dataset.sheetMode || '');
  if (mode === 'limited') return 'limited';
  if (sheet.classList.contains('entity-sheet-readonly')) return 'view';
  if (mode === 'instance') return 'play';
  return readStoredMode(storage, storageKey, sheetKey(sheet));
}

function rememberDisabled(control) {
  if (!control || Object.hasOwn(control.dataset, 'sheetV2OriginalDisabled')) return;
  control.dataset.sheetV2OriginalDisabled = control.disabled ? '1' : '0';
}

function applyEditGating(sheet, mode) {
  const editableTemplate = String(sheet.dataset.sheetMode || '') === 'template'
    && !sheet.classList.contains('entity-sheet-readonly');
  if (!editableTemplate) return;

  const nameInput = sheet.querySelector('[data-actor-name]');
  if (nameInput) {
    rememberDisabled(nameInput);
    nameInput.disabled = mode !== 'edit' || nameInput.dataset.sheetV2OriginalDisabled === '1';
  }

  for (const control of sheet.querySelectorAll('[data-actor-type], [data-actor-party]')) {
    control.closest('label')?.setAttribute('data-sheet-v2-edit-only', '1');
  }
  for (const control of sheet.querySelectorAll('[data-sheet-action="avatar"], [data-sheet-action="add-form"]')) {
    control.setAttribute('data-sheet-v2-edit-only', '1');
  }
}

function decorateSheet(sheet, api, storage, storageKey) {
  sheet.classList.add('entity-sheet-v2');
  const activeTab = sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '';
  sheet.dataset.sheetV2Tab = activeTab;

  const description = actorSheetDescriptionFor(api, sheet.dataset.actorId);
  const kind = String(description?.kind || 'generic');
  const summary = description?.summary || {};
  sheet.dataset.sheetKind = kind;

  const mode = interactionMode(sheet, storage, storageKey);
  sheet.dataset.sheetInteractionMode = mode;
  applyEditGating(sheet, mode);

  const title = sheet.querySelector('.entity-sheet-title');
  if (!title) return;

  let badges = title.querySelector('[data-sheet-v2-badges]');
  if (!badges) {
    title.insertAdjacentHTML('beforeend', '<div class="entity-sheet-v2-badges" data-sheet-v2-badges></div>');
    badges = title.querySelector('[data-sheet-v2-badges]');
  }

  const sheetMode = String(sheet.dataset.sheetMode || '');
  const badgeHtml = [
    `<span class="entity-sheet-v2-badge${kindClass(kind)}">${kindLabel(kind)}</span>`,
    summary.typeLabel ? `<span class="entity-sheet-v2-badge">${String(summary.typeLabel)}</span>` : '',
  ];
  if (sheetMode === 'limited') badgeHtml.push('<span class="entity-sheet-v2-badge is-limited">LIMITED</span>');
  else if (sheetMode === 'instance') badgeHtml.push('<span class="entity-sheet-v2-badge">TOKEN INSTANCE</span>');
  else if (sheetMode === 'template') badgeHtml.push('<span class="entity-sheet-v2-badge">ACTOR</span>');
  if (sheet.classList.contains('entity-sheet-readonly') && sheetMode !== 'limited') {
    badgeHtml.push('<span class="entity-sheet-v2-badge is-readonly">只读</span>');
  }
  if (['play', 'edit'].includes(mode)) badgeHtml.push(`<span class="entity-sheet-v2-badge">${mode.toUpperCase()}</span>`);

  const canToggle = sheetMode === 'template' && !sheet.classList.contains('entity-sheet-readonly');
  if (canToggle) {
    badgeHtml.push(`<button type="button" class="entity-sheet-v2-mode-toggle" data-sheet-v2-mode-toggle aria-pressed="${mode === 'edit'}">${mode === 'edit' ? '返回游玩' : '编辑卡片'}</button>`);
  }
  badges.innerHTML = badgeHtml.filter(Boolean).join('');
}

export function createActorSheetV2Decorator() {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const worldId = String(api.world?.get?.()?.id || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
      const storageKey = `rpgmap.ui.actor-sheet-mode.v1.${worldId}`;
      const storage = windowNode?.localStorage || null;
      installStyles(documentNode);
      let scheduled = false;
      let destroyed = false;

      function decorate() {
        scheduled = false;
        if (destroyed) return;
        documentNode.querySelectorAll('.entity-sheet').forEach(sheet => decorateSheet(sheet, api, storage, storageKey));
      }

      function schedule() {
        if (scheduled || destroyed) return;
        scheduled = true;
        if (windowNode.requestAnimationFrame) windowNode.requestAnimationFrame(decorate);
        else windowNode.setTimeout(decorate, 0);
      }

      function handleClick(event) {
        const toggle = event.target.closest?.('[data-sheet-v2-mode-toggle]');
        if (toggle) {
          const sheet = toggle.closest('.entity-sheet');
          const key = sheetKey(sheet);
          if (sheet && key) {
            event.preventDefault();
            event.stopPropagation();
            const next = sheet.dataset.sheetInteractionMode === 'edit' ? 'play' : 'edit';
            writeStoredMode(storage, storageKey, key, next);
            decorateSheet(sheet, api, storage, storageKey);
          }
          return;
        }
        if (event.target.closest?.('.entity-sheet-tab')) schedule();
      }

      const Observer = windowNode.MutationObserver || globalThis.MutationObserver;
      const observer = Observer ? new Observer(schedule) : null;
      observer?.observe(documentNode.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
      documentNode.addEventListener('click', handleClick);
      api.on?.('app:destroy', () => {
        destroyed = true;
        observer?.disconnect();
        documentNode.removeEventListener('click', handleClick);
      });
      schedule();
    },
  };
}
