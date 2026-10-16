export async function resetCurrentScene(api, confirm) {
  const session = api.multiplayer?.getStatus?.();
  const role = session?.session?.role ?? session?.role ?? api.multiplayer?.getCapabilities?.()?.role;
  if (role === 'player') throw new Error('只有 GM 可以执行全局回撤');
  const scene = api.world.getActiveScene();
  if (!scene) throw new Error('当前没有可回撤的地图');
  if (!confirm(`全局回撤「${scene.name || scene.id}」？将清除当前地图全部 Token 和破坏效果，保留角色卡、NPC／怪物模板及迷雾探索。此操作不可撤销。`)) return false;
  await api.world.performOperations([{ type: 'scene.reset', payload: { sceneId: scene.id } }], {
    source: 'scene.reset',
  });
  api.showToast?.('当前地图的 Token 和破坏效果已清除，角色卡与模板已保留', 'success');
  return true;
}

async function resetSceneWithRecovery(api, confirm, type) {
  const session = api.multiplayer?.getConnectionState?.() ?? api.multiplayer?.getStatus?.();
  const role = session?.session?.role ?? session?.role ?? api.multiplayer?.getCapabilities?.()?.role;
  if (role === 'player' || (session?.connected && role !== 'gm')) {
    throw Object.assign(new Error('只有 GM 可以重置当前场景'), { code: 'scene_reset_gm_only' });
  }
  const scene = api.world.getActiveScene();
  if (!scene) throw new Error('当前没有可重置的场景');
  const environment = type === 'scene.environment.reset';
  const impact = environment
    ? '恢复破坏、门状态及遮挡到当前地图版本的初始状态，清除历史探索；保留 Token、实例状态、标记、范围模板、战斗与场景设置。'
    : '恢复地图环境并清除 Token、实例状态、标记、范围模板和当前场景战斗记录，场景设置恢复默认；保留角色卡、资料及其他场景。';
  if (!await confirm(`${environment ? '恢复地图环境' : '清空当前场景'}「${scene.name || scene.id}」？\n${impact}\n执行前将保存恢复点，失败时不会重置。`)) return false;
  if (typeof api.world.createSceneRecoveryPoint !== 'function') {
    throw Object.assign(new Error('当前运行环境无法建立恢复点，重置已取消'), { code: 'recovery_point_required' });
  }
  const recoveryPoint = await api.world.createSceneRecoveryPoint(scene.id, { reason: type });
  if (!recoveryPoint || recoveryPoint === false) {
    throw Object.assign(new Error('恢复点未能可靠保存，重置已取消'), { code: 'recovery_point_failed' });
  }
  if (String(api.world.getActiveScene()?.id) !== String(scene.id)) {
    throw Object.assign(new Error('当前场景已切换，请重新操作'), { code: 'scene_content_conflict' });
  }
  api.emit?.('scene:reset-starting', { sceneId: scene.id, scope: environment ? 'environment' : 'scene' });
  let applied;
  try {
    applied = await api.world.performOperations([{ type, payload: { sceneId: scene.id, expectedActiveSceneId: scene.id } }], { source: type });
  } catch (error) {
    api.emit?.('scene:reset-failed', { sceneId: scene.id });
    throw error;
  }
  api.emit?.(environment ? 'scene:environment-reset' : 'scene:cleared', { sceneId: scene.id, recoveryPoint });
  const conflicts = applied?.results?.find(result => result.action === type)?.positionConflicts || [];
  if (conflicts.length) {
    api.emit?.('scene:position-conflicts', { sceneId: scene.id, tokenIds: conflicts });
    api.showToast?.(`以下 Token 与恢复的地图阻挡冲突，请由 GM 调整：${conflicts.join('、')}`, 'info');
  }
  api.showToast?.(environment ? '地图环境已恢复，Token 已保留'
    : '当前场景已清空，角色卡与其他场景已保留', 'success');
  return true;
}

export const restoreCurrentSceneEnvironment = (api, confirm) => resetSceneWithRecovery(api, confirm, 'scene.environment.reset');
export const clearCurrentScene = (api, confirm) => resetSceneWithRecovery(api, confirm, 'scene.clear');
