import { renderStatusStrip, resolveStatusUiSnapshot, statusDefinitions } from './ui.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function statusTarget(token) {
  return token.actorLink === false
    ? { scope: 'syntheticActor', targetId: String(token.id) }
    : { scope: 'actor', targetId: String(token.actorId) };
}

function categoryLabel(category) {
  if (category === 'buff') return 'Buff';
  if (category === 'debuff') return 'Debuff';
  return '中性 / 派生';
}

function statusForToken(api, token, definitionId) {
  const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
  return snapshot.actorStatuses.find(status => String(status.definitionId) === String(definitionId)) || null;
}

export function createQuickStatusHud({ api, documentNode } = {}) {
  let primaryTokenId = null;

  function close() {
    documentNode.querySelector?.('[data-status-quick-hud]')?.remove();
    primaryTokenId = null;
  }

  function targetTokens(tokenId) {
    const primary = api.tokens?.get?.(tokenId);
    if (!primary) return [];
    const selected = new Set((api.selection?.getSelectedTokenIds?.() || []).map(String));
    if (!selected.has(String(primary.id))) return [primary];
    return (api.tokens?.list?.() || []).filter(token => selected.has(String(token.id))).slice(0, 64);
  }

  function render(tokenId, point = null) {
    close();
    const token = api.tokens?.get?.(tokenId);
    if (!token) return false;
    primaryTokenId = String(token.id);
    const definitions = statusDefinitions(api).filter(definition => definition.scopes.includes('actor'));
    const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
    const activeById = new Map(snapshot.actorStatuses.map(status => [String(status.definitionId), status]));
    const groups = ['buff', 'debuff', 'neutral'].map(category => {
      const values = definitions.filter(definition => definition.category === category
        || (category === 'neutral' && !['buff', 'debuff'].includes(definition.category)));
      return `<section class="status-quick-group" ${category === 'neutral' ? 'data-status-neutral' : ''}><h3>${categoryLabel(category)}</h3><div class="status-quick-grid">${values.map(definition => {
        const status = activeById.get(definition.id);
        const state = !status ? 'absent' : status.enabled === false ? 'disabled' : 'enabled';
        return `<button type="button" data-quick-status="${escapeHtml(definition.id)}" data-state="${state}" style="--status-color:${escapeHtml(definition.color)}"><span>${escapeHtml(definition.label)}</span><small>${state === 'absent' ? '施加' : state === 'enabled' ? '停用' : '启用'}</small></button>`;
      }).join('') || '<small>暂无定义</small>'}</div></section>`;
    }).join('');
    const node = documentNode.createElement('aside');
    node.className = 'status-quick-hud';
    node.dataset.statusQuickHud = '';
    node.innerHTML = `<header><div><strong>快捷状态</strong><small>${targetTokens(token.id).length} 个 Token</small></div><button type="button" data-quick-action="close" aria-label="关闭">×</button></header>${groups}<section class="status-quick-derived"><h3>当前状态</h3>${renderStatusStrip(snapshot.statuses, { limit: 10, emptyText: '无状态' })}</section><footer><button type="button" class="small-button" data-quick-action="details">详情</button></footer>`;
    if (point && Number.isFinite(Number(point.clientX)) && Number.isFinite(Number(point.clientY))) {
      node.style.left = `${Math.max(8, Math.min((documentNode.defaultView?.innerWidth || 800) - 330, Number(point.clientX)))}px`;
      node.style.top = `${Math.max(8, Math.min((documentNode.defaultView?.innerHeight || 600) - 430, Number(point.clientY)))}px`;
    }
    documentNode.body.append(node);
    return true;
  }

  async function cycle(definitionId) {
    const tokens = targetTokens(primaryTokenId);
    const operations = [];
    const seen = new Set();
    for (const token of tokens) {
      const target = statusTarget(token);
      const key = `${target.scope}:${target.targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const current = statusForToken(api, token, definitionId);
      operations.push(current
        ? { type: 'status.setStacks', ...target, definitionId, stacks: current.stacks || 1, enabled: current.enabled === false }
        : { type: 'status.apply', ...target, definitionId, stacks: 1 });
    }
    if (!operations.length) return;
    const controls = operations.every(operation => {
      const token = tokens.find(item => {
        const target = statusTarget(item);
        return target.scope === operation.scope && target.targetId === operation.targetId;
      });
      return !token || api.permissions?.can?.('token.control', { token, tokenId: token.id }) !== false;
    });
    if (!controls) throw new Error('当前选择中包含无权控制的 Token');
    await api.status.applyBatch(operations);
    render(primaryTokenId);
  }

  async function handleClick(event) {
    const hud = event.target?.closest?.('[data-status-quick-hud]');
    if (!hud) return;
    const action = event.target.closest?.('[data-quick-action]')?.dataset?.quickAction;
    if (action === 'close') return close();
    if (action === 'details') {
      const tokenId = primaryTokenId;
      close();
      api.entities?.openToken?.(tokenId, 'status');
      return;
    }
    const definitionId = event.target.closest?.('[data-quick-status]')?.dataset?.quickStatus;
    if (!definitionId) return;
    event.preventDefault();
    try { await cycle(definitionId); }
    catch (error) { api.showToast?.(`状态操作失败：${error?.message || error}`, 'error'); }
  }

  documentNode.addEventListener('click', handleClick);
  return Object.freeze({ open: render, close, destroy() { close(); documentNode.removeEventListener('click', handleClick); } });
}
