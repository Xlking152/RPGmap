import { startDesktopSetup } from '../src/app/desktop-setup.js';

// Development-only fixture. The production entry never imports this module.
const ruleset = { id: 'infinite-horror', version: '1.1.0' };
const catalog = {
  appVersion: '3.0.0', activeWorldId: 'preview-world-a',
  maps: [{ id: 'lanzhou', version: '1.1.0', name: '北宋兰州城', previewUrl: '/maps/lanzhou/runtime.svg' }],
  rulesets: [{ ...ruleset, name: '无限规则', builtIn: true }],
  worlds: [
    { id: 'preview-world-a', name: '兰州纪事', ruleset, sceneCount: 3, updatedAt: '2026-10-16T13:30:00Z', backups: [
      { id: 'preview-backup-a', name: '进入金城关前', createdAt: '2026-10-16T13:15:00Z', reason: 'manual' },
      { id: 'preview-backup-b', name: '开局', createdAt: '2026-10-15T12:30:00Z', reason: 'manual' },
    ] },
    { id: 'preview-world-b', name: '西北行旅', ruleset, sceneCount: 2, updatedAt: '2026-10-15T10:20:00Z', backups: [] },
    { id: 'preview-world-c', name: '规则与地图验收', ruleset, sceneCount: 1, updatedAt: '2026-10-14T06:05:00Z', backups: [] },
  ],
  connection: { port: 30000, playerUrls: ['http://192.168.1.18:30000'], joinCode: 'DEMO-ONLY', dataDirectory: '用户数据 / RPGmap / Preview' },
};
window.uiSetupFixture = { catalog, requests: [] };
const fetchImpl = async (endpoint, options) => {
  const input = options.body ? JSON.parse(options.body) : {};
  window.uiSetupFixture.requests.push({ endpoint, method: options.method, input });
  let result = {};
  if (endpoint === '/api/manage/catalog') result = structuredClone(catalog);
  else if (endpoint === '/api/manage/worlds' && options.method === 'POST') {
    result = { id: `preview-world-${catalog.worlds.length + 1}`, ...input, sceneCount: 1, updatedAt: new Date().toISOString(), backups: [] };
    catalog.worlds.push(result);
  } else if (endpoint === '/api/manage/worlds/backup') {
    result = { id: `preview-backup-${Date.now()}`, createdAt: new Date().toISOString(), reason: 'manual' };
    catalog.worlds.find(item => item.id === input.worldId).backups.push(result);
  } else if (endpoint === '/api/manage/settings') catalog.connection.port = input.port;
  return { ok: true, json: async () => result };
};
await startDesktopSetup({ fetchImpl });
document.title = 'RPGmap 管理界面验收 · 示例数据';
document.querySelector('.setup-host-label').textContent = '界面验收 · 示例数据';
window.uiSetupReady = true;
