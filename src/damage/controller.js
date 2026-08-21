import {
  DAMAGE_AGGRAVATED,
  DAMAGE_BASHING,
  DAMAGE_LETHAL,
  HEALTH_MODE_WOUND_TRACK,
  damageTypeLabel,
  formatHealthSummary,
  healthStatusLabel,
} from '../health/model.js';

const STYLE_ID = 'rpgmap-damage-system-style';

function installStyles(documentNode) {
  if (documentNode.getElementById(STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .rpgmap-damage-tool { border:1px solid rgba(130,72,62,.24); border-radius:9px; padding:8px; background:#fff8f6; display:grid; gap:7px; }
    .rpgmap-damage-head { display:flex; justify-content:space-between; gap:8px; align-items:center; }
    .rpgmap-damage-head strong { font-size:12px; color:#74443d; }
    .rpgmap-damage-target { font-size:10px; color:#7c7774; }
    .rpgmap-damage-fields { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
    .rpgmap-damage-fields label { display:grid; gap:3px; font-size:10px; color:#6f6663; }
    .rpgmap-damage-tool button { width:100%; }
    .rpgmap-damage-note { font-size:10px; line-height:1.4; color:#897b77; }
  `;
  documentNode.head.append(style);
}

function stateWarnings(state) {
  if (!state) return [];
  const warnings = [];
  if (state.dead) warnings.push('死亡');
  else if (state.unconscious) warnings.push('昏迷');
  if (state.deteriorating) warnings.push('伤势恶化');
  return warnings;
}

export function createDamageController({ selection } = {}) {
  return {
    register(api) {
      const mapElement = api.map.getContainer();
      const documentNode = mapElement.ownerDocument || document;
      installStyles(documentNode);

      const tools = documentNode.querySelector('[data-chat-tools]');
      if (!tools) return;

      const form = documentNode.createElement('form');
      form.className = 'rpgmap-damage-tool';
      form.dataset.damageTool = '1';
      form.innerHTML = `
        <div class="rpgmap-damage-head"><strong>应用伤害</strong><span class="rpgmap-damage-target" data-damage-target>未选择 Token</span></div>
        <div class="rpgmap-damage-fields">
          <label>伤害值<input type="number" min="0" step="1" value="1" data-damage-amount></label>
          <label>伤害级别<select data-damage-type><option value="${DAMAGE_BASHING}">冲击 B</option><option value="${DAMAGE_LETHAL}" selected>严重 L</option><option value="${DAMAGE_AGGRAVATED}">恶性 A</option></select></label>
        </div>
        <button type="submit" class="small-button danger" data-damage-apply>应用到所选角色</button>
        <div class="rpgmap-damage-note">这里只结算最终伤害进入生命槽；盔甲、硬度、DR、免疫、临时生命等前置步骤仍由操作者处理。</div>`;
      tools.append(form);

      const targetNode = form.querySelector('[data-damage-target]');
      const applyButton = form.querySelector('[data-damage-apply]');
      const selectedIds = () => selection?.getSelectedTokenIds?.() || api.selection?.getSelectedTokenIds?.() || [];

      function renderTarget() {
        const ids = selectedIds();
        targetNode.textContent = ids.length ? `已选 ${ids.length} 个 Token` : '未选择 Token';
        applyButton.disabled = !ids.length;
      }

      form.addEventListener('submit', event => {
        event.preventDefault();
        const ids = selectedIds();
        if (!ids.length) return;
        const amount = Math.max(0, Math.floor(Number(form.querySelector('[data-damage-amount]')?.value) || 0));
        const type = form.querySelector('[data-damage-type]')?.value || DAMAGE_LETHAL;
        if (!amount) return;
        const results = api.health?.applyDamageToTokenIds?.(ids, { amount, type }) || [];
        for (const result of results) {
          const before = formatHealthSummary(result.before);
          const after = formatHealthSummary(result.after);
          const modeText = result.after?.mode === HEALTH_MODE_WOUND_TRACK ? damageTypeLabel(type) : '普通 HP';
          const warnings = stateWarnings(result.after);
          api.chat?.addDamage?.(`${result.actorName} 受到 ${amount} 点${modeText === '普通 HP' ? '伤害' : ` ${modeText} 伤害`}`, {
            actorId: result.actorId,
            tokenId: result.tokenId,
            amount,
            type,
            applied: result.applied,
            overflow: result.overflow,
            damageLabel: `实际结算 ${result.applied} 点${warnings.length ? ` · ${warnings.join(' · ')}` : ''}`,
            beforeLabel: before,
            afterLabel: `${after} · ${healthStatusLabel(result.after)}`,
          });
        }
        if (!results.length) api.chat?.addSystem?.('未找到可应用伤害的所选 Actor。');
      });

      selection?.subscribe?.(renderTarget);
      api.on('state:import', renderTarget);
      renderTarget();
    },
  };
}
