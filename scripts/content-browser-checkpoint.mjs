export async function checkOfflineContentUpgrade({ socket, send, evaluate, retry, targetUrl }) {
  const failures = [];
  const intercept = event => {
    const message = JSON.parse(String(event.data));
    if (message.method !== 'Fetch.requestPaused') return;
    send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      body: Buffer.from('{"status":"offline"}').toString('base64'),
    }).catch(error => failures.push(error.message));
  };
  const worldId = 'smoke-offline-upgrade', key = `rpgmap:world:${worldId}:v1`;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOc8AAAAASUVORK5CYII=';
  const actorId = await evaluate(`(() => {
    const api = document.querySelector('#app').rpgMapApp;
    const world = api.world.get(), scene = world.scenes.find(value => value.id === world.activeSceneId);
    const actor = structuredClone(world.actors[0]);
    const rewriteImages = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (['img', 'avatarDataUrl', 'src'].includes(key)) value[key] = ${JSON.stringify(png)};
        else rewriteImages(child);
      }
    };
    rewriteImages(actor); actor.img = ${JSON.stringify(png)};
    const snapshot = { saveVersion: 2, mapId: scene.mapPackage.id, mapVersion: scene.mapPackage.version,
      markers: [], attackAreas: [], sceneEvents: [], preferences: { worldV2: {
        ...world, id: '${worldId}', name: '离线升级验收', actors: [actor], templateLibrary: {},
        scenes: [{ ...scene, tokens: [], markers: [], attackAreas: [], combat: null }],
      } } };
    localStorage.setItem('${key}', JSON.stringify(snapshot));
    localStorage.setItem('rpgmap:world-catalog:v1', JSON.stringify({ schemaVersion: 1, activeWorldId: '${worldId}', worlds: [{
      id: '${worldId}', name: '离线升级验收', storageKey: '${key}', ruleset: world.ruleset, mapPackage: scene.mapPackage,
    }] }));
    return actor.id;
  })()`);
  socket.addEventListener('message', intercept);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/health', requestStage: 'Request' }] });
  try {
    const open = async () => {
      await send('Page.navigate', { url: new URL('/', targetUrl).href });
      await retry(() => evaluate(`Boolean(document.querySelector('[data-world-open="${worldId}"]'))`), 'offline World Manager');
      await evaluate(`document.querySelector('[data-world-open="${worldId}"]').click()`);
      await retry(() => evaluate(`(() => {
        const api = document.querySelector('#app')?.rpgMapApp;
        return api?.world?.get()?.id === '${worldId}' && !api.multiplayer.getStatus().connected;
      })()`), 'offline runtime after migration');
      await evaluate(`document.querySelector('[data-mp-close]')?.click()`);
    };
    await open();
    const first = await evaluate(`(async () => {
      const api = document.querySelector('#app').rpgMapApp, actor = api.world.get().actors[0];
      if (!/^asset:[a-f0-9]{64}$/.test(actor.img)) throw new Error('Inline image was not migrated');
      const blob = await api.content.get(actor.img);
      if (blob.type !== 'image/png' || blob.size !== 68) throw new Error('Migrated image bytes changed');
      const before = localStorage.getItem('${key}');
      const broken = api.exportState(); broken.preferences.worldV2.actors[0].img = 'data:image/png;base64,broken';
      try { await api.importState(broken); throw new Error('Damaged image import succeeded'); }
      catch (error) { if (error.code !== 'invalid_image_data_url') throw error; }
      if (localStorage.getItem('${key}') !== before) throw new Error('Damaged import changed durable World');
      return { reference: actor.img, records: (await api.content.list()).length };
    })()`);
    await open();
    const result = await evaluate(`(async () => {
      const api = document.querySelector('#app').rpgMapApp;
      if (api.world.get().actors[0].img !== '${first.reference}' || (await api.content.list()).length !== ${first.records}) throw new Error('Reload repeated image extraction');
      const next = api.exportState(); next.preferences.worldV2.name = '离线恢复验收';
      await api.importState(next);
      if (api.world.get().name !== '离线恢复验收') throw new Error('Offline import was not applied');
      if (JSON.parse(localStorage.getItem('${key}')).preferences.worldV2.name !== '离线恢复验收') throw new Error('Offline import was not durable');
      const backups = await new Promise((resolve, reject) => {
        const request = indexedDB.open('rpgmap-content-v1:${worldId}', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('upgrades');
          tx.objectStore('upgrades').getAll().onsuccess = event => resolve(event.target.result);
          tx.oncomplete = () => db.close();
        };
      });
      if (backups.some(value => value.id === 'pending') || backups.length !== 2) throw new Error('Missing or repeated offline checkpoints');
      if (!backups.some(value => value.beforeRaw.includes('data:image/png;base64,'))) throw new Error('Original inline image backup lost');
      api.entities.openActor('${actorId}', 'public-profile');
      return { reference: '${first.reference}', checkpoints: backups.length, damagedImportRejected: true, reloadStable: true };
    })()`);
    await retry(() => evaluate(`(() => {
      const images = [...document.querySelectorAll('img[data-content-ref="${first.reference}"]')];
      return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
    })()`), 'offline IndexedDB image hydration');
    if (failures.length) throw new Error(failures.join('; '));
    return result;
  } finally {
    await send('Fetch.disable');
    socket.removeEventListener('message', intercept);
  }
}
