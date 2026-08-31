import 'leaflet/dist/leaflet.css';
import '../styles.css';

import { createRpgMapRuntime } from '../engine/runtime.js';
import { createMemoryStorage } from '../app/storage.js';
import { prepareStoredWorldState } from '../app/world-storage.js';
import { createAppLifecycleSystem } from '../engine/lifecycle.js';
import { createMovementSystem } from '../movement/index.js';
import { createMeasurementSystem } from '../measurement/index.js';
import { createEntitySystem } from '../entities/index.js';
import { createAppShellUi } from '../ui/index.js';
import { createSelectionSystem } from '../selection/index.js';
import { createFeatureInteractionSystem } from '../interaction/index.js';
import { createTokenElevationSystem } from '../elevation/index.js';
import { createHealthSystem } from '../health/index.js';
import { createChatSystem } from '../chat/index.js';
import { createDamageSystem } from '../damage/index.js';
import { createHealingSystem } from '../healing/index.js';
import { createCombatSystem } from '../combat/index.js';
import { createMultiplayerSystem } from '../multiplayer/index.js';
import { createMultiplayerHostBootstrapSystem } from '../multiplayer/host-bootstrap.js';
import { createStatusSystem, createStatusUiSystem } from '../status/index.js';
import { createWorldSystem } from '../world/system.js';
import {
  createTokenRuntimeSystem,
  createTokenStatusBridgeSystem,
} from '../token/index.js';
import { createTokenRendererSystem } from '../render/token-layer.js';
import { createSceneAreaSystem } from '../scene/areas.js';
import { createSceneAreaHandleSystem } from '../scene/area-handles.js';
import { createSceneManagerSystem } from '../scene/manager.js';
import { createVisionFogSystem } from '../vision/index.js';
import { createLightweightMarkerSystem } from '../marker/index.js';

export async function startMapRuntime({
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
  setBootStatus = () => {},
} = {}) {
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

  setBootStatus(serverRuntime
    ? `World：${worldName} · ${ruleset.title} · 正在连接服务器…`
    : `World：${worldName} · ${ruleset.title} · 正在载入 ${mapPackage.title || mapPackage.id}…`);

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
      createVisionFogSystem(),
      createTokenRendererSystem(),
      createFeatureInteractionSystem(),
      createTokenElevationSystem(),
      createSceneAreaSystem(),
      createSceneAreaHandleSystem(),
      createAppShellUi(),
      createLightweightMarkerSystem(),
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
