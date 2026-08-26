function entityState(state) {
  const value = state?.preferences?.entitySystem;
  return value && typeof value === 'object' ? value : { actors: [], tokens: [], statusDefinitions: [] };
}

function tokenContext(state, characterId) {
  const id = String(characterId ?? '');
  if (!id) return { actorId: null, tokenId: null };
  const token = (entityState(state).tokens || []).find(item =>
    String(item?.characterId ?? item?.id ?? '') === id);
  return {
    actorId: token?.actorId == null ? null : String(token.actorId),
    tokenId: token?.id == null ? null : String(token.id),
  };
}

function normalizedStatuses(snapshot) {
  const statuses = Array.isArray(snapshot) ? snapshot : snapshot?.statuses;
  return (Array.isArray(statuses) ? statuses : [])
    .filter(status => status?.enabled !== false)
    .map(status => String(status?.definitionId ?? status?.statusId ?? status?.id ?? ''))
    .filter(Boolean);
}

export function featureStatusRule(feature, action) {
  const rule = feature?.capabilities?.statusRules?.[action];
  return rule && typeof rule === 'object' ? rule : null;
}

export function evaluateFeatureStatusRule({ feature, action, characterId = null, resolveStatus = null } = {}) {
  const rule = featureStatusRule(feature, action);
  let snapshot = null;
  if (characterId && typeof resolveStatus === 'function') {
    snapshot = resolveStatus({ characterId });
    if (snapshot && typeof snapshot.then === 'function') {
      return { ok: false, reason: '状态读取必须在操作前同步完成', snapshot: null };
    }
  }

  // Incapacitation is a global mechanical restriction, independent of whether
  // the particular Feature declares a status rule. Inspection remains a
  // read-only action and is therefore intentionally available.
  if (action !== 'inspect' && snapshot?.capabilities?.canInteract === false) {
    return {
      ok: false,
      reason: snapshot.capabilities.reasons?.[0] || '当前状态禁止 Feature 交互',
      snapshot,
    };
  }
  if ((action === 'enter' || action === 'exit') && snapshot?.capabilities?.canMove === false) {
    return {
      ok: false,
      reason: snapshot.capabilities.reasons?.[0] || '当前状态禁止移动',
      snapshot,
    };
  }
  if (!rule) return { ok: true, reason: '', snapshot };
  if (!characterId) return { ok: false, reason: '该操作需要先选择角色以检查状态', snapshot };
  if (!snapshot) return { ok: false, reason: '当前无法读取所选角色的状态', snapshot };

  const active = new Set(normalizedStatuses(snapshot));
  const missing = (rule.requiresAll || []).find(statusId => !active.has(String(statusId)));
  if (missing) return { ok: false, reason: `缺少所需状态：${missing}`, snapshot };
  const forbidden = (rule.forbidsAny || []).find(statusId => active.has(String(statusId)));
  if (forbidden) return { ok: false, reason: `当前状态禁止操作：${forbidden}`, snapshot };
  return { ok: true, reason: '', snapshot };
}

export function featureStatusMutations({ feature, action, state, characterId, definitions = [] } = {}) {
  const rule = featureStatusRule(feature, action);
  if (!rule) return Object.freeze([]);
  const onSuccess = rule.onSuccess || {};
  const changes = [
    ...(onSuccess.apply || []).map(item => ({ ...item, type: 'status.apply' })),
    ...(onSuccess.remove || []).map(item => ({ ...item, type: 'status.remove' })),
  ];
  if (!changes.length) return Object.freeze([]);

  const { actorId, tokenId } = tokenContext(state, characterId);
  const known = new Map((definitions || []).map(definition => [String(definition?.id ?? ''), definition]));
  const operations = changes.map(change => {
    const statusId = String(change.statusId ?? change.definitionId ?? '');
    const definition = known.get(statusId);
    if (!definition || definition.derived === true || definition.persisted === false) {
      throw new Error(`Feature 引用了不可持久化或不存在的状态：${statusId}`);
    }
    const scope = change.scope === 'token' ? 'token' : 'actor';
    const targetId = scope === 'token' ? tokenId : actorId;
    if (!targetId) throw new Error(`所选角色没有可用于 ${scope} 状态的目标`);
    return Object.freeze({
      type: change.type,
      scope,
      targetId,
      statusId,
      ...(change.type === 'status.apply' ? {
        stacks: Math.max(1, Math.min(99, Number(change.stacks) || 1)),
        note: change.note == null ? '' : String(change.note),
      } : {}),
    });
  });
  return Object.freeze(operations);
}
