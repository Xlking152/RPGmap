import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createRpgMapRuntime } from './engine/runtime.js';
import { createBrowserStorage, createMemoryStorage } from './app/storage.js';
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
import { createDefaultMapPackage } from './map-package/default-map.js';
import { createStatusSystem, createStatusUiSystem } from './status/index.js';
import { chooseRulesetBeforeMap } from './ruleset/setup.js';
import { createWorldSystem } from './world/index.js';
import {
  createTokenRuntimeSystem,
  createTokenStatusBridgeSystem,
} from './token/index.js';
import { createTokenRendererSystem } from './render/token-layer.js';
import { createSceneAreaSystem } from './scene/areas.js';

function setBootStatus(message, { error = false } = {}) {
  const node = document.querySelector('[data-rpgmap-boot-status]');
  if (!node) return;
  node.textContent = message;
  node.dataset.error = error ? 'true' : 'false';
}

export async function detectRpgMapServer({
  fetchImpl = globalThis.fetch,
  timeoutMs = 1500,
} = {}) {
  if (typeof fetchImpl !== 'function') return false;
  const protocol = globalThis.location?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl('/api/health', {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.status === 'ok' && health?.app === 'RPGmap' && health?.multiplayer?.enabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function yieldForFirstPaint() {
  if (typeof globalThis.requestAnimationFrame !== 'function') return;
  await new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export async function startRpgMap() {
  const appContainer = document.getElementById('app');
  const bootstrapStorage = createBrowserStorage();
  const ruleset = await chooseRulesetBeforeMap({
    container: appContainer,
    storageAdapter: bootstrapStorage,
  });

  setBootStatus(`规则包：${ruleset.title} · 正在检查 Windows RPGmap Server…`);
  const serverRuntime = await detectRpgMapServer();

  // The packaged multiplayer server owns the canonical World under map/.
  // Do not synchronously install a stale browser snapshot before LAN sync.
  const storageAdapter = serverRuntime ? createMemoryStorage() : createBrowserStorage();
  setBootStatus(serverRuntime
    ? `规则包：${ruleset.title} · 服务器已连接，正在载入 World…`
    : `规则包：${ruleset.title} · 正在载入本地 World…`);

  await yieldForFirstPaint();

  const mapPackage = createDefaultMapPackage();
  const selectionSystem = createSelectionSystem();

  return createRpgMapRuntime({
    container: appContainer,
    mapPackage,
    ruleset,
    storageAdapter,
    tools: [
      createAppLifecycleSystem(),
      createWorldSystem(),
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
}

startRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  const detail = error?.message || String(error);
  setBootStatus(`启动失败：${detail}`, { error: true });
});
