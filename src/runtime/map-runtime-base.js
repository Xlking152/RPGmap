import 'leaflet/dist/leaflet.css';
import '../styles.css';
import '../ui/design-tokens.css';
import '../ui/workbench.css';
import '../ui/panels.css';
import '../ui/vision-panel.css';
import '../entities/sheet/presentation.css';

import { createRpgMapRuntime } from '../engine/runtime.js';
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
import { createPermissionSystem } from '../permissions/index.js';
import { createDocumentBackendSystem } from '../documents/index.js';
import { createPerformanceDiagnosticsSystem } from '../diagnostics/runtime.js';
import { createTemplateLibrarySystem } from '../library/runtime.js';
import { createJournalSystem } from '../journal/runtime.js';
import { resolveRulesetReference, setActiveRuleset } from '../ruleset/index.js';

export async function startMapRuntimeBase({
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
  setBootStatus = () => {},
  runtimeAdapters,
  storageAdapter,
  createWorldSystem,
  createContentSystem,
  bindRuntimeWorldCatalog = () => {},
} = {}) {
  const ruleset = resolveRulesetReference(rulesetReference);
  setActiveRuleset({ id: ruleset.id, version: ruleset.version });
  const mapPackage = await mapPackageRegistry.load(mapReference);
  const initialLoad = await runtimeAdapters.prepare({ worldId, worldName, mapPackage, ruleset, storageAdapter,
    indexedDB: appContainer.ownerDocument.defaultView.indexedDB, raw: serverRuntime ? null : raw });

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
    runtimeAdapters,
    tools: [
      createAppLifecycleSystem(),
      createPerformanceDiagnosticsSystem(),
      createContentSystem({ serverRuntime, worldId }),
      createWorldSystem({ worldId, worldName }),
      createDocumentBackendSystem(),
      createTokenRuntimeSystem(),
      selectionSystem,
      createPermissionSystem(),
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
      createSceneManagerSystem({
        mapPackages: mapPackageRegistry,
        worldCatalogManager: worldManager,
        worldId,
      }),
      createTemplateLibrarySystem({ serverRuntime }),
      createJournalSystem({ serverRuntime }),
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

  bindRuntimeWorldCatalog({ runtime, worldManager, worldId });
  return runtime;
}
