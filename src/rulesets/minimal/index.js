/** A self-contained contract fixture proving that Runtime is independent of a particular game. */
export const minimalRuleset = Object.freeze({
  apiVersion: 1,
  id: 'rpgmap-minimal-test',
  title: '最小测试规则',
  version: '1.0.0',
  actor: {
    createDefault: () => ({ name: '测试角色', system: { counter: 0, limit: 10 } }),
    normalizeSystem: system => ({ counter: Number(system?.counter) || 0, limit: Math.max(1, Number(system?.limit) || 10) }),
    validateSystem: system => Number.isFinite(system?.counter) ? [] : ['counter must be finite'],
    derive: actor => ({ id: actor.id, name: actor.name, counter: Number(actor.system?.counter) || 0,
      health: { mode: 'counter', current: Number(actor.system?.counter) || 0, max: Number(actor.system?.limit) || 10 } }),
    attributePaths: () => [{ path: 'system.counter', label: '计数', kind: 'number' }],
    resolveAttribute: (actor, path) => path === 'system.counter' ? Number(actor.system?.counter) || 0 : null,
    applyRuntimeOperation(actor, operation) {
      if (operation.type !== 'counter.increment') return { changed: false, blocked: 'unknown_actor_operation' };
      actor.system.counter = Math.min(actor.system.limit, actor.system.counter + (Number(operation.amount) || 1));
      return { changed: true, value: actor.system.counter };
    },
    presentation: {
      describe: actor => ({ name: actor.name, color: '#225588', variantLabel: '' }),
      describeSheet: actor => ({ tabs: [{ id: 'overview', label: '计数', sections: [{ type: 'text', blocks: [String(actor.system?.counter || 0)] }] }] }),
    },
  },
  movement: { describe: () => ({ walk: true, swim: false, fly: false, waterWalk: false, swimCostMultiplier: 2 }) },
  vision: { describe: () => ({ enabled: true, rangeMeters: 100, preciseRangeMeters: 100, vagueRangeMeters: 0, senses: {} }) },
  metadata: { description: '用于验证独立规则包加载，不包含地图或核心实现。' },
});

export default minimalRuleset;
