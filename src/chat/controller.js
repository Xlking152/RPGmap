import { appendChatMessage, createChatMessage } from './model.js';
import { ChatStore } from './store.js';

const STYLE_ID = 'rpgmap-chat-system-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .ui-vtt-shell .sidebar .tabbar.chat-tabs { grid-template-columns:repeat(3,1fr); }
    .rpgmap-chat-panel { height:100%; min-height:0; }
    .rpgmap-chat-shell { height:100%; min-height:0; display:grid; grid-template-rows:1fr auto auto; gap:8px; padding:8px; }
    .rpgmap-chat-log { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding-right:2px; }
    .rpgmap-chat-empty { color:#748184; text-align:center; padding:28px 10px; line-height:1.6; }
    .rpgmap-chat-card { border:1px solid rgba(65,85,85,.18); border-radius:9px; padding:9px; background:#fff; display:grid; gap:5px; }
    .rpgmap-chat-card.system { background:#f5f8f5; }
    .rpgmap-chat-card.combat { border-left:4px solid #b66a28; }
    .rpgmap-chat-card.damage { border-left:4px solid #a5483f; }
    .rpgmap-chat-card.roll { border-left:4px solid #526fa8; }
    .rpgmap-chat-meta { display:flex; gap:7px; align-items:center; color:#758184; font-size:10px; }
    .rpgmap-chat-meta strong { color:#4b5a5d; font-size:11px; }
    .rpgmap-chat-text { white-space:pre-wrap; line-height:1.5; color:#344346; font-size:12px; }
    .rpgmap-chat-details { padding:6px 7px; border-radius:6px; background:#eef3ef; font-size:11px; color:#536164; }
    .rpgmap-chat-tools { display:grid; gap:7px; }
    .rpgmap-chat-form { display:grid; grid-template-columns:1fr auto; gap:6px; }
    .rpgmap-chat-form input { min-width:0; }
    .rpgmap-chat-form button { white-space:nowrap; }
  `;
  documentNode.head.append(style);
}

function timeLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function detailText(message) {
  const data = message.data || {};
  if (message.type === 'damage') {
    const before = data.beforeLabel || '';
    const after = data.afterLabel || '';
    return [data.damageLabel, before && after ? `${before} → ${after}` : after].filter(Boolean).join('\n');
  }
  if (message.type === 'roll') return data.resultLabel || data.formula || '';
  return data.detail || '';
}

function renderMessage(message) {
  const detail = detailText(message);
  const label = message.author || (message.type === 'combat' ? '战斗' : message.type === 'damage' ? '伤害' : message.type === 'roll' ? '检定' : '系统');
  return `<article class="rpgmap-chat-card ${escapeHtml(message.type)}" data-chat-message="${escapeHtml(message.id)}">
    <div class="rpgmap-chat-meta"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(timeLabel(message.createdAt))}</span></div>
    ${message.text ? `<div class="rpgmap-chat-text">${escapeHtml(message.text)}</div>` : ''}
    ${detail ? `<div class="rpgmap-chat-details">${escapeHtml(detail)}</div>` : ''}
  </article>`;
}

export function createChatController() {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const shell = mapElement.closest('.app-shell');
      if (!shell) return;
      installStyles(documentNode);

      const tabbar = shell.querySelector('.sidebar .tabbar');
      const panelStack = shell.querySelector('.sidebar .panel-stack');
      if (!tabbar || !panelStack) return;
      tabbar.classList.add('chat-tabs');

      let panel = panelStack.querySelector('[data-panel="chat"]');
      if (!panel) {
        panel = documentNode.createElement('section');
        panel.className = 'panel rpgmap-chat-panel';
        panel.dataset.panel = 'chat';
        panel.innerHTML = `<div class="rpgmap-chat-shell">
          <div class="rpgmap-chat-log" data-chat-log></div>
          <div class="rpgmap-chat-tools" data-chat-tools></div>
          <form class="rpgmap-chat-form" data-chat-form><input type="text" maxlength="500" placeholder="输入聊天或记录…" data-chat-input><button type="submit" class="small-button primary">发送</button></form>
        </div>`;
        panelStack.prepend(panel);
      }

      let chatTab = tabbar.querySelector('[data-ui-sidebar="chat"]');
      if (!chatTab) {
        chatTab = documentNode.createElement('button');
        chatTab.type = 'button';
        chatTab.className = 'ui-sidebar-tab';
        chatTab.dataset.uiSidebar = 'chat';
        chatTab.textContent = '聊天';
        tabbar.prepend(chatTab);
      }

      const store = new ChatStore(api);
      store.load();
      const logNode = panel.querySelector('[data-chat-log]');
      const form = panel.querySelector('[data-chat-form]');
      const input = panel.querySelector('[data-chat-input]');

      function activateChat() {
        shell.querySelectorAll('.sidebar [data-panel]').forEach(node => node.classList.toggle('active', node === panel));
        shell.querySelectorAll('.ui-sidebar-tab').forEach(node => node.classList.toggle('active', node === chatTab));
      }

      function render({ stickToBottom = true } = {}) {
        if (!logNode) return;
        const messages = store.state.messages || [];
        logNode.innerHTML = messages.length
          ? messages.map(renderMessage).join('')
          : '<div class="rpgmap-chat-empty"><b>聊天与战斗记录</b><br>战斗、伤害和未来的投骰结果都会记录在这里。</div>';
        if (stickToBottom) logNode.scrollTop = logNode.scrollHeight;
      }

      function add(entry, { persist = true, open = false } = {}) {
        const message = appendChatMessage(store.state, createChatMessage(entry));
        if (persist) store.persist();
        render();
        if (open) activateChat();
        return message;
      }

      api.chat = {
        add,
        addSystem(text, data = {}) { return add({ type: 'system', text, data }); },
        addCombat(text, data = {}) { return add({ type: 'combat', text, data }); },
        addDamage(text, data = {}) { return add({ type: 'damage', text, data }, { open: true }); },
        addRoll(text, data = {}) { return add({ type: 'roll', text, data }, { open: true }); },
        open: activateChat,
        render,
      };

      chatTab.addEventListener('click', activateChat);
      form?.addEventListener('submit', event => {
        event.preventDefault();
        const value = String(input?.value || '').trim();
        if (!value) return;
        add({ type: 'chat', author: '操作者', text: value });
        input.value = '';
      });

      api.on('state:import', () => {
        if (store.saving) return;
        store.load();
        render({ stickToBottom: false });
      });

      render();
    },
  };
}
