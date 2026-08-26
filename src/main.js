import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createRpgMapApp } from './engine/app.js';
import { createBrowserStorage, createMemoryStorage } from './app/storage.js';
import { createAppLifecycleSystem } from './engine/lifecycle.js';
import { createMovementSystem } from './movement/index.js';
import { createMeasurementSystem } from './measurement/index.js';
import { createEntitySystem } from './entities/index.js';
import { createAppShellUi } from './ui/index.js';
import { createSelectionSystem } from './selection/index.js';
import { createFeatureInteractionSystem } from './interaction/index.js';
import { createElevationSystem } from './elevation/index.js';
import { createHealthSystem } from './health/index.js';
import { createChatSystem } from './chat/index.js';
import { createDamageSystem } from './damage/index.js';
import { createHealingSystem } from './healing/index.js';
import { createCombatSystem } from './combat/index.js';
import { createMultiplayerSystem } from './multiplayer/index.js';
import { createMultiplayerHostBootstrapSystem } from './multiplayer/host-bootstrap.js';
import { createDefaultMapPackage } from './map-package/default-map.js';
import { createStatusSystem, createStatusUiSystem } from './status/index.js';

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
  setBootStatus('正在检查 Windows RPGmap Server…');
  const serverRuntime = await detectRpgMapServer();

  // The packaged multiplayer server owns the canonical World under map/.
  // Do not synchronously load a stale browser localStorage World first.
  const storageAdapter = serverRuntime ? createMemoryStorage() : createBrowserStorage();
  setBootStatus(serverRuntime
    ? '服务器已连接，正在载入地图…'
    : '正在载入本地地图…');

  await yieldForFirstPaint();

  const mapPackage = createDefaultMapPackage();
  const selectionSystem = createSelectionSystem();

  return createRpgMapApp({
    container: document.getElementById('app'),
    mapPackage,
    storageAdapter,
    tools: [
      createAppLifecycleSystem(),
      createMovementSystem({ defaultStep: 5, autoStep: true }),
      // Legacy markers are data.  They remain untouched until a GM explicitly
      // confirms their migration from the in-app review flow.
      createEntitySystem({ dropLegacyMarkers: false }),
      createStatusSystem(),
      createStatusUiSystem(),
      createAppShellUi(),
      createMeasurementSystem(),
      selectionSystem,
      createFeatureInteractionSystem(),
      createElevationSystem(),
      createHealthSystem(),
      createChatSystem({ selection: selectionSystem }),
      createDamageSystem({ selection: selectionSystem }),
      createHealingSystem({ selection: selectionSystem }),
      createCombatSystem({ selection: selectionSystem }),
      createMultiplayerSystem(),
      createMultiplayerHostBootstrapSystem()
    ]
  });
}

startRpgMap().catch(error => {
  console.error('[RPGmap] startup failed', error);
  const detail = error?.message || String(error);
  setBootStatus(`启动失败：${detail}`, { error: true });
});
