import { createBrowserStorage, createMemoryStorage } from './app/storage-adapter.js';
import { listBuiltInRulesets } from './ruleset/metadata.js';
import { mapPackageRegistry } from './map-package/registry.js';
import { registerInstalledMapPackages, loadInstalledRulesetReference } from './adapters/installed-packages.js';
import { readRpgMapServerBootstrap } from './multiplayer/server-bootstrap.js';
import { readServerWorldBootstrap, readWorldBootstrap } from './world/bootstrap.js';

function setBootStatus(message, { error = false } = {}) {
  const node = document.querySelector('[data-rpgmap-boot-status]');
  if (!node) return;
  node.textContent = message;
  node.dataset.error = error ? 'true' : 'false';
}

async function yieldForFirstPaint() {
  if (typeof globalThis.requestAnimationFrame !== 'function') return;
  await new Promise(requestAnimationFrame);
}

function firstRegisteredRuleset() {
  const rulesets = listBuiltInRulesets();
  if (!rulesets.length) throw new Error('没有可用的 RPGmap Ruleset');
  return rulesets[0];
}

function defaultMapReference() {
  const maps = mapPackageRegistry.list();
  const preferred = maps[0];
  if (!preferred) throw new Error('没有可用的 RPGmap MapPackage');
  return { id: preferred.id, version: preferred.version || null };
}

async function chooseLocalWorld(appContainer, storageAdapter, defaultRuleset) {
  const [{ createWorldCatalogManager }, { chooseWorldBeforeMap }] = await Promise.all([
    import('./world/manager.js'),
    import('./world/setup.js'),
  ]);
  const manager = createWorldCatalogManager(storageAdapter);
  manager.adoptLegacyMapWorld({
    mapPackage: defaultMapReference(),
    fallbackRuleset: { id: defaultRuleset.id, version: defaultRuleset.version },
  });
  while (true) {
    const choice = await chooseWorldBeforeMap({
      container: appContainer,
      manager,
      rulesets: listBuiltInRulesets(),
      mapPackages: mapPackageRegistry.list(),
    });
    if (choice?.restart) continue;
    return { manager, ...choice };
  }
}

export async function startRpgMap() {
  const appContainer = document.getElementById('app');
  if (!appContainer) throw new Error('缺少 RPGmap 应用容器');

  if (globalThis.location.pathname === '/setup') {
    const { startDesktopSetup } = await import('./app/desktop-setup.js');
    return startDesktopSetup({ container: appContainer });
  }
  await registerInstalledMapPackages(mapPackageRegistry);
  const bootstrapStorage = createBrowserStorage();
  const defaultRuleset = firstRegisteredRuleset();
  setBootStatus('正在检查 Windows RPGmap Server 与 World…');
  const serverBootstrap = await readRpgMapServerBootstrap();
  const { serverRuntime } = serverBootstrap;

  let worldManager = null;
  let worldDescriptor = null;
  let raw = null;
  let worldBootstrap;
  let worldId;
  let worldName;

  if (serverRuntime) {
    worldBootstrap = readServerWorldBootstrap(serverBootstrap.world, { defaultRuleset });
    worldId = worldBootstrap.worldId || serverBootstrap.world?.worldId || 'world-default';
    if (worldBootstrap.kind === 'empty') {
      globalThis.location.replace('/setup');
      return;
    } else {
      worldName = worldBootstrap.worldName || 'RPGmap Server World';
    }
  } else {
    const choice = await chooseLocalWorld(appContainer, bootstrapStorage, defaultRuleset);
    worldManager = choice.manager;
    worldDescriptor = choice.descriptor;
    raw = choice.raw;
    worldBootstrap = readWorldBootstrap(raw, { defaultRuleset: worldDescriptor.ruleset });
    worldId = worldDescriptor.id;
    worldName = worldBootstrap.worldName || worldDescriptor.name;
  }

  const rulesetReference = serverRuntime && worldBootstrap.kind === 'empty'
    ? worldDescriptor.ruleset : worldBootstrap.ruleset;
  await loadInstalledRulesetReference(rulesetReference);
  const mapReference = worldBootstrap.mapPackage
    || worldDescriptor?.mapPackage
    || defaultMapReference();
  setBootStatus(`World：${worldName} · ${rulesetReference.id} · 正在加载地图 Runtime…`);
  await yieldForFirstPaint();
  const { startMapRuntime } = await import('./runtime/map-runtime.js');
  return startMapRuntime({
    appContainer,
    bootstrapStorage,
    mapPackageRegistry,
    mapReference,
    raw,
    rulesetReference,
    serverRuntime,
    worldId,
    worldManager,
    worldName,
    setBootStatus,
  });
}

startRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  const detail = error?.message || String(error);
  setBootStatus(`启动失败：${detail}`, { error: true });
});
