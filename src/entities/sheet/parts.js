import { actorPublicProfileHasContent, normalizeActorPublicProfile } from '../../actor/public-profile.js';
import { escapeEntityHtml } from '../sheet-renderer.js';

const typeLabel = actor => ({ pc: 'PC', monster: '怪物', npc: 'NPC', summon: '召唤物', other: '其他' })[String(actor?.type)] || '其他';

export function renderSheetBadges({ actor, token, context, description = {} } = {}) {
  const kind = String(description.kind || ({ pc: 'character', monster: 'monster', npc: 'npc', summon: 'monster' })[actor?.type] || 'generic');
  const labels = [typeLabel(actor), token ? 'TOKEN INSTANCE' : 'ACTOR', context?.limited ? 'LIMITED' : context?.level === 'observer' ? '只读' : String(context?.mode || 'play').toUpperCase()];
  return `<div class="entity-sheet-v3-badges" data-sheet-v3-badges data-sheet-kind="${escapeEntityHtml(kind)}">${labels.map(label => `<span class="entity-sheet-v3-badge">${escapeEntityHtml(label)}</span>`).join('')}${context?.canToggleMode ? `<button type="button" class="entity-sheet-v3-mode-toggle" data-sheet-mode-toggle aria-pressed="${context.mode === 'edit'}">${context.mode === 'edit' ? '返回游玩' : '编辑卡片'}</button>` : ''}</div>`;
}

function renderPublicStatuses(token) {
  const statuses = Array.isArray(token?.publicStatuses) ? token.publicStatuses : [];
  if (!statuses.length) return '';
  return `<section class="entity-section entity-public-statuses"><h3>当前可见状态</h3><div class="entity-public-status-list">${statuses.map(status => `<span class="entity-public-status" style="--status-color:${escapeEntityHtml(status.color || '#64748b')}"><span>${escapeEntityHtml(status.icon || 'circle-dot')}</span><strong>${escapeEntityHtml(status.name || '状态')}</strong>${Number(status.stacks) > 1 ? `<b>×${Math.floor(Number(status.stacks))}</b>` : ''}</span>`).join('')}</div></section>`;
}

export function renderLimitedSheetBody({ actor, token } = {}) {
  const profile = normalizeActorPublicProfile(actor?.publicProfile);
  const sections = [];
  if (profile.summary) sections.push(`<section class="entity-section"><h3>简介</h3><p class="entity-description">${escapeEntityHtml(profile.summary)}</p></section>`);
  if (profile.appearance) sections.push(`<section class="entity-section"><h3>外观</h3><p class="entity-description">${escapeEntityHtml(profile.appearance)}</p></section>`);
  if (profile.knownFacts.length) sections.push(`<section class="entity-section"><h3>已知情报</h3><ul class="entity-known-facts">${profile.knownFacts.map(fact => `<li>${escapeEntityHtml(fact)}</li>`).join('')}</ul></section>`);
  const statuses = renderPublicStatuses(token);
  if (statuses) sections.push(statuses);
  if (!actorPublicProfileHasContent(profile) && !statuses) sections.push('<section class="entity-section"><p class="entity-help">GM 尚未公开更多资料。</p></section>');
  sections.push('<section class="entity-section entity-limited-privacy"><p class="entity-help">生命、属性、资源、私密状态、权限和实例数据均不可见。</p></section>');
  return sections.join('');
}

export function renderPublicProfileEditor({ actor, statusDefinitions = [], pending = false, feedback = '', preview = false, previewProfile = null } = {}) {
  const profile = normalizeActorPublicProfile(actor?.publicProfile);
  const selected = new Set(profile.visibleStatusDefinitionIds);
  const statusOptions = statusDefinitions.map(definition => `<label class="entity-public-status-option"><input type="checkbox" name="visibleStatusDefinitionIds" value="${escapeEntityHtml(definition.id)}" ${selected.has(String(definition.id)) ? 'checked' : ''}> ${escapeEntityHtml(definition.name || definition.id)}</label>`).join('');
  return `<section class="entity-section entity-public-profile-editor" data-public-profile-editor><h3>公开资料</h3><p class="entity-help">只有 GM 可以修改；玩家的 LIMITED 卡只会收到这里明确公开的内容。</p><label>简介<textarea name="summary" maxlength="2000" rows="4" ${pending ? 'disabled' : ''}>${escapeEntityHtml(profile.summary)}</textarea></label><label>外观<textarea name="appearance" maxlength="2000" rows="4" ${pending ? 'disabled' : ''}>${escapeEntityHtml(profile.appearance)}</textarea></label><label>已知情报<textarea name="knownFacts" maxlength="4200" rows="5" placeholder="每行一条，最多 20 条" ${pending ? 'disabled' : ''}>${escapeEntityHtml(profile.knownFacts.join('\n'))}</textarea></label><fieldset><legend>允许公开的当前状态</legend><div class="entity-public-status-options">${statusOptions || '<small>当前 World 没有状态定义。</small>'}</div></fieldset>${feedback ? `<div class="token-config-feedback ${pending ? 'pending' : 'confirmed'}">${escapeEntityHtml(feedback)}</div>` : ''}<div class="entity-card-actions"><button type="button" class="small-button" data-public-profile-preview>${preview ? '关闭预览' : '预览 LIMITED 卡'}</button><button type="button" class="small-button primary" data-public-profile-save ${pending ? 'disabled' : ''}>保存公开资料</button></div>${preview ? `<div class="entity-public-profile-preview">${renderLimitedSheetBody({ actor: { ...actor, publicProfile: previewProfile || profile }, token: null })}</div>` : ''}</section>`;
}
