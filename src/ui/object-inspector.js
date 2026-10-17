import { describeHealth } from '../health/model.js';

const MOVEMENT_LABELS = Object.freeze({ walk: '步行', swim: '游泳', waterWalk: '水上行走', fly: '飞行' });

export function describeObjectInspector(api, token, actor) {
  if (!actor || actor.audienceRestricted) return { restricted: true, health: null, properties: [] };
  const health = api.health?.resolveToken?.(token.id);
  const view = health ? describeHealth(health, { ruleset: api.ruleset }) : null;
  const max = Math.max(0, Number(health?.max) || 0);
  const source = api.vision?.getSource?.() === token.id ? api.vision.getVisibleRegion?.() : null;
  const precise = Number(source?.preciseRangeMeters ?? source?.rangeMeters);
  const vague = Number(source?.vagueRangeMeters ?? source?.rangeMeters);
  const vision = token.vision?.enabled === false ? '未启用'
    : !source ? '未选为来源'
      : Number.isFinite(precise) && Number.isFinite(vague) && vague !== precise
        ? `${precise} / ${vague} m`
        : Number.isFinite(precise) ? `${precise} m` : '未配置';
  const mode = api.movement?.getPreferredMode?.(token.id) || token.movement?.mode || 'walk';
  return {
    restricted: false,
    health: view ? {
      label: view.compactSummary || view.summary || '未配置',
      title: view.title || '生命',
      status: view.status || '',
      segments: max ? (view.segments || []).map(segment => ({
        label: String(segment.label || ''), color: /^#[0-9a-f]{6}$/i.test(segment.color || '') ? segment.color : '#36966c',
        percent: Math.max(0, Math.min(100, Number(segment.value) / max * 100 || 0)),
      })) : [],
    } : null,
    properties: [
      ['移动', MOVEMENT_LABELS[mode] || mode],
      ['高度', `${Number(token.elevationMeters) || 0} m`],
      ['视野', vision],
      ['队伍', actor.partyId === 'party-default' ? '玩家队伍' : actor.partyId || '未分配'],
    ],
  };
}
