import { createBrowserStorage, createMemoryStorage } from './app/storage.js';
import {
  listRulesets,
  resolveRulesetReference,
  setActiveRuleset,
} from './ruleset/index.js';
import { createWorldCatalogManager } from './world/manager.js';
import { chooseWorldBeforeMap } from './world/setup.js';
import { readServerWorldBootstrap, readWorldBootstrap } from './world/bootstrap.js';
import { DEFAULT_REFERENCE_MAP_ID } from './map-package/constants.js';
import { mapPackageRegistry } from './map-package/registry.js';
import { registerBuiltInMapPackages } from './map-package/builtins.js';
import { detectRpgMapServer, readRpgMapServerBootstrap } from './multiplayer/server-bootstrap.js';

export { detectRpgMapServer, readRpgMapServerBootstrap } from './multiplayer/server-bootstrap.js';

function setBootStatus(message, { error = false } = {}) {
  const node = document.querySelector('[data-rpgmap-boot-status]');
  if (!node) return;
  node.textContent = message;
  node.dataset.error = error ? 'true' : 'false';
}

async function yieldForFirstPaint() {
  if (typeof globalThis.requestAnimationFrame !== 'function') return;
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function firstRegisteredRuleset() {
  const rulesets = listRulesets();
  if (!rulesets.length) throw new Error('没有可用的 RPGmap Ruleset');
  return rulesets[0];
}

function defaultMapReference() {
  const maps = mapPackageRegistry.list();
  const preferred = maps.find(item => item.id === DEFAULT_REFERENCE_MAP_ID) || maps[0];
  if (!preferred) throw new Error('没有可用的 RPGmap MapPackage');
  return { id: preferred.id, version: preferred.version || null };
}

async function chooseLocalWorld(appContainer, storageAdapter, defaultRuleset) {
  const manager = createWorldCatalogManager(storageAdapter);
  manager.adoptLegacyMapWorld({
    mapPackage: defaultMapReference(),
    fallbackRuleset: { id: defaultRuleset.id, version: defaultRuleset.version },
  });
  while (true) {
    const choice = await chooseWorldBeforeMap({
      container: appContainer,
      manager,
      rulesets: listRulesets(),
      mapPackages: mapPackageRegistry.list(),
    });
    if (choice?.restart) continue;
    return { manager, ...choice };
  }
}

export async function startRpgMap() {
  const appContainer = document.getElementById('app');
  if (!appContainer) throw new Error('缺少 RPGmap 应用容器');

  registerBuiltInMapPackages(mapPackageRegistry);
  const bootstrapStorage = createBrowserStorage();
  const defaultRuleset = firstRegisteredRuleset();
  setBootStatus('正在检查 Windows RPGmap Server 与 World…');
  const serverBootstrap = await readRpgMapServerBootstrap();
  const { serverRuntime } = serverBootstrap;

  let worldManager = null;
  let worldDescriptor = null;
  let raw = null;
  let worldBootstrap;
  let ruleset;
  let worldId;
  let worldName;

  if (serverRuntime) {
    worldBootstrap = readServerWorldBootstrap(serverBootstrap.world, { defaultRuleset });
    if (worldBootstrap.kind === 'empty') {
      const choice = await chooseLocalWorld(appContainer, createMemoryStorage(), defaultRuleset);
      worldDescriptor = choice.descriptor;
      ruleset = resolveRulesetReference(worldDescriptor.ruleset);
      worldId = worldBootstrap.worldId || serverBootstrap.world?.worldId || 'world-default';
      worldName = worldDescriptor.name;
    } else {
      ruleset = resolveRulesetReference(worldBootstrap.ruleset);
      worldId = worldBootstrap.worldId || serverBootstrap.world?.worldId || 'world-default';
      worldName = worldBootstrap.worldName || 'RPGmap Server World';
    }
  } else {
    const choice = await chooseLocalWorld(appContainer, bootstrapStorage, defaultRuleset);
    worldManager = choice.manager;
    worldDescriptor = choice.descriptor;
    raw = choice.raw;
    worldBootstrap = readWorldBootstrap(raw, { defaultRuleset: worldDescriptor.ruleset });
    ruleset = resolveRulesetReference(worldBootstrap.ruleset);
    worldId = worldDescriptor.id;
    worldName = worldBootstrap.worldName || worldDescriptor.name;
  }

  const mapReference = worldBootstrap.mapPackage
    || worldDescriptor?.mapPackage
    || defaultMapReference();
  setActiveRuleset(ruleset.id);

  setBootStatus(`World：${worldName} · ${ruleset.title} · 正在加载地图 Runtime…`);
  await yieldForFirstPaint();
  const { startMapRuntime } = await import('./runtime/map-runtime.js');
  return startMapRuntime({
    appContainer,
    bootstrapStorage,
    mapPackageRegistry,
    mapReference,
    raw,
    ruleset,
    serverRuntime,
    worldDescriptor,
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
