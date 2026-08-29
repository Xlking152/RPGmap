import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createRpgMapRuntime } from './engine/runtime.js';
import { createBrowserStorage, createMemoryStorage } from './app/storage.js';
import { prepareStoredWorldState } from './app/world-storage.js';
import { createAppLifecycleSystem } from './engine/lifecycle.js';
import { createMovementSystem } from './movement/index.js';
import { createMeasurementSystem } from './measurement/index.js';
import { createEntitySystem } from './entities/index.js';
import { createAppShellUi } from './ui/index.js';
import { createSelectionSystem } from './selection/index.js';
import { createFeatureInteractionSystem } from './interaction/index.js';
import { createTokenElevationSystem } from './elevation/index.js';
import { createHealthSystem } from './health/index.js';
import { createChatSystem } from './chat/index.js';
import { createDamageSystem } from './damage/index.js';
import { createHealingSystem } from './healing/index.js';
import { createCombatSystem } from './combat/index.js';
import { createMultiplayerSystem } from './multiplayer/index.js';
import { createMultiplayerHostBootstrapSystem } from './multiplayer/host-bootstrap.js';
import { createStatusSystem, createStatusUiSystem } from './status/index.js';
import {
  listRulesets,
  resolveRulesetReference,
  setActiveRuleset,
} from './ruleset/index.js';
import { chooseRulesetBeforeMap } from './ruleset/setup.js';
import {
  createWorldCatalogManager,
  chooseWorldBeforeMap,
  createWorldSystem,
} from './world/index.js';
import { readServerWorldBootstrap, readWorldBootstrap } from './world/bootstrap.js';
import {
  DEFAULT_REFERENCE_MAP_ID,
  mapPackageRegistry,
  registerBuiltInMapPackages,
} from './map-package/index.js';
import {
  createTokenRuntimeSystem,
  createTokenStatusBridgeSystem,
} from './token/index.js';
import { createTokenRendererSystem } from './render/token-layer.js';
import { createSceneAreaSystem } from './scene/areas.js';
import { createSceneManagerSystem } from './scene/manager.js';
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
    ruleset = worldBootstrap.kind === 'empty'
      ? await chooseRulesetBeforeMap({
        container: appContainer,
        storageAdapter: createMemoryStorage(),
        forcePrompt: true,
      })
      : resolveRulesetReference(worldBootstrap.ruleset);
    worldId = worldBootstrap.worldId || serverBootstrap.world?.worldId || 'world-default';
    worldName = worldBootstrap.worldName || 'RPGmap Server World';
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
  const mapPackage = await mapPackageRegistry.load(mapReference);
  const storageAdapter = serverRuntime ? createMemoryStorage() : bootstrapStorage;
  const initialLoad = prepareStoredWorldState({
    worldId,
    worldName,
    mapPackage,
    ruleset,
    storageAdapter,
    raw: serverRuntime ? null : raw,
  });
  setActiveRuleset(ruleset.id);

  setBootStatus(serverRuntime
    ? `World：${worldName} · ${ruleset.title} · 正在连接服务器…`
    : `World：${worldName} · ${ruleset.title} · 正在载入 ${mapPackage.title || mapPackage.id}…`);
  await yieldForFirstPaint();

  const selectionSystem = createSelectionSystem();
  const runtime = createRpgMapRuntime({
    container: appContainer,
    worldId,
    worldName,
    mapPackage,
    ruleset,
    storageAdapter,
    initialLoad,
    tools: [
      createAppLifecycleSystem(),
      createWorldSystem({ worldId, worldName }),
      createSceneManagerSystem({
        mapPackages: mapPackageRegistry,
        worldCatalogManager: worldManager,
        worldId,
      }),
      createTokenRuntimeSystem(),
      selectionSystem,
      createMovementSystem({ defaultStep: 5, autoStep: true }),
      createEntitySystem({ dropLegacyMarkers: false }),
      createStatusSystem(),
      createTokenStatusBridgeSystem(),
      createStatusUiSystem(),
      createTokenRendererSystem(),
      createFeatureInteractionSystem(),
      createTokenElevationSystem(),
      createSceneAreaSystem(),
      createAppShellUi(),
      createMeasurementSystem(),
      createHealthSystem(),
      createChatSystem({ selection: selectionSystem }),
      createDamageSystem({ selection: selectionSystem }),
      createHealingSystem({ selection: selectionSystem }),
      createCombatSystem({ selection: selectionSystem }),
      createMultiplayerSystem(),
      createMultiplayerHostBootstrapSystem(),
    ],
  });

  if (worldManager && worldId) {
    const refreshCatalog = () => worldManager.updateFromSave(worldId, runtime.exportState());
    refreshCatalog();
    runtime.on?.('state:saved', refreshCatalog);
  }
  return runtime;
}

startRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  const detail = error?.message || String(error);
  setBootStatus(`启动失败：${detail}`, { error: true });
});
