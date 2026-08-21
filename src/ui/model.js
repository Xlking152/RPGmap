export const UI_CONTEXT_PANELS = Object.freeze({
  select: 'current',
  inspect: 'inspect',
  distance: 'measure',
  route: 'measure',
  aoe: 'areas',
  layers: 'layers',
});

export function entityStateFromApp(appState) {
  const entity = appState?.preferences?.entitySystem;
  return entity && typeof entity === 'object'
    ? entity
    : { schemaVersion: 1, actors: [], tokens: [] };
}

export function findSelectedEntity(appState, tokenId) {
  if (!tokenId) return null;
  const entity = entityStateFromApp(appState);
  const token = (entity.tokens || []).find(item =>
    String(item?.id) === String(tokenId) || String(item?.characterId) === String(tokenId));
  if (!token) return null;
  const actor = (entity.actors || []).find(item => String(item?.id) === String(token.actorId));
  if (!actor) return null;
  const form = (actor.forms || []).find(item => item.id === actor.currentFormId) || actor.forms?.[0] || null;
  const character = (appState.characters || []).find(item =>
    String(item?.id) === String(token.characterId || token.id)) || null;
  return { token, actor, form, character };
}

export function isMovementStatus(message) {
  const text = String(message || '');
  return /拖动角色|拖动路线|移动规划|移动吸附|路线已就绪|最终终点|已添加拐点|已保留拐点|撤销最近拐点|当前位置不可通行|无法通行|确认移动|正在沿规划路径移动/.test(text);
}

export function selectionStatus(selection) {
  if (!selection) return '未选择 Token';
  const formName = selection.form?.name || '默认形态';
  return `${selection.actor.name} · ${formName}${selection.token.locked ? ' · 已锁定' : ''}`;
}
