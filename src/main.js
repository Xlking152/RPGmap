import 'leaflet/dist/leaflet.css';
import './styles.css';
import { createRpgMapApp } from './engine/app.js';
import { createMovementSystem } from './movement/index.js';
import { createMeasurementSystem } from './measurement/index.js';
import { createEntitySystem } from './entities/index.js';
import { createAppShellUi } from './ui/index.js';
import { createSelectionSystem } from './selection/index.js';
import { createHealthSystem } from './health/index.js';
import { createChatSystem } from './chat/index.js';
import { createDamageSystem } from './damage/index.js';
import { createHealingSystem } from './healing/index.js';
import { createCombatSystem } from './combat/index.js';
import { createMultiplayerSystem } from './multiplayer/index.js';
import { createDefaultMapPackage } from './map-package/default-map.js';

const mapPackage = createDefaultMapPackage();
const selectionSystem = createSelectionSystem();

createRpgMapApp({
  container: document.getElementById('app'),
  mapPackage,
  tools: [
    createMovementSystem({ defaultStep: 5, autoStep: true }),
    createEntitySystem({ dropLegacyMarkers: true }),
    createAppShellUi(),
    createMeasurementSystem(),
    selectionSystem,
    createHealthSystem(),
    createChatSystem({ selection: selectionSystem }),
    createDamageSystem({ selection: selectionSystem }),
    createHealingSystem({ selection: selectionSystem }),
    createCombatSystem({ selection: selectionSystem }),
    createMultiplayerSystem()
  ]
});
