import { escapeEntityHtml } from '../sheet-renderer.js';

export const SHEET_PARTS = Object.freeze({
  header: renderHeader,
  resources: renderResources,
  stats: renderStats,
  effects: renderEffects,
  token: renderToken,
  text: renderText,
});

export function renderPart(section = {}) {
  const renderer = SHEET_PARTS[section.type] || renderText;
  return renderer(section);
}

function renderHeader(section) {
  return `<section class="entity-section entity-sheet-part-header"><h3>${escapeEntityHtml(section.title || '角色')}</h3></section>`;
}

function renderResources(section) {
  const rows = (section.items || []).map(item =>
    `<div class="entity-resource"><strong>${escapeEntityHtml(item.label || item.id)}</strong><span>${escapeEntityHtml(item.current ?? 0)}/${escapeEntityHtml(item.max ?? 0)}</span></div>`,
  ).join('');
  return `<section class="entity-section"><h3>${escapeEntityHtml(section.title || '资源')}</h3>${rows || '<div class="entity-empty">暂无资源</div>'}</section>`;
}

function renderStats(section) {
  const rows = (section.items || []).map(item =>
    `<div class="entity-stat"><span>${escapeEntityHtml(item.label || item.id)}</span><strong>${escapeEntityHtml(item.value)}</strong></div>`,
  ).join('');
  return `<section class="entity-section"><h3>${escapeEntityHtml(section.title || '属性')}</h3><div class="entity-grid">${rows}</div></section>`;
}

function renderEffects(section) {
  return `<section class="entity-section"><h3>${escapeEntityHtml(section.title || '状态')}</h3><div>${escapeEntityHtml((section.items || []).join(', ') || '无')}</div></section>`;
}

function renderToken(section) {
  return `<section class="entity-section"><h3>${escapeEntityHtml(section.title || 'Token')}</h3><pre>${escapeEntityHtml(JSON.stringify(section.data || {}, null, 2))}</pre></section>`;
}

function renderText(section) {
  return `<section class="entity-section"><h3>${escapeEntityHtml(section.title || '')}</h3><div class="entity-description">${escapeEntityHtml(section.content || section.message || '')}</div></section>`;
}
