import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Serve the unchanged installed app through its real non-multiplayer bootstrap.
// A LAN Runtime uses an intentional in-memory local overlay; that overlay is
// not the browser-persistent offline World that must survive a page reload.
export async function createPackagedOfflineServer(packageRoot) {
  const root = path.resolve(packageRoot, 'app');
  const contentTypes = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
    '.json':'application/json', '.svg':'image/svg+xml', '.webp':'image/webp',
    '.png':'image/png', '.woff2':'font/woff2', '.ico':'image/x-icon' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/api/health') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({status:'ok',app:'RPGmap',multiplayer:{enabled:false}}));
        return;
      }
      const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const bytes = await readFile(filename);
      response.setHeader('Content-Type', contentTypes[path.extname(filename)] || 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url:`http://127.0.0.1:${server.address().port}/`,
    close:() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export async function openPersistentOfflineRuntime({ evaluate, navigate, url }) {
  const fixture = await evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp,sourceId=api.vision.getSource();
    const token=api.tokens.get(sourceId);
    if(!token)throw new Error('Persistent offline fixture needs its vision Token');
    return {sourceId,token,actor:api.tokens.getActor(token.actorId)};
  })()`);
  await navigate(url);
  const waitFor = async expression => {
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
      try{if(await evaluate(expression))return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Persistent offline World failed to load');
  };
  await waitFor(`Boolean(document.querySelector('[data-world-create-form]'))`);
  await evaluate(`(() => {const form=document.querySelector('[data-world-create-form]');
    form.querySelector('[name="name"]').value='Persistent Ruins Smoke World';form.requestSubmit();return true;})()`);
  await waitFor(`Boolean(document.querySelector('#app')?.rpgMapApp?.world&&document.querySelector('.leaflet-base-pane image'))`);
  await evaluate(`(async fixture=>{
    const api=document.querySelector('#app').rpgMapApp,sceneId=api.world.getActiveScene().id;
    await api.world.performOperations([
      {type:'actor.upsert',payload:{actor:fixture.actor}},
      {type:'token.upsert',payload:{sceneId,token:fixture.token}},
      {type:'scene.settings.patch',payload:{sceneId,patch:{lineOfSightEnabled:true,movementBudgetMetersPerTurn:null}}},
    ],{source:'ruins-smoke:persistent-offline-fixture'});
    await api.vision.setSource(fixture.sourceId);api.selection.replace([fixture.sourceId],fixture.sourceId);
    if(!await api.persistNow())throw new Error('Persistent offline fixture did not save');
    return true;
  })(${JSON.stringify(fixture)})`,60000);
}
