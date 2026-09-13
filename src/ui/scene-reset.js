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
