import { describeHealth, healthOperationPresentation } from './model.js';

const STYLE_ID = 'rpgmap-health-selection-hud-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[ch]);
}

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .selected-token-summary { display:none !important; }
    .rpgmap-health-selection-hud { position:absolute; right:12px; bottom:max(12px,env(safe-area-inset-bottom)); z-index:1610; width:min(340px,calc(100% - 24px)); box-sizing:border-box; border:1px solid rgba(38,60,62,.28); border-radius:10px; background:rgba(248,250,247,.97); box-shadow:0 10px 28px rgba(18,27,29,.24); padding:10px; display:grid; gap:9px; }
    .rpgmap-health-selection-hud[hidden] { display:none !important; }
    .health-selection-head { display:flex; align-items:flex-start; gap:8px; }
    .health-selection-head strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#263638; }
    .health-selection-count { padding:2px 6px; border-radius:999px; background:#e7efeb; color:#526164; font-size:10px; font-weight:800; white-space:nowrap; }
    .health-selection-summary { display:grid; gap:4px; font-size:11px; color:#58676a; line-height:1.45; }
    .health-selection-summary .danger { color:#a33d38; font-weight:800; }
    .health-selection-mode-row { display:flex; flex-wrap:wrap; gap:5px; }
    .health-selection-mode { padding:3px 6px; border-radius:6px; background:#eef3ef; color:#59676a; font-size:10px; font-weight:800; }
    .health-batch-form { display:grid; grid-template-columns:minmax(72px,.8fr) minmax(92px,1fr) 1fr; gap:6px; align-items:center; }
    .health-batch-form input,.health-batch-form select,.health-batch-form button { min-width:0; height:32px; box-sizing:border-box; border:1px solid #c9d4d0; border-radius:7px; padding:5px 7px; font:inherit; font-size:11px; }
    .health-batch-form button { cursor:pointer; font-weight:800; background:#fff; }
    .health-batch-form button[data-health-batch="damage"] { border-color:#c98e88; color:#963e38; background:#fff5f4; }
    .health-batch-form button[data-health-batch="healing"] { border-color:#86b798; color:#356f4b; background:#f2faf5; }
    .health-selection-help { color:#758184; font-size:9px; line-height:1.45; }
    @media(max-width:650px){ .rpgmap-health-selection-hud{right:8px;bottom:76px;width:min(320px,calc(100% - 16px))}.health-batch-form{grid-template-columns:72px 1fr}.health-batch-form button{grid-column:auto} }
  `;
  documentNode.head.append(style);
}

function tokenLabel(api, token) {
  try {
    const actor = api.tokens.resolveActor?.(token.id)?.actor;
    return String(token.name || actor?.name || token.id);
  } catch {
    return String(token?.name || token?.id || 'Token');
  }
}

function healthView(api, token) {
  const health = api.health?.resolveToken?.(token.id);
  if (!health) return null;
  return {
    token,
    health,
    view: describeHealth(health, { ruleset: api.ruleset }),
  };
}

function modeLabel(health) {
  if (health?.mode === 'wound-track') return 'B/L/A';
  if (health?.mode === 'simple') return '数值 HP';
  return '其他';
}

function operationTypeOptions(operation, ruleset) {
  const config = healthOperationPresentation(operation, { ruleset });
  return {
    config,
    html: (config.types || []).map(option => `<option value="${escapeHtml(option.id)}" ${String(option.id) === String(config.defaultType) ? 'selected' : ''}>${escapeHtml(option.label || option.id)}</option>`).join(''),
  };
}

export function createHealthSelectionHud() {
  return {
    register(api) {
      if (!api.selection || !api.health) return;
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const host = mapElement.parentElement || documentNode.body;
      installStyles(documentNode);
      if (host && documentNode.defaultView?.getComputedStyle?.(host).position === 'static') host.style.position = 'relative';

      const hud = documentNode.createElement('aside');
      hud.className = 'rpgmap-health-selection-hud';
      hud.hidden = true;
      host.append(hud);
      const off = [];

      function selectedTokens() {
        return (api.selection.getSelectedTokenIds?.() || [])
          .map(id => api.tokens.get?.(id))
          .filter(token => token?.placement === 'map' || token?.placement === 'feature');
      }

      function render() {
        const tokens = selectedTokens();
        const entries = tokens.map(token => healthView(api, token)).filter(Boolean);
        if (!tokens.length || !entries.length) {
          hud.hidden = true;
          hud.replaceChildren();
          return;
        }

        const modes = new Map();
        for (const entry of entries) {
          const label = modeLabel(entry.health);
          modes.set(label, (modes.get(label) || 0) + 1);
        }
        const modeHtml = [...modes.entries()]
          .map(([label, count]) => `<span class="health-selection-mode">${escapeHtml(label)} × ${count}</span>`)
          .join('');
        const damage = operationTypeOptions('damage', api.ruleset);
        const healing = operationTypeOptions('healing', api.ruleset);
        const single = entries.length === 1 ? entries[0] : null;
        const title = single ? tokenLabel(api, single.token) : `已选择 ${entries.length} 个实例`;
        const summary = single
          ? `<div>${escapeHtml(single.view.summary || '—')}</div><div class="${single.view.danger ? 'danger' : ''}">${escapeHtml(single.view.status || '')}</div>`
          : `<div>批量操作会对每个实例分别按自己的生命模式结算，不会把所有实例强制写成同一个绝对值。</div>`;

        hud.innerHTML = `
          <div class="health-selection-head"><strong>${escapeHtml(title)}</strong><span class="health-selection-count">${entries.length} Token</span></div>
          <div class="health-selection-summary">${summary}</div>
          <div class="health-selection-mode-row">${modeHtml}</div>
          <form class="health-batch-form" data-health-batch-form>
            <input type="number" min="1" step="1" value="1" aria-label="生命变化数量" data-health-amount>
            <select aria-label="伤害类型" data-health-type>${damage.html || healing.html}</select>
            <button type="submit" data-health-batch="damage">批量伤害</button>
            <button type="submit" data-health-batch="healing">批量恢复</button>
          </form>
          <div class="health-selection-help">B/L/A 实例显示并结算 B、L、A 伤势槽；数值 HP 实例继续使用 current/max。混合选择时同一次操作会由各自 Ruleset Health Runtime 分别处理。</div>`;
        hud.hidden = false;
      }

      hud.addEventListener('click', async event => {
        const button = event.target.closest?.('[data-health-batch]');
        if (!button) return;
        event.preventDefault();
        const form = button.closest('[data-health-batch-form]');
        const amount = Math.floor(Number(form?.querySelector('[data-health-amount]')?.value));
        const type = String(form?.querySelector('[data-health-type]')?.value || '');
        if (!Number.isFinite(amount) || amount <= 0) {
          api.setStatus?.('批量生命修改：请输入大于 0 的数值');
          return;
        }
        const ids = selectedTokens().map(token => String(token.id));
        if (!ids.length) return;
        button.disabled = true;
        try {
          const results = button.dataset.healthBatch === 'damage'
            ? await api.health.applyDamageToTokenIds?.(ids, { amount, type })
            : await api.health.applyHealingToTokenIds?.(ids, { amount, type });
          const changed = Array.isArray(results) ? results.length : 0;
          api.setStatus?.(`${button.dataset.healthBatch === 'damage' ? '批量伤害' : '批量恢复'}已应用 · ${changed} 个实例`);
          render();
        } catch (error) {
          api.setStatus?.(`批量生命修改失败：${error?.message || error}`);
        } finally {
          button.disabled = false;
        }
      });

      const selectionOff = api.selection.subscribe?.(render);
      if (selectionOff) off.push(selectionOff);
      for (const eventName of ['health:change', 'token:create', 'token:delete', 'state:import']) {
        off.push(api.on?.(eventName, render));
      }
      off.push(api.on?.('app:destroy', () => {
        off.splice(0).forEach(dispose => dispose?.());
        hud.remove();
      }));
      render();
    },
  };
}
