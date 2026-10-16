'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every operation has a fixed channel and a bounded argument. No path, URL,
// Node.js object, ipcRenderer instance, or general file operation is exposed.
contextBridge.exposeInMainWorld('rpgmapDesktop', Object.freeze({
  launchWorld: worldId => ipcRenderer.invoke('rpgmap:launch-world', String(worldId || '')),
  openDataDirectory: () => ipcRenderer.invoke('rpgmap:open-data'),
  importPackage: kind => ipcRenderer.invoke('rpgmap:import-package', String(kind || '')),
  importWorld: () => ipcRenderer.invoke('rpgmap:import-world'),
  importLegacyDirectory: () => ipcRenderer.invoke('rpgmap:import-legacy-directory'),
  showSetup: () => ipcRenderer.invoke('rpgmap:show-setup'),
  setPort: port => ipcRenderer.invoke('rpgmap:set-port', Number(port)),
  openGameInBrowser: () => ipcRenderer.invoke('rpgmap:open-browser'),
  installUpdate: () => ipcRenderer.invoke('rpgmap:install-update'),
  exit: () => ipcRenderer.invoke('rpgmap:exit'),
}));
