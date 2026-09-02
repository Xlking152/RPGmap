import { STATUS_ICON_NAMES } from './model.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeColor(value, fallback = '#59686b') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function option(value, expected, label) {
  return `<option value="${expected}" ${String(value) === expected ? 'selected' : ''}>${label}</option>`;
}

function changesText(changes = []) {
  return (Array.isArray(changes) ? changes : []).map(change => `${String(change?.target || '').trim()} | ${String(change?.mode || 'add').trim()} | ${Number(change?.value) || 0}`).join('\n');
}

export function renderStatusDefinitionEditor(definition = null) {
  const current = definition || {};
  const capabilities = current.capabilities || {};
  const isEdit = Boolean(current.id);
  const category = ['buff', 'debuff'].includes(String(current.category)) ? String(current.category) : 'neutral';
  const duration = current.defaultDuration || null;
  const scopes = new Set(Array.isArray(current.scopes) ? current.scopes.map(String) : ['actor']);
  const icons = [...STATUS_ICON_NAMES];
  const selectedIcon = STATUS_ICON_NAMES.has(String(current.icon || '').toLowerCase()) ? String(current.icon).toLowerCase() : 'circle-dot';
  const capability = (name, value) => `<select name="${name}">${option(value, '', '继承默认')}${option(value, 'true', '允许')}${option(value, 'false', '禁止')}</select>`;
  return `<div class="status-definition-backdrop" data-status-definition-editor><form class="status-definition-dialog" data-status-definition-form data-status-definition-id="${escapeHtml(current.id || '')}" role="dialog" aria-modal="true">
    <header><div><h2>${isEdit ? '编辑自定义状态' : '新建自定义状态'}</h2><p>只保存白名单字段和机械能力；不会执行脚本。</p></div><button type="button" class="small-button" data-status-action="definition-close">关闭</button></header>
    <div class="status-definition-grid"><label>稳定 ID<input name="id" maxlength="160" value="${escapeHtml(current.id || '')}" ${isEdit ? 'readonly' : ''} required></label><label>显示名称<input name="name" maxlength="120" value="${escapeHtml(current.label || current.name || '')}" required></label><label>分类<select name="category"><option value="neutral" ${category === 'neutral' ? 'selected' : ''}>中性</option><option value="buff" ${category === 'buff' ? 'selected' : ''}>Buff</option><option value="debuff" ${category === 'debuff' ? 'selected' : ''}>Debuff</option></select></label><label>Lucide 图标<select name="icon">${icons.map(name => `<option value="${name}" ${selectedIcon === name ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label>颜色<input name="color" type="color" value="${safeColor(current.color)}"></label><label>最大叠加层数<input name="maxStacks" type="number" min="1" max="99" value="${Math.max(1, Number(current.maxStacks) || 1)}"></label><label>默认持续时间<select name="defaultDurationUnit"><option value="">永久</option><option value="turns" ${duration?.unit === 'turns' ? 'selected' : ''}>回合</option><option value="rounds" ${duration?.unit === 'rounds' ? 'selected' : ''}>轮</option></select></label><label>持续数量<input name="defaultDurationValue" type="number" min="1" max="10000" value="${duration?.value || ''}" placeholder="永久时留空"></label></div>
    <label>说明<textarea name="description" maxlength="4000" rows="2">${escapeHtml(current.description || '')}</textarea></label>
    <fieldset><legend>可作用范围</legend><label><input type="checkbox" name="scopes" value="actor" ${scopes.has('actor') ? 'checked' : ''}> Actor</label><label><input type="checkbox" name="scopes" value="token" ${scopes.has('token') ? 'checked' : ''}> Token</label></fieldset>
    <fieldset class="status-capability-grid"><legend>机械能力</legend><label>移动 ${capability('canMove', capabilities.canMove == null ? '' : String(capabilities.canMove))}</label><label>互动 ${capability('canInteract', capabilities.canInteract == null ? '' : String(capabilities.canInteract))}</label><label>战斗行动 ${capability('canActInCombat', capabilities.canActInCombat == null ? '' : String(capabilities.canActInCombat))}</label><label>视野精度 <select name="visionPrecision"><option value="">继承默认</option><option value="vague" ${capabilities.visionPrecision === 'vague' ? 'selected' : ''}>仅模糊</option></select></label><label><input type="checkbox" name="collisionBypassStructure" ${capabilities.collisionBypassGroups?.includes?.('structure') ? 'checked' : ''}> 可穿越建筑阻挡</label></fieldset>
    <label>数值变化<textarea name="changes" rows="3">${escapeHtml(changesText(current.changes))}</textarea><small>Token 范围不能包含数值变化。</small></label>
    <footer><button type="button" class="small-button" data-status-action="definition-close">取消</button><button type="submit" class="small-button primary">保存并等待服务器确认</button></footer>
  </form></div>`;
}
