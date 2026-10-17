import { renderStatusStrip, resolveStatusUiSnapshot, statusDefinitions } from './ui.js';
import { renderUiIcon } from '../ui/icons.js';
import { validateStatusDefinitionForActors } from './target-validation.js';

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
  if (category === 'buff') return '增益';
  if (category === 'debuff') return '减益';
  return '中性 / 派生';
}

function manualStatuses(snapshot) {
  return [...snapshot.actorStatuses, ...snapshot.tokenStatuses]
    .filter(status => !status.derived && !status.readOnly);
}

function effectiveState(statuses) {
  if (!statuses.length) return 'absent';
  return statuses.some(status => status.enabled !== false) ? 'enabled' : 'disabled';
}

export function planQuickStatusCycle(api, tokens, definitionId) {
  if (tokens.some(token => api.permissions?.can?.('token.control', { token, tokenId: token.id }) === false)) {
    throw new Error('当前选择中包含无权控制的 Token');
  }
  const definition = statusDefinitions(api).find(item => item.id === definitionId);
  if (!definition || definition.derived || definition.readOnly) return [];
  const operations = new Map();
  for (const token of tokens) {
    const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
    const current = manualStatuses(snapshot).filter(status => status.definitionId === definitionId);
    const enabled = effectiveState(current) !== 'enabled';
    const values = current.length ? current.map(status => ({
      type: 'status.setStacks',
      ...(status.scope === 'token' ? { scope: 'token', targetId: String(token.id) } : statusTarget(token)),
      definitionId, stacks: status.stacks || 1, enabled,
    })) : [{
      type: 'status.apply',
      ...(definition.scopes.includes('actor') ? statusTarget(token) : { scope: 'token', targetId: String(token.id) }),
      definitionId, stacks: 1,
    }];
    for (const operation of values) {
      const key = `${operation.scope}:${operation.targetId}`;
      // A shared Actor can be reached through Tokens with different local effects.
      // Stopping an effective status must not be undone by another selected Token.
      if (operations.get(key)?.enabled === false) continue;
      operations.set(key, operation);
    }
  }
  const values = [...operations.values()];
  for (const operation of values) {
    if (operation.type !== 'status.apply' || operation.scope === 'token') continue;
    const actor = operation.scope === 'syntheticActor'
      ? api.tokens?.resolveActor?.(operation.targetId)?.actor
      : api.tokens?.getActor?.(operation.targetId)
        || api.getState?.()?.preferences?.entitySystem?.actors?.find(item => String(item.id) === operation.targetId);
    if (!actor && definition.changes?.length) {
      const error = new Error(`Status Actor target is unavailable: ${operation.targetId}`);
      error.code = 'status_target_not_found';
      throw error;
    }
    validateStatusDefinitionForActors(definition, [actor], api.ruleset);
  }
  return values;
}

export function createQuickStatusHud({ api, documentNode } = {}) {
  let primaryTokenId = null;
  let anchorPoint = null;
  let pending = false;

  function close() {
    documentNode.querySelector?.('[data-status-quick-hud]')?.remove();
    primaryTokenId = null;
    anchorPoint = null;
  }

  function targetTokens(tokenId) {
    const primary = api.tokens?.get?.(tokenId);
    if (!primary) return [];
    const selected = new Set((api.selection?.getSelectedTokenIds?.() || []).map(String));
    if (!selected.has(String(primary.id))) return [primary];
    return (api.tokens?.list?.() || []).filter(token => selected.has(String(token.id))).slice(0, 64);
  }

  function render(tokenId, point = null) {
    const nextPoint = point || anchorPoint;
    const previous = primaryTokenId === String(tokenId) ? documentNode.querySelector?.('[data-status-quick-hud]') : null;
    const neutralOpen = previous?.querySelector?.('[data-status-neutral]')?.open === true;
    const scrollTop = previous?.scrollTop || 0;
    close();
    const token = api.tokens?.get?.(tokenId);
    if (!token) return false;
    primaryTokenId = String(token.id);
    anchorPoint = nextPoint;
    const targets = targetTokens(token.id);
    const definitions = statusDefinitions(api).filter(definition => !definition.derived && !definition.readOnly
      && (definition.scopes.includes('actor') || definition.scopes.includes('token')));
    const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
    const targetStatuses = targets.map(target => manualStatuses(resolveStatusUiSnapshot(api, { actorId: target.actorId, tokenId: target.id })));
    const groups = ['buff', 'debuff', 'neutral'].map(category => {
      const values = definitions.filter(definition => definition.category === category
        || (category === 'neutral' && !['buff', 'debuff'].includes(definition.category)));
      const tag = category === 'neutral' ? 'details' : 'section';
      const heading = category === 'neutral' ? 'summary' : 'h3';
      return `<${tag} class="status-quick-group" ${category === 'neutral' ? 'data-status-neutral' : ''}><${heading}>${categoryLabel(category)}</${heading}><div class="status-quick-grid">${values.map(definition => {
        const states = targetStatuses.map(statuses => effectiveState(statuses.filter(status => status.definitionId === definition.id)));
        const enabledCount = states.filter(state => state === 'enabled').length;
        const state = new Set(states).size > 1 ? 'mixed' : states[0] || 'absent';
        const command = state === 'mixed' ? '分别切换' : state === 'absent' ? '施加' : state === 'enabled' ? '停用' : '启用';
        const summary = targets.length > 1 ? `${enabledCount} / ${targets.length} 已生效` : command;
        return `<button type="button" data-quick-status="${escapeHtml(definition.id)}" data-state="${state}" aria-pressed="${state === 'mixed' ? 'mixed' : state === 'enabled'}" title="${escapeHtml(`${definition.label} · ${command}`)}" style="--status-color:${escapeHtml(definition.color)}"><span class="status-quick-icon" aria-hidden="true">${renderStatusStrip([definition])}</span><span class="status-quick-label">${escapeHtml(definition.label)}</span><small>${summary}</small></button>`;
      }).join('') || '<small>暂无定义</small>'}</div></${tag}>`;
    }).join('');
    const node = documentNode.createElement('aside');
    node.className = 'status-quick-hud';
    node.dataset.statusQuickHud = '';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-label', '快捷状态');
    node.innerHTML = `<header><div><strong>快捷状态</strong><small>已选择 ${targets.length} 个棋子</small></div><button type="button" data-quick-action="close" aria-label="关闭快捷状态" title="关闭快捷状态">${renderUiIcon('x')}</button></header>${groups}<section class="status-quick-derived"><h3>${targets.length > 1 ? '主棋子当前状态' : '当前状态'}</h3>${renderStatusStrip(snapshot.statuses, { limit: 10, emptyText: '无状态' })}</section><footer><button type="button" class="small-button" data-quick-action="details">状态详情</button></footer>`;
    documentNode.body.append(node);
    const neutralGroup = node.querySelector?.('[data-status-neutral]');
    if (neutralGroup) neutralGroup.open = neutralOpen;
    node.scrollTop = scrollTop;
    const width = documentNode.defaultView?.innerWidth || 800;
    const height = documentNode.defaultView?.innerHeight || 600;
    const bounds = node.getBoundingClientRect?.() || { width: Math.min(356, width - 16), height: Math.min(570, height - 16) };
    const left = Number.isFinite(Number(nextPoint?.clientX)) ? Number(nextPoint.clientX) : (width - bounds.width) / 2;
    const top = Number.isFinite(Number(nextPoint?.clientY)) ? Number(nextPoint.clientY) : (height - bounds.height) / 2;
    node.style.left = `${Math.max(8, Math.min(width - bounds.width - 8, left))}px`;
    node.style.top = `${Math.max(8, Math.min(height - bounds.height - 8, top))}px`;
    return true;
  }

  async function cycle(definitionId) {
    if (pending) return;
    const openedTokenId = primaryTokenId;
    const tokens = targetTokens(primaryTokenId);
    const operations = planQuickStatusCycle(api, tokens, definitionId);
    if (!operations.length) return;
    const hud = documentNode.querySelector?.('[data-status-quick-hud]');
    pending = true;
    hud?.setAttribute?.('aria-busy', 'true');
    try {
      if (typeof api.world?.performOperations === 'function') {
        await api.world.performOperations(operations.map(({ type, ...payload }) => ({ type, payload })), {
          source: 'status:quick-hud', render: false, kind: 'status',
        });
      } else await api.status.applyBatch(operations);
      if (primaryTokenId === openedTokenId) render(openedTokenId);
    } finally {
      pending = false;
      hud?.removeAttribute?.('aria-busy');
    }
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

  function handleKeydown(event) {
    if (event.key !== 'Escape' || !primaryTokenId) return;
    event.preventDefault();
    close();
  }

  documentNode.addEventListener('click', handleClick);
  documentNode.addEventListener('keydown', handleKeydown);
  return Object.freeze({ open: render, close, destroy() { close(); documentNode.removeEventListener('click', handleClick); documentNode.removeEventListener('keydown', handleKeydown); } });
}
