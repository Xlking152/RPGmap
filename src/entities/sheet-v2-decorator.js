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
    .entity-sheet-v2 .entity-sheet-tabs { gap:0; padding:0 10px; overflow-x:auto; }
    .entity-sheet-v2 .entity-sheet-tab { flex:0 0 auto; padding:9px 11px; font-size:12px; }
    .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body { grid-template-columns:minmax(210px,250px) minmax(0,1fr); align-items:start; }
    .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body > [data-health-panel] { grid-column:1; grid-row:1 / span 40; position:sticky; top:142px; }
    .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body > :not([data-health-panel]) { grid-column:2; }
    .entity-limited-sheet.entity-sheet-v2 { min-width:360px; width:min(520px,92vw); }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header { padding:18px; }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header .entity-avatar,
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-header .entity-avatar img { width:78px; height:78px; }
    .entity-limited-sheet.entity-sheet-v2 .entity-sheet-body { padding:18px; }
    @media(max-width:760px){
      .entity-sheet-v2 { min-width:0; }
      .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body { grid-template-columns:1fr; }
      .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body > [data-health-panel],
      .entity-sheet-v2[data-sheet-v2-tab="overview"] .entity-sheet-body > :not([data-health-panel]) { grid-column:1; grid-row:auto; position:static; }
    }
  `;
  documentNode.head.append(style);
}

function decorateSheet(sheet) {
  sheet.classList.add('entity-sheet-v2');
  const activeTab = sheet.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab || '';
  sheet.dataset.sheetV2Tab = activeTab;
  const title = sheet.querySelector('.entity-sheet-title');
  if (!title || title.querySelector('[data-sheet-v2-badges]')) return;

  const mode = String(sheet.dataset.sheetMode || '');
  const badges = [];
  if (mode === 'limited') badges.push('<span class="entity-sheet-v2-badge is-limited">LIMITED</span>');
  else if (mode === 'instance') badges.push('<span class="entity-sheet-v2-badge">TOKEN INSTANCE</span>');
  else if (mode === 'template') badges.push('<span class="entity-sheet-v2-badge">ACTOR</span>');
  if (sheet.classList.contains('entity-sheet-readonly') && mode !== 'limited') badges.push('<span class="entity-sheet-v2-badge is-readonly">只读</span>');
  if (!badges.length) return;
  title.insertAdjacentHTML('beforeend', `<div class="entity-sheet-v2-badges" data-sheet-v2-badges>${badges.join('')}</div>`);
}

export function createActorSheetV2Decorator() {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      installStyles(documentNode);
      let scheduled = false;
      let destroyed = false;

      function decorate() {
        scheduled = false;
        if (destroyed) return;
        documentNode.querySelectorAll('.entity-sheet').forEach(decorateSheet);
      }

      function schedule() {
        if (scheduled || destroyed) return;
        scheduled = true;
        if (windowNode.requestAnimationFrame) windowNode.requestAnimationFrame(decorate);
        else windowNode.setTimeout(decorate, 0);
      }

      function handleClick(event) {
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
