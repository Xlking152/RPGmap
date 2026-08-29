function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function currentMapId(api) {
  return String(api.mapPackage?.id ?? api.mapPackage?.mapId ?? '');
}

function sceneMapId(scene) {
  return String(scene?.mapPackage?.id ?? scene?.mapPackage?.mapId ?? '');
}

function installSceneSelector(api, sceneApi) {
  const mapElement = api.map?.getContainer?.();
  const documentNode = mapElement?.ownerDocument || globalThis.document;
  const shell = mapElement?.closest?.('.app-shell');
  const toolbar = shell?.querySelector?.('.toolbar-right');
  if (!documentNode || !toolbar || toolbar.querySelector('[data-scene-manager]')) return;

  const wrap = documentNode.createElement('label');
  wrap.dataset.sceneManager = 'true';
  wrap.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:#5d696a';
  wrap.innerHTML = '<span>Scene</span><select data-scene-manager-select style="max-width:180px;padding:5px 6px;border:1px solid #c8d1ce;border-radius:6px;background:#fff"></select>';
  toolbar.prepend(wrap);
  const select = wrap.querySelector('select');

  function render() {
    const active = sceneApi.active();
    select.innerHTML = sceneApi.list().map(scene => `<option value="${String(scene.id).replaceAll('"', '&quot;')}" ${String(scene.id) === String(active?.id) ? 'selected' : ''}>${String(scene.name || scene.id)}</option>`).join('');
  }
  render();
  api.on?.('world:ready', render);
  api.on?.('state:commit', render);
  select.addEventListener('change', async () => {
    select.disabled = true;
    try { await sceneApi.activate(select.value); }
    catch (error) {
      console.error('[RPGmap Scene Manager] activation failed', error);
      api.setStatus?.(`Scene 切换失败：${error?.message || error}`);
      render();
    } finally { select.disabled = false; }
  });
}

export function createSceneManagerSystem({
  mapPackages,
  worldCatalogManager = null,
  worldId = null,
  reload = () => globalThis.location?.reload?.(),
} = {}) {
  return Object.freeze({
    register(api) {
      if (!api?.world?.get || api.scenes) return;
      if (!mapPackages?.load) throw new Error('Scene Manager requires MapPackage Registry');

      const sceneApi = {
        list() { return clone(api.world.listScenes()); },
        active() { return clone(api.world.getActiveScene()); },
        availableMapPackages() { return clone(mapPackages.list()); },
        async create({ name = '', mapPackage } = {}) {
          const target = await mapPackages.load(mapPackage || { id: currentMapId(api) });
          return api.world.createScene({ name, mapPackage: target });
        },
        async activate(sceneId) {
          const world = api.world.get();
          const target = world.scenes.find(scene => String(scene.id) === String(sceneId));
          if (!target) throw new Error(`Unknown Scene: ${sceneId}`);
          if (String(target.id) === String(world.activeSceneId)) return clone(target);
          if (sceneMapId(target) === currentMapId(api)) return api.world.setActiveScene(target.id);

          const multiplayer = api.multiplayer?.getStatus?.();
          if (multiplayer?.connected) {
            await api.world.performOperations([{
              type: 'scene.activate',
              payload: { sceneId: String(target.id) },
            }], {
              source: 'scene:activate-map-package',
              render: false,
              kind: 'world',
            });
          } else {
            api.persistNow?.();
            if (!worldCatalogManager || !worldId) {
              const error = new Error('Cross-Map Scene activation requires local World Manager persistence');
              error.code = 'world_manager_required';
              throw error;
            }
            worldCatalogManager.activateStoredScene(worldId, target.id);
          }
          api.emit?.('scene:reload-required', {
            sceneId: target.id,
            mapPackage: clone(target.mapPackage),
          });
          reload();
          return clone(target);
        },
      };

      api.scenes = sceneApi;
      installSceneSelector(api, sceneApi);
      api.emit?.('scenes:ready', {
        activeSceneId: sceneApi.active()?.id || null,
        count: sceneApi.list().length,
      });
    },
  });
}
