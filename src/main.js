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
import { loadRuntimeMapPackage } from './maps/loader.js';

async function bootstrap() {
  const mapPackage = await loadRuntimeMapPackage();
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
      createMultiplayerSystem(),
    ],
  });
}

bootstrap().catch(error => {
  console.error('[RPGmap] startup failed:', error);
  const container = document.getElementById('app');
  if (container) {
    container.innerHTML = `
      <main style="max-width:760px;margin:64px auto;padding:24px;font-family:system-ui,sans-serif;line-height:1.6">
        <h1>RPGmap 地图加载失败</h1>
        <p>程序已经启动，但没有从 <code>maps/</code> 读取到有效 MapPackage。</p>
        <pre style="white-space:pre-wrap;background:#f5f5f5;padding:16px;border-radius:8px"></pre>
        <p>请确认发布包中的 <code>maps/index.json</code> 和对应地图目录没有被删除。</p>
      </main>`;
    const pre = container.querySelector('pre');
    if (pre) pre.textContent = error?.message || String(error);
  }
});
