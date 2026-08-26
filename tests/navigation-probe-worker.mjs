import { parentPort, workerData } from 'node:worker_threads';
import { createNavigationGrid, inspectDirectNavigationPath } from '../src/engine/navigation.js';

const map = workerData.map || {
  width: 6000,
  height: 5000,
  navigation: { bridgeFeatureIds: [] },
  roadBuffers: [],
  liquidBodies: [],
  floodRules: {},
  features: [],
};

const navigation = createNavigationGrid(map, {}, null, {
  appState: { sceneEvents: [], preferences: { featureStates: {} } },
  moverContext: { elevationFt: 0, diameterMeters: 1 },
});
parentPort.postMessage(inspectDirectNavigationPath(navigation, workerData.start, workerData.destination));
