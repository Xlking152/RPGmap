import { describeHealth, healthOperationPresentation } from './model.js';

const STYLE_ID = 'rpgmap-ruleset-health-instance-ui-style';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function installStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [data-marker-instance-drawer] [data-marker-instance-health] { display:none !important; }
    .marker-instance-row.ruleset-health-row { grid-template-columns:auto minmax(110px,1fr) !important; align-items:start !important; }
    .marker-instance-health-fields { grid-column:2/-1; display:grid; grid-template-columns:repeat(auto-fit,minmax(72px,1fr)); gap:6px; width:100%; }
    .marker-instance-health-field { display:grid; grid-template-columns:auto minmax(44px,1fr); align-items:center; gap:4px; min-width:0; font-size:10px; color:#617073; }
    .marker-instance-health-field > span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .marker-instance-health-field input { min-width:0; height:30px; padding:4px 6px !important; }
    .marker-instance-health-summary { grid-column:2/-1; color:#687477; }
    .marker-health-batch { display:grid; gap:6px; padding-top:2px; border-top:1px solid rgba(70,90,90,.12); }
    .marker-health-batch-row { display:grid; grid-template-columns:70px minmax(92px,1fr) auto; gap:6px; align-items:center; }
    .marker-health-batch-row input,.marker-health-batch-row select,.marker-health-batch-row button { min-width:0; height:32px; box-sizing:border-box; }
    .marker-health-batch-generic { display:flex; align-items:center; min-height:32px; padding:0 8px; box-sizing:border-box; border:1px solid #d4dcda; border-radius:6px; color:#6b7779; font-size:10px; background:#f7f9f7; }
    .marker-health-batch-help { font-size:9px; line-height:1.4; color:#778285; }
    @media(max-width:650px){ .marker-health-batch-row{grid-template-columns:64px minmax(80px,1fr) auto}.marker-instance-health-fields{grid-template-columns:repeat(2,minmax(0,1fr))} }
  `;
  documentNode.head.append(style);
}

function tokenById(api, tokenId) {
  const direct = api.tokens?.get?.(tokenId);
  if (direct) return direct;
  return (api.tokens?.list?.() || []).find(token => String(token?.id) === String(tokenId)) || null;
}

function healthPresentation(api, tokenId) {
  try {
    const state = api.health?.resolveToken?.(tokenId) || null;
    return state ? { state, view: describeHealth(state, { ruleset: api.ruleset }) } : null;
  } catch {
    return null;
  }
}

function editableFields(view) {
  const fields = Array.isArray(view?.compactFields) ? view.compactFields : view?.fields;
  return (Array.isArray(fields) ? fields : []).filter(field => field && typeof field.operation === 'function');
}

function fieldHtml(field, tokenId, disabled) {
  const min = Number.isFinite(Number(field.min)) ? ` min="${Number(field.min)}"` : '';
  const max = Number.isFinite(Number(field.max)) ? ` max="${Number(field.max)}"` : '';
  const step = Number.isFinite(Number(field.step)) ? Number(field.step) : 1;
  return `<span class="marker-instance-health-field"><span title="${escapeHtml(field.label || field.id)}">${escapeHtml(field.label || field.id)}</span><input type="number"${min}${max} step="${step}" value="${escapeHtml(field.value ?? 0)}" data-ruleset-health-field="${escapeHtml(field.id)}" data-token-id="${escapeHtml(tokenId)}" ${disabled ? 'disabled' : ''}></span>`;
}

function operationTypeControl(operation, ruleset) {
  const config = healthOperationPresentation(operation, { ruleset });
  const types = Array.isArray(config.types) ? config.types : [];
  const defaultType = String(config.defaultType ?? types[0]?.id ?? '');
  if (!types.length) {
    return {
      config,
      defaultType,
      html: '<span class="marker-health-batch-generic">通用</span>',
    };
  }
  const options = types.map(option => `<option value="${escapeHtml(option.id)}" ${String(option.id) === defaultType ? 'selected' : ''}>${escapeHtml(option.label || option.id)}</option>`).join('');
  return {
    config,
    defaultType,
    html: `<select data-ruleset-health-type="${escapeHtml(operation)}" aria-label="${escapeHtml(operation === 'damage' ? '伤害类型' : '恢复类型')}">${options}</select>`,
  };
}

function batchControlsHtml(ruleset) {
  const damage = operationTypeControl('damage', ruleset);
  const healing = operationTypeControl('healing', ruleset);
  return `<div class="marker-health-batch" data-ruleset-health-batch-controls>
    <div class="marker-health-batch-row"><input type="number" min="1" step="1" value="1" data-ruleset-health-amount="damage" aria-label="${escapeHtml(damage.config.inputPlaceholder || '伤害数量')}">${damage.html}<button type="button" class="small-button danger" data-ruleset-health-batch="damage" data-default-type="${escapeHtml(damage.defaultType)}">${escapeHtml(damage.config.batchLabel || '批量伤害')}</button></div>
    <div class="marker-health-batch-row"><input type="number" min="1" step="1" value="1" data-ruleset-health-amount="healing" aria-label="${escapeHtml(healing.config.inputPlaceholder || '恢复数量')}">${healing.html}<button type="button" class="small-button" data-ruleset-health-batch="healing" data-default-type="${escapeHtml(healing.defaultType)}">${escapeHtml(healing.config.batchLabel || '批量恢复')}</button></div>
    <div class="marker-health-batch-help">生命字段、摘要、伤害类型与恢复类型均来自当前 Ruleset 的 Health Presentation；此面板不识别或硬编码任何具体规则的生命体系。</div>
  </div>`;
}

function canControlToken(api, token) {
  const status = api.multiplayer?.getStatus?.();
  return !status?.connected || status.session?.role === 'gm'
    || api.multiplayer?.canControlToken?.(token.id) === true;
}

export function createHealthInstanceUi() {
  return {
    register(api) {
      if (!api.health || !api.selection) return;
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      const windowNode = documentNode.defaultView || globalThis;
      const markerPanel = api.uiPanels?.get?.('markers') || null;
      const mapHost = mapElement.parentElement || documentNode.body;
      installStyles(documentNode);

      let scheduled = false;
      let destroyed = false;
      const off = [];
      const observers = [];

      function selectedDrawerTokenIds(drawer) {
        return [...(drawer?.querySelectorAll?.('[data-marker-instance-check]:checked') || [])]
          .map(input => String(input.value || ''))
          .filter(Boolean);
      }

      function decorateInstanceDrawer() {
        const drawer = markerPanel?.querySelector?.('[data-marker-instance-drawer]');
        if (!drawer) return;

        for (const row of drawer.querySelectorAll('[data-marker-instance-row]')) {
          const tokenId = String(row.dataset.markerInstanceRow || '');
          const token = tokenById(api, tokenId);
          const presentation = healthPresentation(api, tokenId);
          if (!token || !presentation) continue;

          row.classList.add('ruleset-health-row');
          row.querySelectorAll('[data-marker-instance-health]').forEach(input => input.remove());
          const controlled = canControlToken(api, token);
          const fields = editableFields(presentation.view);
          const signature = JSON.stringify(fields.map(field => [field.id, field.label, field.value, field.min, field.max]));
          let host = row.querySelector('[data-ruleset-health-fields]');
          if (!host) {
            host = documentNode.createElement('span');
            host.className = 'marker-instance-health-fields';
            host.dataset.rulesetHealthFields = '';
            const detail = row.querySelector('small');
            row.insertBefore(host, detail || null);
          }
          if (host.dataset.signature !== signature) {
            host.dataset.signature = signature;
            host.innerHTML = fields.length
              ? fields.map(field => fieldHtml(field, tokenId, !controlled)).join('')
              : '<span class="marker-health-batch-generic">当前规则未提供可编辑生命字段</span>';
          }

          const detail = row.querySelector('small');
          if (detail) {
            if (!detail.dataset.rulesetHealthBase) detail.dataset.rulesetHealthBase = detail.textContent || '';
            detail.classList.add('marker-instance-health-summary');
            const prefix = [presentation.view.summary, presentation.view.status].filter(Boolean).join(' · ');
            const nextText = [prefix, detail.dataset.rulesetHealthBase].filter(Boolean).join(' · ');
            if (detail.textContent !== nextText) detail.textContent = nextText;
          }
        }

        if (!drawer.querySelector('[data-ruleset-health-batch-controls]')) {
          const toolbar = drawer.querySelector('.marker-instance-toolbar');
          toolbar?.insertAdjacentHTML('afterend', batchControlsHtml(api.ruleset));
        }
      }

      function decorateTokenSummary() {
        const summary = mapHost?.querySelector?.('.selected-token-summary');
        if (!summary || summary.hidden) return;
        const body = summary.querySelector('.selected-token-summary-body');
        if (!body) return;
        const tokenId = String(api.selection.getPrimaryTokenId?.() || api.selection.getSelectedTokenIds?.()?.[0] || '');
        if (!tokenId) return;
        const presentation = healthPresentation(api, tokenId);
        const spans = [...body.children].filter(child => child.tagName === 'SPAN');
        let healthLine = body.querySelector('[data-ruleset-health-summary]');
        for (const span of spans.slice(1)) {
          if (span !== healthLine) span.remove();
        }
        if (!presentation) {
          healthLine?.remove();
          return;
        }
        if (!healthLine) {
          healthLine = documentNode.createElement('span');
          healthLine.dataset.rulesetHealthSummary = '';
          body.append(healthLine);
        }
        const nextText = `生命 ${presentation.view.summary || '—'}`;
        if (healthLine.textContent !== nextText) healthLine.textContent = nextText;
      }

      function decorate() {
        scheduled = false;
        if (destroyed) return;
        decorateInstanceDrawer();
        decorateTokenSummary();
      }

      function scheduleDecorate() {
        if (scheduled || destroyed) return;
        scheduled = true;
        if (windowNode.requestAnimationFrame) windowNode.requestAnimationFrame(decorate);
        else windowNode.setTimeout(decorate, 0);
      }

      markerPanel?.addEventListener('change', async event => {
        const input = event.target.closest?.('[data-ruleset-health-field]');
        if (!input) return;
        const tokenId = String(input.dataset.tokenId || '');
        const token = tokenById(api, tokenId);
        const presentation = healthPresentation(api, tokenId);
        const field = editableFields(presentation?.view).find(item => String(item.id) === String(input.dataset.rulesetHealthField));
        if (!token || !field) return;
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        input.disabled = true;
        try {
          const operation = field.operation(value);
          await api.health.performActorOperation(token.actorId, operation, { tokenId });
          api.showToast?.(`${field.label || field.id} 已更新`, 'success');
        } catch (error) {
          api.showToast?.(error?.message || String(error), 'error');
        } finally {
          input.disabled = false;
          scheduleDecorate();
        }
      });

      markerPanel?.addEventListener('click', async event => {
        const button = event.target.closest?.('[data-ruleset-health-batch]');
        if (!button) return;
        event.preventDefault();
        const drawer = button.closest('[data-marker-instance-drawer]');
        const tokenIds = selectedDrawerTokenIds(drawer);
        if (!tokenIds.length) {
          api.showToast?.('请先勾选至少一个实例', 'error');
          return;
        }
        const operation = String(button.dataset.rulesetHealthBatch || '');
        const amount = Math.floor(Number(drawer.querySelector(`[data-ruleset-health-amount="${operation}"]`)?.value));
        const type = String(drawer.querySelector(`[data-ruleset-health-type="${operation}"]`)?.value || button.dataset.defaultType || '');
        if (!Number.isFinite(amount) || amount <= 0) {
          api.showToast?.('请输入大于 0 的生命变化数值', 'error');
          return;
        }
        button.disabled = true;
        try {
          const results = operation === 'damage'
            ? await api.health.applyDamageToTokenIds(tokenIds, { amount, type })
            : await api.health.applyHealingToTokenIds(tokenIds, { amount, type });
          const changed = (Array.isArray(results) ? results : []).filter(result => Number(result?.applied) > 0).length;
          api.showToast?.(`${operation === 'damage' ? '批量伤害' : '批量恢复'}已结算 · ${changed}/${tokenIds.length} 个实例发生变化`, 'success');
        } catch (error) {
          api.showToast?.(error?.message || String(error), 'error');
        } finally {
          button.disabled = false;
          scheduleDecorate();
        }
      });

      const MutationObserverCtor = windowNode.MutationObserver || globalThis.MutationObserver;
      if (MutationObserverCtor && markerPanel) {
        const observer = new MutationObserverCtor(scheduleDecorate);
        observer.observe(markerPanel, { childList: true, subtree: true });
        observers.push(observer);
      }
      if (MutationObserverCtor && mapHost) {
        const observer = new MutationObserverCtor(scheduleDecorate);
        observer.observe(mapHost, { childList: true, subtree: true });
        observers.push(observer);
      }

      const selectionOff = api.selection.subscribe?.(scheduleDecorate);
      if (selectionOff) off.push(selectionOff);
      for (const eventName of ['health:change', 'token:create', 'token:delete', 'state:import']) {
        const dispose = api.on?.(eventName, scheduleDecorate);
        if (dispose) off.push(dispose);
      }
      const destroyOff = api.on?.('app:destroy', () => {
        destroyed = true;
        observers.forEach(observer => observer.disconnect());
        off.splice(0).forEach(dispose => dispose?.());
      });
      if (destroyOff) off.push(destroyOff);
      scheduleDecorate();
    },
  };
}
