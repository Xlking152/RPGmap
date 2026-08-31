export const INFINITE_HORROR_STATUS_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'status-invisible',
    name: '隐身',
    label: '隐身',
    description: '只有 GM、控制者、队友或明确授权的用户可以看到该 Token。',
    icon: 'eye-off',
    color: '#607d76',
    category: 'trait',
    scopes: Object.freeze(['actor', 'token']),
    maxStacks: 1,
    changes: Object.freeze([]),
    capabilities: Object.freeze({ visibility: 'invisible' }),
    builtIn: true,
  }),
  Object.freeze({
    id: 'status-spirit',
    name: '灵体',
    label: '灵体',
    description: '可穿越结构类碰撞，但不会绕过地图边界或其他未声明的阻挡。',
    icon: 'ghost',
    color: '#6f57a5',
    category: 'trait',
    scopes: Object.freeze(['actor', 'token']),
    maxStacks: 1,
    changes: Object.freeze([]),
    capabilities: Object.freeze({ collisionBypassGroups: Object.freeze(['structure']) }),
    builtIn: true,
  }),
  Object.freeze({
    id: 'status-rooted',
    name: '定身',
    label: '定身',
    description: '无法移动，但仍可进行交互与战斗行动。',
    icon: 'anchor',
    color: '#b96c24',
    category: 'debuff',
    scopes: Object.freeze(['actor', 'token']),
    maxStacks: 1,
    changes: Object.freeze([]),
    capabilities: Object.freeze({ canMove: false }),
    builtIn: true,
  }),
  Object.freeze({
    id: 'status-incapacitated',
    name: '失能',
    label: '失能',
    description: '无法移动、交互或进行战斗行动。',
    icon: 'circle-slash',
    color: '#a83f3f',
    category: 'debuff',
    scopes: Object.freeze(['actor', 'token']),
    maxStacks: 1,
    changes: Object.freeze([]),
    capabilities: Object.freeze({ canMove: false, canInteract: false, canActInCombat: false }),
    builtIn: true,
  }),
]);

import { deriveInfiniteHorrorActor } from './actor.js';
import { HEALTH_MODE_WOUND_TRACK } from './health.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function derivedStatus(definitionId, label, stacks, options = {}) {
  return {
    id: `${definitionId}:derived`,
    definitionId,
    name: label,
    label,
    description: options.description || '',
    icon: options.icon || '',
    color: options.color || '#64748b',
    category: 'derived',
    scope: 'derived',
    targetId: options.targetId == null ? null : String(options.targetId),
    stacks: Math.max(1, Math.min(99, Math.floor(finite(stacks, 1)))),
    maxStacks: 99,
    enabled: true,
    derived: true,
    readOnly: true,
    readonly: true,
    capabilities: { ...(options.capabilities || {}) },
    changes: [],
    builtIn: true,
  };
}

function deriveBadStatusThresholds(actor, derivedActor) {
  const targetId = actor?.id;
  return (Array.isArray(derivedActor?.badStatuses) ? derivedActor.badStatuses : []).flatMap(status => {
    const current = Math.max(0, finite(status?.current));
    const thresholds = [
      { key: 'destruction', label: '毁灭', icon: 'skull', color: '#8f3333' },
      { key: 'severe', label: '重度', icon: 'triangle-alert', color: '#b35e2e' },
      { key: 'light', label: '轻度', icon: 'circle-alert', color: '#a47a22' },
    ];
    const level = thresholds.find(entry => finite(status?.[entry.key]) > 0 && current >= finite(status?.[entry.key]));
    if (!level) return [];
    const statusId = String(status?.id || 'unknown');
    const name = cleanText(status?.name, '不良状态');
    return [derivedStatus(`derived-bad-${statusId}-${level.key}`, `${name} · ${level.label}`, current || 1, {
      targetId,
      icon: level.icon,
      color: level.color,
      description: `当前 ${current} 点，已达到${level.label}阈值。`,
    })];
  });
}

export function deriveInfiniteHorrorStatuses(actor, { statuses = [] } = {}) {
  const derivedActor = deriveInfiniteHorrorActor(actor, { effects: statuses });
  const health = derivedActor?.health || null;
  const badStatusThresholds = deriveBadStatusThresholds(actor, derivedActor);
  if (!health) return badStatusThresholds;
  const targetId = actor?.id;
  const disabled = { canMove: false, canInteract: false, canActInCombat: false };
  const derived = [];
  if (health.dead) {
    derived.push(derivedStatus('derived-dead', '死亡', 1, {
      targetId, icon: 'skull', color: '#762d2d', description: '生命状态自动派生，不可手动移除。', capabilities: disabled,
    }));
  } else if (health.unconscious) {
    derived.push(derivedStatus('derived-unconscious', '昏迷', 1, {
      targetId, icon: 'moon', color: '#495c78', description: '生命状态自动派生，不可手动移除。', capabilities: disabled,
    }));
  }
  if (health.mode === HEALTH_MODE_WOUND_TRACK) {
    if (health.bashing > 0) derived.push(derivedStatus('derived-wound-b', 'B 伤势', health.bashing, { targetId, icon: 'B', color: '#6d7780' }));
    if (health.lethal > 0) derived.push(derivedStatus('derived-wound-l', 'L 伤势', health.lethal, { targetId, icon: 'L', color: '#a05a32' }));
    if (health.aggravated > 0) derived.push(derivedStatus('derived-wound-a', 'A 伤势', health.aggravated, { targetId, icon: 'A', color: '#8f3333' }));
  }
  return [...derived, ...badStatusThresholds];
}
