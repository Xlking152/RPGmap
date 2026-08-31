import { worldToLatLng } from '../engine/geometry.js';
import { tokenDiameterMeters } from '../elevation/model.js';
import {
  Activity, Anchor, Ban, Bomb, Building2, CircleAlert, CircleDot, CircleSlash,
  DoorClosed, Droplet, Eye, EyeOff, Flame, Footprints, Ghost, HeartPulse,
  LockKeyhole, Moon, Shield, ShieldAlert, Skull, Snowflake, Sparkles, Swords,
  Star, TriangleAlert, UnlockKeyhole, Waves,
} from 'lucide';

const STATUS_STYLE_ID = 'rpgmap-status-ui-style';

const CATEGORY_LABELS = Object.freeze({
  buff: 'Buff',
  debuff: 'Debuff',
  trait: '特征',
  status: '状态',
  condition: '状态',
  derived: '派生',
});

const IMPORTANT_STATUS_PATTERNS = Object.freeze([
  { pattern: /dead|death|死亡/i, priority: 500, glyph: '死' },
  { pattern: /unconscious|昏迷/i, priority: 450, glyph: '昏' },
  { pattern: /incapacitated|失能/i, priority: 400, glyph: '失' },
  { pattern: /immobil|root|定身/i, priority: 350, glyph: '定' },
  { pattern: /phase|ghost|灵体/i, priority: 300, glyph: '灵' },
]);

const LUCIDE_STATUS_ICONS = Object.freeze({
  activity: Activity,
  anchor: Anchor,
  ban: Ban,
  bomb: Bomb,
  building: Building2,
  'building-2': Building2,
  'circle-alert': CircleAlert,
  'circle-dot': CircleDot,
  'circle-slash': CircleSlash,
  'door-closed': DoorClosed,
  droplet: Droplet,
  eye: Eye,
  'eye-off': EyeOff,
  flame: Flame,
  footprints: Footprints,
  ghost: Ghost,
  'heart-pulse': HeartPulse,
  lock: LockKeyhole,
  'lock-keyhole': LockKeyhole,
  moon: Moon,
  shield: Shield,
  'shield-alert': ShieldAlert,
  skull: Skull,
  snowflake: Snowflake,
  sparkles: Sparkles,
  star: Star,
  swords: Swords,
  'triangle-alert': TriangleAlert,
  unlock: UnlockKeyhole,
  'unlock-keyhole': UnlockKeyhole,
  waves: Waves,
});
const LUCIDE_STATUS_ICON_NAMES = Object.freeze(Object.keys(LUCIDE_STATUS_ICONS));

export function escapeStatusHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeColor(value, fallback = '#59686b') {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function statusIdentity(status) {
  return String(status?.definitionId || status?.statusId || status?.id || '');
}

export function statusPriority(status) {
  const text = `${statusIdentity(status)} ${status?.label || status?.name || ''}`;
  return IMPORTANT_STATUS_PATTERNS.find(entry => entry.pattern.test(text))?.priority || 0;
}

export function statusGlyph(status) {
  const text = `${statusIdentity(status)} ${status?.icon || ''} ${status?.label || status?.name || ''}`;
  const important = IMPORTANT_STATUS_PATTERNS.find(entry => entry.pattern.test(text));
  if (important) return important.glyph;
  const label = String(status?.label || status?.name || status?.icon || '?').trim();
  return Array.from(label)[0] || '?';
}

function iconAttribute(value) {
  return escapeStatusHtml(String(value ?? ''));
}

function statusIconHtml(status) {
  const name = String(status?.icon || '').trim().toLowerCase();
  const icon = LUCIDE_STATUS_ICONS[name];
  if (!icon) return escapeStatusHtml(statusGlyph(status));
  const children = icon.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes || {})
    .map(([key, value]) => `${key}="${iconAttribute(value)}"`).join(' ')}></${tag}>`).join('');
  return `<svg class="status-lucide" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

export function sortStatuses(statuses = [], { includeDisabled = false } = {}) {
  return [...statuses]
    .filter(status => status && (includeDisabled || status.enabled !== false))
    .sort((left, right) => statusPriority(right) - statusPriority(left)
      || String(left.label || left.name || '').localeCompare(String(right.label || right.name || ''), 'zh-CN'));
}

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== 'object') return null;
  const id = String(definition.id || definition.definitionId || '');
  if (!id) return null;
  const scopes = Array.isArray(definition.scopes)
    ? definition.scopes.map(String)
    : Array.isArray(definition.allowedScopes)
      ? definition.allowedScopes.map(String)
      : definition.scope ? [String(definition.scope)] : ['actor', 'token'];
  return {
    ...definition,
    id,
    label: String(definition.label || definition.name || id),
    description: String(definition.description || ''),
    icon: String(definition.icon || 'circle-dot'),
    color: safeColor(definition.color),
    category: String(definition.category || 'status'),
    maxStacks: Math.max(1, Math.min(99, Math.floor(Number(definition.maxStacks) || 1))),
    scopes,
    builtIn: Boolean(definition.builtIn ?? definition.builtin ?? definition.system),
  };
}

export function statusDefinitions(api) {
  try {
    const result = api?.status?.getDefinitions?.();
    if (result && typeof result.then === 'function') return [];
    const values = Array.isArray(result) ? result : Array.isArray(result?.definitions) ? result.definitions : [];
    return values.map(normalizeDefinition).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeResolvedStatus(status, definitions, fallbackScope = 'actor', derived = false) {
  if (!status || typeof status !== 'object') return null;
  const definitionId = statusIdentity(status);
  const definition = definitions.get(definitionId) || null;
  const id = String(status.id || `${fallbackScope}:${definitionId}`);
  if (!definitionId && !id) return null;
  return {
    ...(definition || {}),
    ...status,
    id,
    definitionId: definitionId || id,
    label: String(status.label || status.name || definition?.label || definitionId || id),
    description: String(status.description || definition?.description || ''),
    icon: String(status.icon || definition?.icon || 'circle-dot'),
    color: safeColor(status.color || definition?.color),
    category: String(status.category || definition?.category || (derived ? 'derived' : 'condition')),
    stacks: Math.max(1, Math.min(99, Math.floor(Number(status.stacks) || 1))),
    maxStacks: Math.max(1, Math.min(99, Math.floor(Number(status.maxStacks || definition?.maxStacks) || 1))),
    scope: String(status.scope || fallbackScope),
    targetId: status.targetId == null ? null : String(status.targetId),
    derived: Boolean(status.derived ?? derived),
    enabled: status.enabled !== false,
  };
}

export function resolveStatusUiSnapshot(api, context = {}) {
  const definitions = statusDefinitions(api);
  const definitionMap = new Map(definitions.map(definition => [definition.id, definition]));
  let raw = null;
  try {
    raw = api?.status?.resolve?.(context) || null;
    if (raw && typeof raw.then === 'function') raw = null;
  } catch {
    raw = null;
  }
  const normalizeList = (values, scope, derived = false) => (Array.isArray(values) ? values : [])
    .map(status => normalizeResolvedStatus(status, definitionMap, scope, derived)).filter(Boolean);
  let actorStatuses = normalizeList(raw?.actorStatuses, 'actor');
  let tokenStatuses = normalizeList(raw?.tokenStatuses, 'token');
  let derivedStatuses = normalizeList(raw?.derivedStatuses, 'derived', true);
  if (!actorStatuses.length && !tokenStatuses.length && !derivedStatuses.length) {
    const combined = normalizeList(Array.isArray(raw) ? raw : raw?.statuses, 'actor');
    actorStatuses = combined.filter(status => !status.derived && status.scope !== 'token');
    tokenStatuses = combined.filter(status => !status.derived && status.scope === 'token');
    derivedStatuses = combined.filter(status => status.derived);
  }
  const statuses = sortStatuses([...actorStatuses, ...tokenStatuses, ...derivedStatuses]);
  let resolvedCapabilities = raw?.capabilities || null;
  if (!resolvedCapabilities) {
    try { resolvedCapabilities = api?.status?.resolveCapabilities?.(context) || null; } catch { resolvedCapabilities = null; }
  }
  return {
    definitions,
    statuses,
    actorStatuses: sortStatuses(actorStatuses, { includeDisabled: true }),
    tokenStatuses: sortStatuses(tokenStatuses, { includeDisabled: true }),
    derivedStatuses: sortStatuses(derivedStatuses),
    capabilities: resolvedCapabilities || {},
    statusVersion: raw?.statusVersion || 0,
  };
}

function statusTitle(status) {
  const pieces = [status.label];
  if (status.enabled === false) pieces.push('已停用');
  if (status.stacks > 1) pieces.push(`${status.stacks} 层`);
  if (status.note) pieces.push(`备注：${status.note}`);
  if (status.description) pieces.push(status.description);
  if (status.derived) pieces.push('由 Actor 数据自动派生');
  return pieces.join(' · ');
}

export function renderStatusStrip(statuses, { limit = Infinity, emptyText = '', className = '' } = {}) {
  const sorted = sortStatuses(statuses);
  if (!sorted.length) return emptyText ? `<span class="status-empty-inline">${escapeStatusHtml(emptyText)}</span>` : '';
  const shown = sorted.slice(0, limit);
  const remaining = Math.max(0, sorted.length - shown.length);
  return `<span class="status-strip ${escapeStatusHtml(className)}">${shown.map(status => `
    <span class="status-chip${status.derived ? ' derived' : ''}" style="--status-color:${safeColor(status.color)}" title="${escapeStatusHtml(statusTitle(status))}">
      <span class="status-chip-icon" aria-hidden="true">${statusIconHtml(status)}</span>
      <span class="status-chip-label">${escapeStatusHtml(status.label)}</span>
      ${status.stacks > 1 ? `<b class="status-chip-stacks">${status.stacks}</b>` : ''}
    </span>`).join('')}${remaining ? `<span class="status-chip status-overflow" title="另有 ${remaining} 个状态">+${remaining}</span>` : ''}</span>`;
}

export function renderTokenStatusBadges(statuses, { limit = 4 } = {}) {
  const sorted = sortStatuses(statuses);
  if (!sorted.length) return '';
  const safeLimit = Math.max(1, Math.min(4, Math.floor(Number(limit) || 4)));
  const shown = sorted.slice(0, safeLimit);
  const remaining = Math.max(0, sorted.length - shown.length);
  const label = sorted.map(statusTitle).join('、');
  return `<span class="token-status-badges" role="img" aria-label="${escapeStatusHtml(label)}">${shown.map(status => `
    <span class="token-status-badge${status.derived ? ' derived' : ''}" style="--status-color:${safeColor(status.color)}" title="${escapeStatusHtml(statusTitle(status))}">
      <span aria-hidden="true">${statusIconHtml(status)}</span>${status.stacks > 1 ? `<b>${status.stacks}</b>` : ''}
    </span>`).join('')}${remaining ? `<span class="token-status-badge token-status-overflow" title="另有 ${remaining} 个状态">+${remaining}</span>` : ''}</span>`;
}

export function canManageStatuses(api) {
  const capabilities = api?.multiplayer?.getCapabilities?.();
  if (!capabilities) return true;
  if (capabilities.connected === false) return true;
  if (Object.prototype.hasOwnProperty.call(capabilities, 'canManageStatuses')) return capabilities.canManageStatuses === true;
  const multiplayer = api?.multiplayer?.getStatus?.();
  if (multiplayer?.connected) return multiplayer.session?.role === 'gm';
  return capabilities.canManageStructure !== false;
}

export function canManageStatusDefinitions(api) {
  const capabilities = api?.multiplayer?.getCapabilities?.();
  if (!capabilities || capabilities.connected === false) return true;
  if (Object.prototype.hasOwnProperty.call(capabilities, 'canManageStatusDefinitions')) {
    return capabilities.canManageStatusDefinitions === true;
  }
  const multiplayer = api?.multiplayer?.getStatus?.();
  if (multiplayer?.connected) return multiplayer.session?.role === 'gm';
  return capabilities.canManageStructure !== false;
}

function statusMutationKey(scope, targetId, definitionId) {
  return `${scope}:${targetId}:${definitionId}`;
}

function statusCards(statuses, { canManage, pendingKeys, scope, targetId } = {}) {
  if (!statuses.length) return '<div class="status-empty">暂无状态</div>';
  return `<div class="status-card-list">${statuses.map(status => {
    const actualScope = status.scope === 'token' ? 'token' : scope;
    const actualTarget = status.targetId || targetId;
    const key = statusMutationKey(actualScope, actualTarget, status.definitionId);
    const pending = pendingKeys?.has(key);
    const controls = canManage && !status.derived ? `<span class="status-card-controls">
      <button type="button" class="small-button" data-status-action="decrement" data-status-scope="${escapeStatusHtml(actualScope)}" data-status-target="${escapeStatusHtml(actualTarget)}" data-status-definition="${escapeStatusHtml(status.definitionId)}" data-status-stacks="${status.stacks}" ${pending ? 'disabled' : ''}>−</button>
      <b>${status.stacks}</b>
      <button type="button" class="small-button" data-status-action="increment" data-status-scope="${escapeStatusHtml(actualScope)}" data-status-target="${escapeStatusHtml(actualTarget)}" data-status-definition="${escapeStatusHtml(status.definitionId)}" data-status-stacks="${status.stacks}" data-status-max="${status.maxStacks}" ${pending || status.stacks >= status.maxStacks ? 'disabled' : ''}>+</button>
      <button type="button" class="small-button" data-status-action="toggle" data-status-scope="${escapeStatusHtml(actualScope)}" data-status-target="${escapeStatusHtml(actualTarget)}" data-status-definition="${escapeStatusHtml(status.definitionId)}" data-status-stacks="${status.stacks}" data-status-enabled="${status.enabled !== false}" ${pending ? 'disabled' : ''}>${status.enabled === false ? '启用' : '停用'}</button>
      <button type="button" class="small-button" data-status-action="note" data-status-scope="${escapeStatusHtml(actualScope)}" data-status-target="${escapeStatusHtml(actualTarget)}" data-status-definition="${escapeStatusHtml(status.definitionId)}" data-status-stacks="${status.stacks}" data-status-note="${escapeStatusHtml(status.note || '')}" ${pending ? 'disabled' : ''}>备注</button>
      <button type="button" class="small-button danger" data-status-action="remove" data-status-scope="${escapeStatusHtml(actualScope)}" data-status-target="${escapeStatusHtml(actualTarget)}" data-status-definition="${escapeStatusHtml(status.definitionId)}" ${pending ? 'disabled' : ''}>移除</button>
    </span>` : `<small class="status-readonly">${status.derived ? '自动派生' : '仅 GM 可修改'}</small>`;
    return `<article class="status-card${pending ? ' pending' : ''}${status.enabled === false ? ' disabled' : ''}" style="--status-color:${safeColor(status.color)}">
      <span class="status-card-icon" aria-hidden="true">${statusIconHtml(status)}</span>
      <span class="status-card-copy"><strong>${escapeStatusHtml(status.label)}${status.enabled === false ? ' · 已停用' : ''}</strong><small>${escapeStatusHtml(CATEGORY_LABELS[status.category] || status.category)}${status.description ? ` · ${escapeStatusHtml(status.description)}` : ''}${status.note ? ` · 备注：${escapeStatusHtml(status.note)}` : ''}</small>${pending ? '<em>正在等待服务器确认…</em>' : ''}</span>
      ${controls}
    </article>`;
  }).join('')}</div>`;
}

function definitionOptions(definitions, scope) {
  const values = definitions.filter(definition => definition.scopes.includes(scope));
  return values.length
    ? values.map(definition => `<option value="${escapeStatusHtml(definition.id)}">${escapeStatusHtml(definition.label)}</option>`).join('')
    : '<option value="">暂无可用状态</option>';
}

export function renderActorStatusSheet({ api, actor, tokens = [], allTokens = tokens, selectedTokenIds = [], canManage = false, canManageDefinitions = false, pendingKeys = new Set() } = {}) {
  const actorSnapshot = resolveStatusUiSnapshot(api, { actorId: actor?.id });
  const independent = ['npc', 'summon'].includes(String(actor?.type || ''));
  const selectedIds = new Set((selectedTokenIds || []).map(String));
  const selectedTargets = (allTokens || []).filter(token => selectedIds.has(String(token?.id)));
  const tokenRows = tokens.map(token => {
    const snapshot = resolveStatusUiSnapshot(api, { actorId: actor?.id, tokenId: token.id });
    const synthetic = token.actorLink === false;
    const syntheticRows = synthetic
      ? `<section class="entity-section status-target-section"><h3>独立角色实例 · 棋子 ${escapeStatusHtml(token.id)}</h3>${statusCards(snapshot.actorStatuses, { canManage, pendingKeys, scope: 'syntheticActor', targetId: token.id })}${statusCards(snapshot.derivedStatuses, { canManage: false, pendingKeys, scope: 'syntheticActor', targetId: token.id })}</section>`
      : '';
    return `${syntheticRows}<section class="entity-section status-target-section"><h3>Token · ${escapeStatusHtml(token.id)}</h3>${statusCards(snapshot.tokenStatuses, { canManage, pendingKeys, scope: 'token', targetId: token.id })}</section>`;
  }).join('');
  const definitions = actorSnapshot.definitions;
  const selectedActorIds = [...new Set(selectedTargets.map(token => String(token?.actorId || '')).filter(Boolean))];
  const selectedActorTargets = tokens.filter(token => selectedIds.has(String(token?.id)));
  const defaultTargets = selectedActorTargets.length ? selectedActorTargets : tokens.slice(0, 1);
  const pendingDefinition = [...pendingKeys].some(key => key.startsWith('definition:'));
  const pendingStatus = [...pendingKeys].some(key => key.startsWith('actor:') || key.startsWith('token:') || key.startsWith('syntheticActor:'));
  const palette = canManage ? `<section class="entity-section status-palette">
    <h3>GM 状态管理</h3>
    <div class="status-palette-row">
      <label>作用范围 <select data-status-palette-scope>${independent ? '<option value="token">Token 实例（支持批量）</option>' : `<option value="actor">Actor（所有 Linked Token）</option>${tokens.length ? '<option value="token">Token（支持批量）</option>' : ''}`}</select></label>
      <label>操作 <select data-status-palette-mode><option value="apply">施加 / 叠加</option><option value="remove">移除</option></select></label>
      <label>状态 <select data-status-palette-definition data-status-actor-options="${escapeStatusHtml(definitionOptions(definitions, 'actor'))}" data-status-token-options="${escapeStatusHtml(definitionOptions(definitions, independent ? 'actor' : 'token'))}">${definitionOptions(definitions, 'actor')}</select></label>
      <label>层数 <input type="number" min="1" max="99" value="1" data-status-palette-stacks></label>
      <button type="button" class="small-button primary" data-status-action="palette-submit" data-status-actor="${escapeStatusHtml(actor?.id)}" ${pendingStatus || !definitions.length ? 'disabled' : ''}>${pendingStatus ? '正在等待服务器确认…' : '提交并等待确认'}</button>
    </div>
    <label class="status-map-selection" data-status-palette-actor-wrap ${independent ? 'hidden' : ''}><input type="checkbox" data-status-use-actor-map-selection ${selectedActorIds.length ? '' : 'disabled'}> 使用地图当前选中的 ${selectedActorIds.length} 个 Actor${selectedActorIds.length > 1 ? '（批量）' : ''}</label>
    <div class="status-token-targets" data-status-palette-token-wrap ${independent ? '' : 'hidden'}>
      <strong>Token 目标</strong>
      ${tokens.length ? `<div class="status-token-checklist">${tokens.map(token => `<label><input type="checkbox" data-status-token-target value="${escapeStatusHtml(token.id)}" ${defaultTargets.includes(token) ? 'checked' : ''}>${escapeStatusHtml(token.id)}</label>`).join('')}</div>` : '<small>当前 Actor 没有 Token。</small>'}
      <label class="status-map-selection"><input type="checkbox" data-status-use-map-selection ${selectedTargets.length ? 'checked' : 'disabled'}> 使用地图当前选中的 ${selectedTargets.length} 个 Token${selectedTargets.length > 1 ? '（批量）' : ''}</label>
    </div>
    ${canManageDefinitions ? `<div class="status-definition-actions"><button type="button" class="small-button" data-status-action="definition-new" ${pendingDefinition ? 'disabled' : ''}>+ 自定义状态</button><small>自定义状态只允许白名单机械能力，不执行脚本。</small></div>` : ''}
    ${canManageDefinitions && definitions.filter(definition => !definition.builtIn).length ? `<details><summary>管理自定义定义</summary><div class="status-definition-list">${definitions.filter(definition => !definition.builtIn).map(definition => {
      const pending = pendingKeys.has(`definition:${definition.id}`);
      return `<div class="${pending ? 'pending' : ''}"><span>${escapeStatusHtml(definition.label)}${pending ? ' · 等待确认…' : ''}</span><button type="button" class="small-button" data-status-action="definition-edit" data-status-definition="${escapeStatusHtml(definition.id)}" ${pending ? 'disabled' : ''}>编辑</button><button type="button" class="small-button danger" data-status-action="definition-delete" data-status-definition="${escapeStatusHtml(definition.id)}" ${pending ? 'disabled' : ''}>删除</button></div>`;
    }).join('')}</div></details>` : ''}
  </section>` : '<section class="entity-section"><p class="entity-help">状态为服务器权威数据。当前会话只读，只有 GM 可以施加、调整或移除机械状态。</p></section>';
  return `${palette}<section class="entity-section status-target-section"><h3>${independent ? '模板初始状态 · 实例只读继承' : 'Actor 状态 · 影响 Linked Token'}</h3>${statusCards(actorSnapshot.actorStatuses, { canManage: canManage && !independent, pendingKeys, scope: 'actor', targetId: actor?.id })}</section>${tokenRows || '<section class="entity-section"><h3>Token 状态</h3><div class="status-empty">当前 Actor 尚未放置 Token。</div></section>'}<section class="entity-section status-target-section"><h3>派生状态 · 由生命与不良状态自动计算</h3>${statusCards(actorSnapshot.derivedStatuses, { canManage: false, pendingKeys, scope: 'actor', targetId: actor?.id })}</section>`;
}

export function parseStatusDefinitionChanges(value) {
  const modes = new Set(['add', 'set', 'multiply', 'min', 'max']);
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
    const [targetPart, modePart = 'add', valuePart] = line.split('|').map(part => part.trim());
    const mode = modePart || 'add';
    const numericValue = Number(valuePart);
    if (!targetPart || !modes.has(mode) || !Number.isFinite(numericValue)) throw new Error(`数值变化第 ${index + 1} 行无效；请使用“目标 | 方式 | 数值”。`);
    return { target: targetPart, mode, value: numericValue };
  });
}

function capabilityOption(value, expected, label) {
  return `<option value="${expected}" ${String(value) === expected ? 'selected' : ''}>${label}</option>`;
}

function definitionChangesText(changes = []) {
  return (Array.isArray(changes) ? changes : []).map(change => `${String(change?.target || '').trim()} | ${String(change?.mode || 'add').trim()} | ${Number(change?.value) || 0}`).join('\n');
}

export function renderStatusDefinitionEditor(definition = null) {
  const current = definition || {};
  const capabilities = current.capabilities || {};
  const isEdit = Boolean(current.id);
  const category = String(current.category || 'status');
  const scopes = new Set(Array.isArray(current.scopes) ? current.scopes.map(String) : ['actor']);
  const selectedIcon = LUCIDE_STATUS_ICONS[String(current.icon || '').toLowerCase()] ? String(current.icon).toLowerCase() : 'circle-dot';
  const capabilitySelect = (name, value) => `<select name="${name}">${capabilityOption(value, '', '继承默认')}${capabilityOption(value, 'true', '允许')}${capabilityOption(value, 'false', '禁止')}</select>`;
  return `<div class="status-definition-backdrop" data-status-definition-editor><form class="status-definition-dialog" data-status-definition-form data-status-definition-id="${escapeStatusHtml(current.id || '')}" role="dialog" aria-modal="true">
    <header><div><h2>${isEdit ? '编辑自定义状态' : '新建自定义状态'}</h2><p>只保存白名单字段和机械能力；不会执行脚本。</p></div><button type="button" class="small-button" data-status-action="definition-close">关闭</button></header>
    <div class="status-definition-grid"><label>稳定 ID<input name="id" maxlength="160" value="${escapeStatusHtml(current.id || '')}" ${isEdit ? 'readonly' : ''} required></label><label>显示名称<input name="name" maxlength="120" value="${escapeStatusHtml(current.label || current.name || '')}" required></label><label>分类<select name="category"><option value="status" ${category === 'status' || category === 'condition' ? 'selected' : ''}>状态</option><option value="buff" ${category === 'buff' ? 'selected' : ''}>Buff</option><option value="debuff" ${category === 'debuff' ? 'selected' : ''}>Debuff</option><option value="trait" ${category === 'trait' ? 'selected' : ''}>特征</option></select></label><label>Lucide 图标<select name="icon">${LUCIDE_STATUS_ICON_NAMES.map(name => `<option value="${name}" ${selectedIcon === name ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label>颜色<input name="color" type="color" value="${safeColor(current.color)}"></label><label>最大叠加层数<input name="maxStacks" type="number" min="1" max="99" value="${Math.max(1, Number(current.maxStacks) || 1)}"></label></div>
    <label>说明<textarea name="description" maxlength="4000" rows="2">${escapeStatusHtml(current.description || '')}</textarea></label>
    <fieldset><legend>可作用范围</legend><label><input type="checkbox" name="scopes" value="actor" ${scopes.has('actor') ? 'checked' : ''}> Actor</label><label><input type="checkbox" name="scopes" value="token" ${scopes.has('token') ? 'checked' : ''}> Token</label></fieldset>
    <fieldset class="status-capability-grid"><legend>机械能力</legend><label>移动 ${capabilitySelect('canMove', capabilities.canMove == null ? '' : String(capabilities.canMove))}</label><label>互动 ${capabilitySelect('canInteract', capabilities.canInteract == null ? '' : String(capabilities.canInteract))}</label><label>战斗行动 ${capabilitySelect('canActInCombat', capabilities.canActInCombat == null ? '' : String(capabilities.canActInCombat))}</label><label><input type="checkbox" name="collisionBypassStructure" ${capabilities.collisionBypassGroups?.includes?.('structure') ? 'checked' : ''}> 可穿越建筑阻挡</label></fieldset>
    <label>数值变化<textarea name="changes" rows="3">${escapeStatusHtml(definitionChangesText(current.changes))}</textarea><small>Token 范围不能包含数值变化。</small></label>
    <footer><button type="button" class="small-button" data-status-action="definition-close">取消</button><button type="submit" class="small-button primary">保存并等待服务器确认</button></footer>
  </form></div>`;
}

function statusApiCall(api, method, ...args) {
  const action = api?.status?.[method];
  if (typeof action !== 'function') throw new Error('状态系统尚未准备好');
  return action(...args);
}

export function createStatusUiController({ api, documentNode, getContext, render, setStatus } = {}) {
  const pendingKeys = new Set();
  const safeRender = () => { try { render?.(); } catch (error) { console.error('[RPGmap Status UI] render failed', error); } };
  const notify = message => { if (message) setStatus?.(message); };
  const reportError = error => {
    const message = error?.message || String(error || '未知错误');
    notify(`状态操作失败：${message}`);
    documentNode?.defaultView?.alert?.(`状态操作失败：${message}`);
  };
  async function perform(keys, mutation, successMessage = '') {
    const values = [...new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean))];
    values.forEach(key => pendingKeys.add(key));
    safeRender();
    try {
      const result = await Promise.resolve().then(mutation);
      notify(successMessage);
      return result;
    } catch (error) {
      reportError(error);
      return null;
    } finally {
      values.forEach(key => pendingKeys.delete(key));
      safeRender();
    }
  }
  function requireMutation() {
    if (canManageStatuses(api)) return true;
    notify('只有 GM 或目标控制者可以修改该状态');
    return false;
  }
  function requireDefinitionManager() {
    if (canManageStatusDefinitions(api)) return true;
    notify('只有 GM 可以管理状态定义');
    return false;
  }
  function closeDefinitionEditor() { documentNode?.querySelector?.('[data-status-definition-editor]')?.remove(); }
  function openDefinitionEditor(definitionId = null) {
    if (!requireDefinitionManager()) return;
    const definition = definitionId ? statusDefinitions(api).find(item => String(item.id) === String(definitionId)) : null;
    if (definition?.builtIn) { notify('内置状态定义不可编辑'); return; }
    closeDefinitionEditor();
    documentNode?.body?.insertAdjacentHTML('beforeend', renderStatusDefinitionEditor(definition));
    documentNode?.querySelector?.('[data-status-definition-form] input[name="name"]')?.focus?.();
  }
  const contextTokens = context => Array.isArray(context?.allTokens) ? context.allTokens : Array.isArray(context?.tokens) ? context.tokens : [];
  function selectedMapTargets(context) {
    const selected = new Set((api?.selection?.getSelectedTokenIds?.() || []).map(String));
    return contextTokens(context).filter(token => selected.has(String(token?.id)));
  }
  function paletteTargets(sheet, context, scope) {
    if (scope === 'actor') {
      if (sheet.querySelector('[data-status-use-actor-map-selection]')?.checked) {
        const actorIds = new Set(selectedMapTargets(context).map(token => String(token?.actorId || '')).filter(Boolean));
        return [...actorIds].map(targetId => ({ scope, targetId }));
      }
      return context?.actor?.id ? [{ scope, targetId: String(context.actor.id) }] : [];
    }
    const tokens = sheet.querySelector('[data-status-use-map-selection]')?.checked
      ? selectedMapTargets(context)
      : [...sheet.querySelectorAll('[data-status-token-target]:checked')].map(input => contextTokens(context).find(token => String(token?.id) === String(input.value))).filter(Boolean);
    const unique = new Map(tokens.map(token => [String(token.id), token]));
    return [...unique.values()].map(token => ({
      scope: token.actorLink === false ? 'syntheticActor' : 'token',
      targetId: String(token.id),
    }));
  }
  function submitPalette(actionNode) {
    if (!requireMutation()) return;
    const sheet = actionNode.closest('.entity-sheet');
    const context = getContext?.() || {};
    if (!sheet || !context.actor) return;
    const scope = String(sheet.querySelector('[data-status-palette-scope]')?.value || 'actor');
    const mode = String(sheet.querySelector('[data-status-palette-mode]')?.value || 'apply') === 'remove' ? 'remove' : 'apply';
    const definitionId = String(sheet.querySelector('[data-status-palette-definition]')?.value || '');
    const stacks = Math.max(1, Math.min(99, Math.floor(Number(sheet.querySelector('[data-status-palette-stacks]')?.value) || 1)));
    const targets = paletteTargets(sheet, context, scope);
    if (!definitionId) { notify('请先选择状态'); return; }
    if (!targets.length) { notify('请至少选择一个 Token 目标'); return; }
    const payloads = targets.map(target => ({ ...target, definitionId, ...(mode === 'apply' ? { stacks } : {}) }));
    const keys = payloads.map(payload => statusMutationKey(payload.scope, payload.targetId, definitionId));
    const mutation = payloads.length === 1 ? () => statusApiCall(api, mode, payloads[0]) : () => statusApiCall(api, 'applyBatch', payloads.map(payload => ({ type: `status.${mode}`, ...payload })));
    void perform(keys, mutation, mode === 'apply' ? `已确认施加状态：${targets.length} 个目标` : `已确认移除状态：${targets.length} 个目标`);
  }
  function mutateStatus(actionNode, action) {
    if (!requireMutation()) return;
    const scope = String(actionNode.dataset.statusScope || 'actor');
    const targetId = String(actionNode.dataset.statusTarget || '');
    const definitionId = String(actionNode.dataset.statusDefinition || '');
    if (!targetId || !definitionId) return;
    const current = Math.max(1, Number(actionNode.dataset.statusStacks) || 1);
    const key = statusMutationKey(scope, targetId, definitionId);
    let method = action;
    const payload = { scope, targetId, definitionId };
    if (action === 'increment') { method = 'setStacks'; payload.stacks = current + 1; }
    if (action === 'decrement') { method = current <= 1 ? 'remove' : 'setStacks'; if (current > 1) payload.stacks = current - 1; }
    if (action === 'toggle') { method = 'setEnabled'; payload.stacks = current; payload.enabled = actionNode.dataset.statusEnabled !== 'true'; }
    if (action === 'note') {
      const note = documentNode?.defaultView?.prompt?.('填写状态备注（留空可清除）', String(actionNode.dataset.statusNote || ''));
      if (note === null || note === undefined) return;
      method = 'setNote'; payload.stacks = current; payload.note = String(note).trim();
    }
    void perform(key, () => statusApiCall(api, method, payload), '状态变更已获服务器确认');
  }
  function deleteDefinition(definitionId) {
    if (!requireDefinitionManager() || !definitionId) return;
    const definition = statusDefinitions(api).find(item => String(item.id) === String(definitionId));
    if (!definition || definition.builtIn) { notify('内置状态定义不可删除'); return; }
    if (!documentNode?.defaultView?.confirm?.(`删除自定义状态“${definition.label}”？仍在使用的定义会被服务器拒绝。`)) return;
    void perform(`definition:${definition.id}`, () => statusApiCall(api, 'deleteDefinition', definition.id), '状态定义已删除');
  }
  function handleClick(event) {
    const actionNode = event.target?.closest?.('[data-status-action]');
    if (!actionNode) return false;
    const action = actionNode.dataset.statusAction;
    event.preventDefault();
    if (action === 'definition-close') closeDefinitionEditor();
    else if (action === 'definition-new') openDefinitionEditor();
    else if (action === 'definition-edit') openDefinitionEditor(actionNode.dataset.statusDefinition);
    else if (action === 'definition-delete') deleteDefinition(actionNode.dataset.statusDefinition);
    else if (action === 'palette-submit') submitPalette(actionNode);
    else if (['increment', 'decrement', 'toggle', 'note', 'remove'].includes(action)) mutateStatus(actionNode, action);
    else return false;
    return true;
  }
  function handleChange(event) {
    if (!event.target?.matches?.('[data-status-palette-scope]')) return false;
    const sheet = event.target.closest('.entity-sheet');
    if (!sheet) return false;
    const scope = event.target.value === 'token' ? 'token' : 'actor';
    const definition = sheet.querySelector('[data-status-palette-definition]');
    const targets = sheet.querySelector('[data-status-palette-token-wrap]');
    const actorTargets = sheet.querySelector('[data-status-palette-actor-wrap]');
    if (definition) definition.innerHTML = definition.dataset[scope === 'token' ? 'statusTokenOptions' : 'statusActorOptions'] || '';
    if (targets) targets.hidden = scope !== 'token';
    if (actorTargets) actorTargets.hidden = scope !== 'actor';
    return true;
  }
  function handleSubmit(event) {
    const form = event.target?.closest?.('[data-status-definition-form]');
    if (!form) return false;
    event.preventDefault();
    if (!requireDefinitionManager()) return true;
    try {
      const context = getContext?.() || {};
      const values = new FormData(form);
      const id = String(values.get('id') || '').trim();
      const name = String(values.get('name') || '').trim();
      const scopes = values.getAll('scopes').map(String);
      const maxStacks = Math.max(1, Math.min(99, Math.floor(Number(values.get('maxStacks')) || 1)));
      const changes = parseStatusDefinitionChanges(values.get('changes'));
      if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(id)) throw new Error('ID 请使用英文、数字、点、短横线或下划线');
      if (!name) throw new Error('请填写显示名称');
      if (!scopes.length) throw new Error('请至少选择一个作用范围');
      if (scopes.includes('token') && changes.length) throw new Error('Token 范围不能包含 Actor 数值变化');
      if (maxStacks > 1 && changes.some(change => change.mode !== 'add')) throw new Error('可叠加状态的数值变化只能使用 add');
      const capabilities = {};
      for (const key of ['canMove', 'canInteract', 'canActInCombat']) {
        const value = String(values.get(key) || '');
        if (value === 'true' || value === 'false') capabilities[key] = value === 'true';
      }
      if (values.get('collisionBypassStructure')) capabilities.collisionBypassGroups = ['structure'];
      const definition = { id, name, label: name, description: String(values.get('description') || '').trim(), icon: String(values.get('icon') || '').trim(), color: safeColor(values.get('color')), category: String(values.get('category') || 'status'), scopes, maxStacks, changes, capabilities };
      const submit = form.querySelector('[type="submit"]');
      if (submit) { submit.disabled = true; submit.textContent = '正在等待服务器确认…'; }
      void perform(`definition:${id}`, async () => { const result = await statusApiCall(api, 'upsertDefinition', definition, { actorId: context.actor?.id }); closeDefinitionEditor(); return result; }, '状态定义已获服务器确认').then(() => {
        if (form.isConnected && submit) { submit.disabled = false; submit.textContent = '保存并等待服务器确认'; }
      });
    } catch (error) { reportError(error); }
    return true;
  }
  return { pendingKeys, handleClick, handleChange, handleSubmit, closeDefinitionEditor };
}

function ensureStatusPane(map) {
  let pane = map.getPane?.('statusBadgePane');
  if (!pane) pane = map.createPane?.('statusBadgePane');
  if (pane) { pane.style.zIndex = '540'; pane.style.pointerEvents = 'none'; }
}

export function createStatusUiSystem() {
  return {
    register(api) {
      const documentNode = api.map.getContainer().ownerDocument || document;
      installStatusUiStyles(documentNode);
      let destroyed = false;
      let badgeLayer = null;
      let renderBadges = () => {};
      const requestRender = () => renderBadges();
      for (const eventName of ['status:change', 'token:create', 'token:delete', 'token:move', 'token:property-change', 'elevation:token-change', 'state:commit', 'state:import']) api.on?.(eventName, requestRender);
      api.on?.('app:destroy', () => {
        destroyed = true;
        if (badgeLayer) api.map.removeLayer?.(badgeLayer);
        api.map.off?.('zoomend', requestRender);
      });
      void import('./leaflet-badges.js').then(({ createStatusBadgeLayer, addStatusBadgeMarker }) => {
        if (destroyed) return;
        ensureStatusPane(api.map);
        badgeLayer = createStatusBadgeLayer(api.map);
        renderBadges = () => {
          if (destroyed || !badgeLayer) return;
          badgeLayer.clearLayers();
          const tokens = typeof api.tokens?.list === 'function' ? api.tokens.list() : [];
          const origin = api.map.latLngToContainerPoint(worldToLatLng({ x: 0, y: 0 }, api.mapPackage.height));
          const unit = api.map.latLngToContainerPoint(worldToLatLng({ x: 1, y: 0 }, api.mapPackage.height));
          const pixelsPerMeter = Math.hypot(unit.x - origin.x, unit.y - origin.y) || 1;
          for (const token of tokens) {
            if (!token || token.hidden === true || token.placement !== 'map') continue;
            const x = Number(token.x); const y = Number(token.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const snapshot = resolveStatusUiSnapshot(api, { actorId: token.actorId, tokenId: token.id });
            const html = renderTokenStatusBadges(snapshot.statuses, { limit: 4 });
            if (!html) continue;
            const tokenPixels = Math.max(18, Math.min(144, tokenDiameterMeters(token) * pixelsPerMeter));
            addStatusBadgeMarker(badgeLayer, { latLng: worldToLatLng({ x, y }, api.mapPackage.height), html, tokenPixels });
          }
        };
        api.map.on?.('zoomend', requestRender);
        renderBadges();
      }).catch(error => console.error('[RPGmap Status UI] map badges failed', error));
      queueMicrotask(() => api.emit?.('status:change', { source: 'status-ui-ready' }));
    },
  };
}

export function installStatusUiStyles(documentNode) {
  if (!documentNode?.head || documentNode.getElementById(STATUS_STYLE_ID)) return;
  const style = documentNode.createElement('style');
  style.id = STATUS_STYLE_ID;
  style.textContent = `
    .status-title-band { margin-top:8px; min-height:24px; }
    .status-strip { display:inline-flex; max-width:100%; gap:5px; align-items:center; flex-wrap:wrap; }
    .status-chip { --status-color:#59686b; display:inline-flex; align-items:center; gap:4px; min-height:22px; max-width:180px; padding:2px 7px 2px 3px; border:1px solid color-mix(in srgb,var(--status-color) 55%,#d7dedd); border-radius:999px; background:color-mix(in srgb,var(--status-color) 12%,#fff); color:#334044; font-size:11px; font-weight:750; }
    .status-chip.derived { border-style:dashed; }
    .status-chip-icon { width:17px; height:17px; display:grid; place-items:center; border-radius:50%; background:var(--status-color); color:#fff; font-size:10px; flex:0 0 auto; }
    .status-lucide { display:block; pointer-events:none; }
    .status-chip-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .status-chip-stacks { min-width:16px; text-align:center; color:var(--status-color); }
    .status-overflow { padding-inline:7px; }
    .status-empty-inline { color:#7b8587; font-size:11px; }
    .entity-card .status-strip { margin-left:51px; }
    .entity-card .status-chip-label { display:none; }
    .entity-card .status-chip { padding-right:3px; }
    .status-card-list { display:grid; gap:7px; }
    .status-card { --status-color:#59686b; display:grid; grid-template-columns:34px minmax(0,1fr) auto; gap:8px; align-items:center; min-height:48px; padding:7px; border:1px solid color-mix(in srgb,var(--status-color) 38%,#dfe4e1); border-left:4px solid var(--status-color); border-radius:8px; background:#fbfcfb; }
    .status-card.pending { opacity:.72; }
    .status-card.disabled { opacity:.62; filter:saturate(.45); }
    .status-card-icon { width:30px; height:30px; display:grid; place-items:center; border-radius:8px; background:var(--status-color); color:#fff; font-weight:850; }
    .status-card-copy { min-width:0; display:grid; gap:2px; }
    .status-card-copy strong,.status-card-copy small,.status-card-copy em { overflow:hidden; text-overflow:ellipsis; }
    .status-card-copy small { color:#697679; }
    .status-card-copy em { color:#176d76; font-size:11px; font-style:normal; }
    .status-card-controls { display:flex; gap:5px; align-items:center; }
    .status-card-controls button { min-width:29px; }
    .status-readonly { color:#788385; white-space:nowrap; }
    .status-empty { padding:11px 4px; color:#7b8587; }
    .status-palette-row { display:flex; gap:8px; align-items:end; flex-wrap:wrap; }
    .status-palette-row label { display:grid; gap:3px; color:#647174; font-size:11px; }
    .status-palette-row select { min-width:150px; }
    .status-palette-row input { width:64px; }
    .status-token-targets { display:grid; gap:7px; margin-top:10px; padding:9px; border:1px solid #dce4e0; border-radius:8px; background:#f8faf8; }
    .status-token-targets[hidden] { display:none !important; }
    .status-token-checklist { display:flex; gap:7px; flex-wrap:wrap; }
    .status-token-checklist label,.status-map-selection { display:flex; gap:5px; align-items:center; padding:5px 7px; border-radius:6px; background:#edf2ef; color:#526164; font-size:11px; }
    .status-token-checklist input,.status-map-selection input { margin:0; }
    .status-definition-actions { display:flex; gap:8px; align-items:center; margin-top:10px; }
    .status-definition-list { display:grid; gap:5px; margin-top:8px; }
    .status-definition-list > div { display:flex; gap:6px; align-items:center; }
    .status-definition-list > div > span { flex:1; }
    .status-definition-backdrop { position:fixed; inset:0; z-index:5600; display:grid; place-items:center; padding:18px; background:rgba(18,23,24,.54); }
    .status-definition-dialog { width:min(720px,96vw); max-height:92vh; overflow:auto; box-sizing:border-box; display:grid; gap:12px; padding:17px; border:1px solid rgba(45,70,70,.25); border-radius:13px; background:#f8faf7; box-shadow:0 22px 70px rgba(0,0,0,.32); }
    .status-definition-dialog header,.status-definition-dialog footer { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; }
    .status-definition-dialog header h2,.status-definition-dialog header p { margin:0; }
    .status-definition-dialog > label,.status-definition-grid label,.status-capability-grid label { display:grid; gap:4px; color:#526164; font-size:12px; }
    .status-definition-dialog input,.status-definition-dialog select,.status-definition-dialog textarea { box-sizing:border-box; width:100%; padding:7px 8px; border:1px solid #cbd5d2; border-radius:7px; background:#fff; color:#334144; font:inherit; }
    .status-definition-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:9px; }
    .status-definition-dialog fieldset { display:flex; gap:10px; flex-wrap:wrap; margin:0; padding:9px; border:1px solid #d8e1dd; border-radius:8px; }
    .status-definition-dialog fieldset label { display:flex; align-items:center; gap:5px; }
    .status-definition-dialog fieldset input { width:auto; }
    .status-definition-dialog footer { justify-content:flex-end; }
    .rpgmap-status-badge-marker { border:0 !important; background:transparent !important; pointer-events:none !important; overflow:visible !important; }
    .token-status-badges { display:flex; gap:2px; width:max-content; filter:drop-shadow(0 1px 2px rgba(0,0,0,.55)); }
    .token-status-badge { --status-color:#59686b; position:relative; display:grid; place-items:center; width:18px; height:18px; box-sizing:border-box; border:1px solid rgba(255,255,255,.9); border-radius:50%; background:var(--status-color); color:#fff; font-size:9px; font-weight:900; line-height:1; }
    .token-status-badge.derived { border-style:dashed; }
    .token-status-badge b { position:absolute; right:-4px; bottom:-4px; min-width:10px; height:10px; padding:0 2px; box-sizing:border-box; display:grid; place-items:center; border-radius:5px; background:#fff; color:var(--status-color); font-size:7px; }
    .token-status-overflow { width:auto; min-width:18px; padding-inline:3px; border-radius:9px; background:#3e4d50; }
    .ui-status-summary { margin-top:7px; }
    @media (max-width:760px) { .status-card { grid-template-columns:30px 1fr; } .status-card-controls,.status-readonly { grid-column:1/-1; justify-self:start; } .status-palette-row { align-items:stretch; } .status-palette-row label,.status-palette-row button { width:100%; } .status-palette-row select { width:100%; min-width:0; } .status-definition-grid { grid-template-columns:1fr; } }
  `;
  documentNode.head.append(style);
}

export { CATEGORY_LABELS, statusMutationKey };
