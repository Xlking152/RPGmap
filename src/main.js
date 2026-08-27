import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createRpgMapApp } from './engine/app.js';
import { createBrowserStorage, createMemoryStorage } from './app/storage.js';
import { createAppLifecycleSystem } from './engine/lifecycle.js';
import { createMovementSystem } from './movement/index.js';
import { createMeasurementSystem } from './measurement/index.js';
import { createEntitySystem } from './entities/index.js';
import { createAppShellUi, createCanonicalPanelOwnershipSystem } from './ui/index.js';
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
import { createCharacterRetirementSystem } from './legacy/character-retirement.js';

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

  // Before a World exists we still need a ruleset to interpret legacy actors.
  // World V2 now stores the canonical ruleset reference; this browser value is
  // only the first-run/default choice used while opening or migrating a World.
  const bootstrapStorage = createBrowserStorage();
  const ruleset = await chooseRulesetBeforeMap({
    container: appContainer,
    storageAdapter: bootstrapStorage,
  });

  setBootStatus(`规则包：${ruleset.title} · 正在检查 Windows RPGmap Server…`);
  const serverRuntime = await detectRpgMapServer();

  // The packaged multiplayer server owns the canonical World under map/.
  // Do not synchronously load a stale browser localStorage World first.
  const storageAdapter = serverRuntime ? createMemoryStorage() : createBrowserStorage();
  setBootStatus(serverRuntime
    ? `规则包：${ruleset.title} · 服务器已连接，正在载入 World…`
    : `规则包：${ruleset.title} · 正在载入本地 World…`);

  await yieldForFirstPaint();

  const mapPackage = createDefaultMapPackage();
  const selectionSystem = createSelectionSystem();

  return createRpgMapApp({
    container: appContainer,
    mapPackage,
    storageAdapter,
    tools: [
      createAppLifecycleSystem(),
      // World V2 owns Ruleset + Actors + Scenes. It must wrap AppCore commit /
      // import boundaries before Entity, Status, Movement, Combat, or LAN tools
      // begin mutating the active-scene projection.
      createWorldSystem(),
      // Token Runtime V2 is the canonical Scene-token mutation surface.
      createTokenRuntimeSystem(),
      createMovementSystem({ defaultStep: 5, autoStep: true }),
      // The legacy AppCore panel nodes are detached once. Modern Entity and
      // Feature UI owns the visible panels directly instead of observing and
      // replacing legacy Character DOM after every render.
      createCanonicalPanelOwnershipSystem(),
      createEntitySystem({ dropLegacyMarkers: false }),
      createStatusSystem(),
      // Status writes still use the existing server-authoritative protocol,
      // while reads for unlinked Tokens resolve Base Actor + actorDelta.
      createTokenStatusBridgeSystem(),
      createStatusUiSystem(),
      createAppShellUi(),
      createMeasurementSystem(),
      selectionSystem,
      createTokenRendererSystem(),
      createFeatureInteractionSystem(),
      createTokenElevationSystem(),
      createHealthSystem(),
      createChatSystem({ selection: selectionSystem }),
      createDamageSystem({ selection: selectionSystem }),
      createHealingSystem({ selection: selectionSystem }),
      createCombatSystem({ selection: selectionSystem }),
      createMultiplayerSystem(),
      createMultiplayerHostBootstrapSystem(),
      // Register last: all live workflows are canonical at this point. The old
      // Character parser can remain for one-way SaveV2 migration, but no public
      // Character mutation/selection API or Leaflet pane survives into runtime.
      createCharacterRetirementSystem(),
    ]
  });
}

startRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  const detail = error?.message || String(error);
  setBootStatus(`启动失败：${detail}`, { error: true });
});
