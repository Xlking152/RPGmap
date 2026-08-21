import { ChatStore } from './store.js';
import { damageTypeLabel, formatHealthSummary, healingTypeLabel, healthStatusLabel } from '../health/model.js';

const STYLE_ID = 'rpgmap-chat-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-chat-panel { height:100%; min-height:0; display:grid; grid-template-rows:auto minmax(0,1fr) auto; background:#f8faf7; }
    .chat-panel-head { display:flex; align-items:center; gap:8px; padding:9px 10px; border-bottom:1px solid rgba(55,75,75,.16); }
    .chat-panel-head strong { flex:1; }
    .chat-panel-head button { border:0; background:transparent; color:#7a8587; cursor:pointer; font:inherit; }
    .chat-log { overflow:auto; padding:9px; display:grid; align-content:start; gap:8px; }
    .chat-empty { padding:26px 8px; text-align:center; color:#7c8789; font-size:12px; line-height:1.65; }
    .chat-entry { border:1px solid rgba(70,90,90,.15); border-radius:9px; padding:8px 9px; background:#fff; display:grid; gap:5px; }
    .chat-entry.system { background:#f3f6f3; }
    .chat-entry.combat { border-left:4px solid #c86b24; }
    .chat-entry.damage { border-left:4px solid #a94442; }
    .chat-entry.healing { border-left:4px solid #4b9f69; }
    .chat-entry.roll { border-left:4px solid #6e5ba8; }
    .chat-entry-head { display:flex; align-items:center; gap:7px; color:#748082; font-size:10px; }
    .chat-entry-head strong { color:#536164; font-size:11px; }
    .chat-entry-text { white-space:pre-wrap; color:#39484b; font-size:12px; line-height:1.55; }
    .chat-damage-target { padding:6px 7px; border-radius:7px; background:#f7f3f1; font-size:11px; line-height:1.45; }
    .chat-damage-target strong { display:block; font-size:12px; color:#39484b; }
    .chat-composer { border-top:1px solid rgba(55,75,75,.16); padding:8px; display:grid; gap:7px; background:#fff; }
    .chat-composer-tabs { display:flex; gap:5px; }
    .chat-composer-tabs button { flex:1; border:0; border-radius:7px; padding:7px; background:#edf1ee; color:#59676a; font-weight:800; cursor:pointer; }
    .chat-composer-tabs button.active { background:#176d76; color:#fff; }
    .chat-message-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; }
    .chat-message-form input, .chat-damage-form input, .chat-damage-form select, .chat-healing-form input, .chat-healing-form select { min-width:0; padding:7px 8px; border:1px solid #cdd6d2; border-radius:7px; font:inherit; }
    .chat-composer button.primary { border:1px solid #176d76; border-radius:7px; padding:7px 10px; background:#176d76; color:#fff; font-weight:800; cursor:pointer; }
    .chat-damage-form, .chat-healing-form { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.2fr); gap:6px; }
    .chat-damage-form .wide, .chat-healing-form .wide { grid-column:1/-1; }
    .chat-selection-hint { grid-column:1/-1; color:#707d7f; font-size:10px; line-height:1.4; }
  `;
  documentNode.head.append(style);
}

function timeLabel(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function entryLabel(type) {
  if (type === 'combat') return '战斗';
  if (type === 'damage') return '伤害';
  if (type === 'healing') return '恢复';
  if (type === 'roll') return '检定';
  if (type === 'chat') return '消息';
  return '系统';
}

function healthTargetsHtml(data, { healing = false } = {}) {
  const targets = Array.isArray(data?.targets) ? data.targets : [];
  return targets.map(target => `<div class="chat-damage-target"><strong>${escapeHtml(target.actorName || '角色')}</strong><span>${escapeHtml(target.before || '—')} → ${escapeHtml(target.after || '—')}</span>${target.status ? `<br><span>${escapeHtml(target.status)}</span>` : ''}${Number(target.overflow) > 0 ? `<br><span>${healing ? '没有对应伤势或已恢复至上限，' : '生命槽已满，'}${escapeHtml(target.overflow)} 点未生效</span>` : ''}</div>`).join('');
}

function messageHtml(message) {
  const detail = message.type === 'damage'
    ? healthTargetsHtml(message.data)
    : message.type === 'healing'
      ? healthTargetsHtml(message.data, { healing: true })
      : '';
  return `<article class="chat-entry ${escapeHtml(message.type)}" data-chat-message-id="${escapeHtml(message.id)}">
    <div class="chat-entry-head"><strong>${escapeHtml(entryLabel(message.type))}</strong><span>${escapeHtml(timeLabel(message.createdAt))}</span></div>
    ${message.text ? `<div class="chat-entry-text">${escapeHtml(message.text)}</div>` : ''}${detail}
  </article>`;
}

export function createChatController({ selection } = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell') || documentNode;
      const tabbar = shell.querySelector?.('.sidebar .tabbar');
      const panelStack = shell.querySelector?.('.sidebar .panel-stack');
      if (!tabbar || !panelStack) return;
      installStyles(documentNode);

      const store = new ChatStore(api);
      store.load();
      let composerMode = 'message';

      const chatTab = documentNode.createElement('button');
      chatTab.type = 'button';
      chatTab.className = 'ui-sidebar-tab';
      chatTab.dataset.uiSidebar = 'chat';
      chatTab.textContent = '聊天';
      tabbar.prepend(chatTab);
      tabbar.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';

      const panel = documentNode.createElement('section');
      panel.className = 'panel';
      panel.dataset.panel = 'chat';
      panelStack.prepend(panel);

      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];
      const status = message => {
        const node = shell.querySelector?.('[data-role="map-status"]');
        if (node) node.textContent = message;
      };

      function activateChat() {
        shell.querySelectorAll('.sidebar [data-panel]').forEach(node => node.classList.toggle('active', node === panel));
        shell.querySelectorAll('.ui-sidebar-tab').forEach(node => node.classList.toggle('active', node === chatTab));
        render();
      }

      function render() {
        const messages = store.state.messages || [];
        const selectedCount = selectedIds().length;
        panel.innerHTML = `<div class="rpgmap-chat-panel">
          <header class="chat-panel-head"><strong>聊天 / 战斗记录</strong><button type="button" data-chat-action="clear" title="清空本地记录">清空</button></header>
          <div class="chat-log" data-chat-log>${messages.length ? messages.map(messageHtml).join('') : '<div class="chat-empty">这里会记录聊天、战斗回合、伤害、恢复以及后续的投骰结果。</div>'}</div>
          <div class="chat-composer">
            <div class="chat-composer-tabs"><button type="button" class="${composerMode === 'message' ? 'active' : ''}" data-chat-mode="message">消息</button><button type="button" class="${composerMode === 'damage' ? 'active' : ''}" data-chat-mode="damage">伤害</button><button type="button" class="${composerMode === 'healing' ? 'active' : ''}" data-chat-mode="healing">恢复</button></div>
            ${composerMode === 'message'
              ? '<form class="chat-message-form" data-chat-message-form><input type="text" maxlength="1000" autocomplete="off" placeholder="输入消息…" data-chat-message-input><button class="primary" type="submit">发送</button></form>'
              : composerMode === 'damage'
                ? `<form class="chat-damage-form" data-chat-damage-form><input type="number" min="0" step="1" placeholder="伤害点数" data-damage-amount><select data-damage-type><option value="B">冲击 B</option><option value="L" selected>严重 L</option><option value="A">恶性 A</option></select><button class="primary wide" type="submit">应用到所选角色${selectedCount ? ` · ${selectedCount}` : ''}</button><div class="chat-selection-hint">这里输入的是已经完成防御、减免等前置处理后的结算伤害。伤势生命槽按 B / L / A 规则处理；普通 HP 模式直接扣除同等数值。</div></form>`
                : `<form class="chat-healing-form" data-chat-healing-form><input type="number" min="0" step="1" placeholder="实际恢复生命槽" data-healing-amount><select data-healing-type><option value="B">恢复冲击 B</option><option value="L" selected>恢复严重 L</option><option value="A">恢复恶性 A</option></select><button class="primary wide" type="submit">恢复所选角色${selectedCount ? ` · ${selectedCount}` : ''}</button><div class="chat-selection-hint">输入规则结算后的实际恢复生命槽数。医疗/治疗点数的换算比例由具体效果决定，换算后再恢复对应 B / L / A；普通 HP 模式直接回复同等 HP。</div></form>`}
          </div>
        </div>`;
        const log = panel.querySelector('[data-chat-log]');
        if (log) log.scrollTop = log.scrollHeight;
      }

      function append(type, text, data = null) {
        const item = store.append({ type, text, data });
        render();
        return item;
      }

      api.chat = {
        message: (text, data = null) => append('chat', text, data),
        system: (text, data = null) => append('system', text, data),
        combat: (text, data = null) => append('combat', text, data),
        damage: (text, data = null) => append('damage', text, data),
        healing: (text, data = null) => append('healing', text, data),
        roll: (text, data = null) => append('roll', text, data),
        activate: activateChat,
      };

      chatTab.addEventListener('click', activateChat);

      panel.addEventListener('click', event => {
        const mode = event.target.closest?.('[data-chat-mode]')?.dataset.chatMode;
        if (mode) { composerMode = mode; render(); return; }
        if (event.target.closest?.('[data-chat-action="clear"]')) {
          if (!window.confirm('清空聊天 / 战斗记录？')) return;
          store.clear(); render(); status('聊天记录已清空');
        }
      });

      panel.addEventListener('submit', event => {
        if (event.target.matches('[data-chat-message-form]')) {
          event.preventDefault();
          const input = event.target.querySelector('[data-chat-message-input]');
          const value = input?.value?.trim();
          if (!value) return;
          append('chat', value);
          return;
        }
        if (event.target.matches('[data-chat-damage-form]')) {
          event.preventDefault();
          const amount = Number(event.target.querySelector('[data-damage-amount]')?.value);
          const type = event.target.querySelector('[data-damage-type]')?.value || 'L';
          if (!Number.isFinite(amount) || amount <= 0) { status('应用伤害：请输入大于 0 的伤害点数'); return; }
          const ids = selectedIds();
          if (!ids.length) { status('应用伤害：请先选择一个或多个 Token'); return; }
          const results = api.damage?.applyToSelected?.({ amount, type }) || api.health?.applyDamageToTokenIds?.(ids, { amount, type }) || [];
          if (!results.length) { status('应用伤害：当前选择中没有可用 Actor'); return; }
          const targets = results.map(result => ({
            actorId: result.actorId,
            actorName: result.actorName,
            before: formatHealthSummary(result.before),
            after: formatHealthSummary(result.after),
            status: healthStatusLabel(result.after),
            applied: result.applied,
            overflow: result.overflow,
          }));
          append('damage', `${results.length} 个角色受到 ${Math.floor(amount)} 点${damageTypeLabel(type)}伤害`, { amount: Math.floor(amount), damageType: type, targets });
          status(`已应用 ${Math.floor(amount)} 点${damageTypeLabel(type)}伤害 · ${results.length} 个角色`);
          return;
        }
        if (event.target.matches('[data-chat-healing-form]')) {
          event.preventDefault();
          const amount = Number(event.target.querySelector('[data-healing-amount]')?.value);
          const type = event.target.querySelector('[data-healing-type]')?.value || 'L';
          if (!Number.isFinite(amount) || amount <= 0) { status('恢复生命：请输入大于 0 的恢复数值'); return; }
          const ids = selectedIds();
          if (!ids.length) { status('恢复生命：请先选择一个或多个 Token'); return; }
          const results = api.healing?.applyToSelected?.({ amount, type }) || api.health?.applyHealingToTokenIds?.(ids, { amount, type }) || [];
          if (!results.length) { status('恢复生命：当前选择中没有可用 Actor'); return; }
          const targets = results.map(result => ({
            actorId: result.actorId,
            actorName: result.actorName,
            before: formatHealthSummary(result.before),
            after: formatHealthSummary(result.after),
            status: result.blocked === 'dead' ? '目标已死亡；普通恢复不能代替复活' : healthStatusLabel(result.after),
            applied: result.applied,
            overflow: result.overflow,
          }));
          append('healing', `${results.length} 个角色恢复 ${Math.floor(amount)} 点${healingTypeLabel(type)}生命槽`, { amount: Math.floor(amount), healingType: type, targets });
          status(`已执行恢复 · ${results.length} 个角色`);
        }
      });

      selection?.subscribe?.(() => { if (panel.classList.contains('active')) render(); });
      api.on('state:import', () => {
        if (store.saving) return;
        store.load();
        if (panel.classList.contains('active')) render();
      });

      render();
    },
  };
}
