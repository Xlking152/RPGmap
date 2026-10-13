const clone = structuredClone;

function currentMapId(api) {
  return String(api.mapPackage?.id ?? api.mapPackage?.mapId ?? '');
}

function sceneMapId(scene) {
  return String(scene?.mapPackage?.id ?? scene?.mapPackage?.mapId ?? '');
}

function mapVersion(mapPackage) {
  return String(mapPackage?.version ?? mapPackage?.mapVersion ?? '1');
}

function canManageScenes(api) {
  const status = api.multiplayer?.getConnectionState?.() ?? api.multiplayer?.getStatus?.();
  const role = status?.session?.role ?? status?.role ?? api.multiplayer?.getCapabilities?.()?.role;
  return role !== 'player' && (!status?.connected || role === 'gm');
}

function requireSceneManager(api) {
  if (!canManageScenes(api)) {
    throw Object.assign(new Error('只有 GM 可以创建或切换场景'), { code: 'scene_manager_gm_only' });
  }
}

function installSceneSelector(api, sceneApi) {
  const mapElement = api.map?.getContainer?.();
  const documentNode = mapElement?.ownerDocument || globalThis.document;
  const shell = mapElement?.closest?.('.app-shell');
  const toolbar = shell?.querySelector?.('.toolbar-right');
  if (!documentNode || !toolbar || toolbar.querySelector('[data-scene-manager]')) return;

  const wrap = documentNode.createElement('div');
  wrap.dataset.sceneManager = 'true';
  wrap.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;color:#5d696a';
  wrap.innerHTML = '<span>场景</span><select aria-label="当前场景" data-scene-manager-select style="max-width:180px;padding:5px 6px;border:1px solid #c8d1ce;border-radius:6px;background:#fff"></select><select aria-label="新场景的地图" data-scene-manager-map style="max-width:180px;padding:5px 6px;border:1px solid #c8d1ce;border-radius:6px;background:#fff"></select><button type="button" data-scene-manager-create>＋ 场景</button>';
  toolbar.prepend(wrap);
  const select = wrap.querySelector('select');
  const mapSelect = wrap.querySelector('[data-scene-manager-map]');
  const createButton = wrap.querySelector('[data-scene-manager-create]');
  let maps = [];
  let pending = false;

  function option(value, label, selected = false) {
    const node = documentNode.createElement('option');
    node.value = value; node.textContent = label; node.selected = selected;
    return node;
  }

  function render() {
    const active = sceneApi.active();
    select.replaceChildren(...sceneApi.list().map(scene => option(String(scene.id), String(scene.name || scene.id), String(scene.id) === String(active?.id))));
    const previousMap = maps[Number(mapSelect.value)];
    maps = sceneApi.availableMapPackages();
    mapSelect.replaceChildren(...maps.map((map, index) => option(String(index), `${map.title || map.id} · ${map.version || '1'}`,
      previousMap ? map.id === previousMap.id && map.version === previousMap.version : index === 0)));
    const manager = canManageScenes(api);
    select.disabled = pending || !manager;
    mapSelect.hidden = !manager;
    createButton.hidden = !manager;
    mapSelect.disabled = pending || !maps.length;
    createButton.disabled = pending || !maps.length;
  }
  render();
  const off = ['world:ready', 'state:commit', 'multiplayer:capabilities', 'packages:changed'].map(event => api.on?.(event, render));
  off.push(api.on?.('app:destroy', () => { off.splice(0).forEach(dispose => dispose?.()); wrap.remove(); }));
  select.addEventListener('change', async () => {
    if (pending) return;
    const sceneId = select.value;
    pending = true; render();
    try { await sceneApi.activate(sceneId); }
    catch (error) {
      console.error('[RPGmap Scene Manager] activation failed', error);
      api.setStatus?.(`Scene 切换失败：${error?.message || error}`);
      render();
    } finally { pending = false; render(); }
  });
  createButton.addEventListener('click', async () => {
    if (pending || !canManageScenes(api)) return;
    const map = maps[Number(mapSelect.value)];
    if (!map) return;
    const name = documentNode.defaultView?.prompt?.('新场景名称', map.title || map.id);
    if (name == null) return;
    pending = true; render();
    try {
      const scene = await sceneApi.create({ name: String(name).trim(), mapPackage: { id: map.id, version: map.version } });
      api.showToast?.(`场景「${scene.name || scene.id}」已创建，可在场景列表中切换`, 'success');
    } catch (error) {
      api.showToast?.(`创建场景失败：${error?.message || error}`, 'error');
    } finally { pending = false; render(); }
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
      let switching = false;

      const sceneApi = {
        list() { return clone(api.world.listScenes()); },
        active() { return clone(api.world.getActiveScene()); },
        availableMapPackages() { return clone(mapPackages.list()); },
        async create({ name = '', mapPackage } = {}) {
          requireSceneManager(api);
          const target = await mapPackages.load(mapPackage || { id: currentMapId(api), version: mapVersion(api.mapPackage) });
          return api.world.createScene({ name, mapPackage: target });
        },
        async activate(sceneId) {
          requireSceneManager(api);
          if (switching || api.world.isSceneTransitionPending?.()) {
            throw Object.assign(new Error('场景正在切换或重置，请等待完成'), { code: 'scene_transition_pending' });
          }
          const world = api.world.get();
          const target = world.scenes.find(scene => String(scene.id) === String(sceneId));
          if (!target) throw new Error(`Unknown Scene: ${sceneId}`);
          if (String(target.id) === String(world.activeSceneId)) return clone(target);
          // Resolve the exact installed package before mutating the active Scene.
          // Missing assets or an unavailable version must leave the current game intact.
          switching = true;
          let started = false, reloading = false;
          try {
            await mapPackages.load(target.mapPackage);
            started = true;
            api.emit?.('scene:switch-starting', { sceneId: target.id, mapPackage: clone(target.mapPackage) });
            if (sceneMapId(target) === currentMapId(api)
              && mapVersion(target.mapPackage) === mapVersion(api.mapPackage)) {
              const active = await api.world.setActiveScene(target.id);
              api.emit?.('scene:switch-complete', { sceneId: target.id, mapPackage: clone(target.mapPackage) });
              return active;
            }

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
              if (await api.persistNow?.() === false) throw new Error('当前场景未能可靠保存，无法切换');
              if (!worldCatalogManager || !worldId) {
                const error = new Error('Cross-Map Scene activation requires local World Manager persistence');
                error.code = 'world_manager_required';
                throw error;
              }
              await worldCatalogManager.activateStoredScene(worldId, target.id);
            }
            api.emit?.('scene:reload-required', {
              sceneId: target.id,
              mapPackage: clone(target.mapPackage),
            });
            reloading = true;
            reload();
            return clone(target);
          } catch (error) {
            if (started) api.emit?.('scene:switch-failed', { sceneId: target.id });
            throw error;
          } finally {
            if (!reloading) switching = false;
          }
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
