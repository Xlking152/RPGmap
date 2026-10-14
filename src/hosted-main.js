import { listBuiltInRulesets } from './ruleset/metadata.js';
import { mapPackageRegistry } from './map-package/registry.js';
import { registerInstalledMapPackages, loadInstalledRulesetReference } from './adapters/installed-packages.js';
import { readRpgMapServerBootstrap } from './multiplayer/server-bootstrap.js';
import { readServerWorldBootstrap } from './world/bootstrap.js';

function setBootStatus(message, { error = false } = {}) {
  const node = document.querySelector('[data-rpgmap-boot-status]');
  if (!node) return;
  node.textContent = message; node.dataset.error = error ? 'true' : 'false';
}

export async function startHostedRpgMap() {
  const appContainer = document.getElementById('app');
  if (!appContainer) throw new Error('缺少 RPGmap 应用容器');
  if (globalThis.location.pathname === '/setup') {
    const { startDesktopSetup } = await import('./app/desktop-setup.js');
    return startDesktopSetup({ container: appContainer });
  }
  const server = await readRpgMapServerBootstrap();
  if (!server.serverRuntime) throw Object.assign(new Error('RPGmap 服务器未就绪，请从启动器启动游戏或重新连接服务器。'), { code: 'server_unavailable' });
  const defaultRuleset = listBuiltInRulesets()[0];
  if (!defaultRuleset) throw new Error('没有可用的 RPGmap Ruleset');
  const world = readServerWorldBootstrap(server.world, { defaultRuleset });
  if (world.kind === 'empty') { globalThis.location.replace('/setup'); return; }
  await registerInstalledMapPackages(mapPackageRegistry);
  await loadInstalledRulesetReference(world.ruleset);
  if (!world.mapPackage) throw Object.assign(new Error('活动场景缺少已安装地图引用'), { code: 'map_package_not_found' });
  setBootStatus(`World：${world.worldName || 'RPGmap'} · 正在加载地图 Runtime…`);
  if (typeof globalThis.requestAnimationFrame === 'function') await new Promise(requestAnimationFrame);
  const { startHostedMapRuntime } = await import('./runtime/hosted-map-runtime.js');
  return startHostedMapRuntime({ appContainer, mapPackageRegistry, mapReference: world.mapPackage,
    rulesetReference: world.ruleset, worldId: world.worldId, worldName: world.worldName, setBootStatus });
}

startHostedRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  setBootStatus(`启动失败：${error?.message || error}`, { error: true });
});
