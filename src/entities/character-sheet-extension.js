import { normalizeEntityState } from './model.js';
import { resolveActor, setBadStatusCurrent } from './resolver.js';
import { EntityStore } from './store.js';

const STYLE_ID = 'rpgmap-character-sheet-extension-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function actorFromOpenSheet(api, documentNode, state = null) {
  const formId = documentNode.querySelector('.entity-sheet [data-form-select]')?.value;
  if (!formId) return null;
  const entityState = state || normalizeEntityState(api.getState().preferences?.entitySystem);
  return entityState.actors.find(actor => actor.forms?.some(form => String(form.id) === String(formId))) || null;
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .entity-bad-status-table { width:100%; border-collapse:collapse; font-size:13px; }
    .entity-bad-status-table th,.entity-bad-status-table td { padding:8px 7px; border-bottom:1px solid #e0e5e2; text-align:center; vertical-align:middle; }
    .entity-bad-status-table th:first-child,.entity-bad-status-table td:first-child { text-align:left; }
    .entity-bad-status-table input { width:78px; text-align:center; font-weight:800; }
    .entity-bad-status-current.is-light { background:#fff6c9; }
    .entity-bad-status-current.is-severe { background:#ffe0bf; }
    .entity-bad-status-current.is-destruction { background:#ffd7d7; color:#a71818; border-color:#d65b5b; }
  `;
  documentNode.head.append(style);
}

function renderSaves(actor) {
  const saves = actor?.forms?.find(form => form.id === actor.currentFormId)?.checks?.saves || [];
  const rows = saves.length
    ? saves.map(save => `<tr><td>${escapeHtml(save.name)}</td><td><b>${Number(save.checkValue) || 0}</b></td><td>${Number(save.totalBonus) || 0}</td></tr>`).join('')
    : '<tr><td colspan="3" class="entity-empty">暂无豁免速查数据。重新导入角色卡后会读取“具体数值表 → 检定速查”。</td></tr>';
  return `<h3>豁免鉴定</h3><table class="entity-check-table"><thead><tr><th>类型</th><th>当前鉴定</th><th>总附加</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function statusLevel(status) {
  const current = Number(status.current) || 0;
  if (status.destruction > 0 && current >= status.destruction) return 'is-destruction';
  if (status.severe > 0 && current >= status.severe) return 'is-severe';
  if (status.light > 0 && current >= status.light) return 'is-light';
  return '';
}

function renderBadStatuses(actor) {
  const resolved = resolveActor(actor);
  const statuses = resolved?.badStatuses || [];
  const rows = statuses.map(status => `<tr>
    <td>${escapeHtml(status.name)}</td>
    <td><input class="entity-bad-status-current ${statusLevel(status)}" type="number" min="0" step="1" value="${status.current}" data-bad-status-current="${escapeHtml(status.id)}"></td>
    <td>${status.light}</td><td>${status.severe}</td><td>${status.destruction}</td>
  </tr>`).join('');
  return `<section class="entity-section" data-bad-status-panel>
    <h3>不良状态</h3>
    <p class="entity-help">“当前”由玩家直接填写；轻度、重度、毁灭为当前形态的标准。切换形态只切换标准，不会清空已经受到的不良点数。</p>
    <table class="entity-bad-status-table"><thead><tr><th>类型</th><th>当前</th><th>轻度</th><th>重度</th><th>毁灭</th></tr></thead><tbody>${rows}</tbody></table>
  </section>`;
}

export function createCharacterSheetExtension() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      installStyles(documentNode);
      let badStatusMode = false;
      let enhancing = false;

      function enhanceSheet() {
        if (enhancing) return;
        const sheet = documentNode.querySelector('.entity-sheet');
        if (!sheet) return;
        enhancing = true;
        try {
          const tabs = sheet.querySelector('.entity-sheet-tabs');
          if (tabs && !tabs.querySelector('[data-sheet-tab="bad-status"]')) {
            const button = documentNode.createElement('button');
            button.type = 'button';
            button.className = `entity-sheet-tab${badStatusMode ? ' active' : ''}`;
            button.dataset.sheetTab = 'bad-status';
            button.textContent = '不良状态';
            const combat = tabs.querySelector('[data-sheet-tab="combat"]');
            tabs.insertBefore(button, combat || null);
          }

          const actor = actorFromOpenSheet(api, documentNode);
          if (!actor) return;

          if (badStatusMode) {
            const body = sheet.querySelector('.entity-sheet-body');
            const formId = actor.currentFormId;
            if (body && body.dataset.badStatusForm !== String(formId)) {
              body.innerHTML = renderBadStatuses(actor);
              body.dataset.badStatusForm = String(formId);
            }
            tabs?.querySelectorAll('.entity-sheet-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.sheetTab === 'bad-status'));
            return;
          }

          const activeTab = tabs?.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab;
          if (activeTab === 'checks') {
            const sections = [...sheet.querySelectorAll('.entity-sheet-body > .entity-section')];
            const saveSection = sections.find(section => /豁免/.test(section.querySelector('h3')?.textContent || ''));
            if (saveSection && !saveSection.dataset.trueSaveChecks) {
              saveSection.innerHTML = renderSaves(actor);
              saveSection.dataset.trueSaveChecks = '1';
            }
          }
        } finally {
          enhancing = false;
        }
      }

      documentNode.addEventListener('click', event => {
        const tab = event.target.closest?.('[data-sheet-tab]');
        if (!tab) return;
        badStatusMode = tab.dataset.sheetTab === 'bad-status';
      }, true);

      documentNode.addEventListener('change', event => {
        const input = event.target.closest?.('[data-bad-status-current]');
        if (!input) return;
        const formId = documentNode.querySelector('.entity-sheet [data-form-select]')?.value;
        if (!formId) return;
        const store = new EntityStore(api);
        store.load({ migrateLegacy: false, dropMarkers: false });
        const actor = store.state.actors.find(item => item.forms?.some(form => String(form.id) === String(formId)));
        if (!actor) return;
        setBadStatusCurrent(actor, input.dataset.badStatusCurrent, input.value);
        store.persist();
        queueMicrotask(enhanceSheet);
      });

      const observer = new MutationObserver(() => queueMicrotask(enhanceSheet));
      observer.observe(documentNode.body, { childList: true, subtree: true });
      queueMicrotask(enhanceSheet);
    },
  };
}
