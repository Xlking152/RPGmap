import { createMemoryStorage } from '../src/app/storage-adapter.js';
import { createDefaultMapPackage } from '../src/map-package/default-map.js';
import { MapPackageRegistry } from '../src/map-package/registry.js';
import { startMapRuntime } from '../src/runtime/map-runtime.js';
import { listBuiltInRulesets } from '../src/ruleset/metadata.js';
import portraitUrl from './fixtures/ui-silver-portrait.webp';

export async function createUiRefreshFixture(container) {
  const portrait = await fetch(portraitUrl).then(response => {
    if (!response.ok) throw new Error('UI fixture portrait failed to load');
    return response.blob();
  });
  const avatarDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(portrait);
  });
  const mapPackage = await createDefaultMapPackage();
  const registry = new MapPackageRegistry();
  registry.registerPackage(mapPackage);
  const rulesetReference = listBuiltInRulesets().find(entry => entry.id === 'infinite-horror');
  const api = await startMapRuntime({
    appContainer: container,
    bootstrapStorage: createMemoryStorage(),
    mapPackageRegistry: registry,
    mapReference: { id: mapPackage.id, version: mapPackage.version },
    raw: null,
    rulesetReference,
    serverRuntime: false,
    worldId: 'ui-refresh-review',
    worldName: '兰州纪事 · 演示世界',
    worldManager: null,
  });
  api.multiplayer.disconnect();
  const multiplayerButton = container.querySelector('.multiplayer-toolbar');
  multiplayerButton.disabled = true;
  multiplayerButton.title = '离线界面预览；联机试玩请从 Local/LAN 服务进入';
  multiplayerButton.querySelector('[data-mp-label]').textContent = '离线预览';
  const actors = [
    { id: 'ui-review-silver', name: '银 · 演示', type: 'pc' },
    { id: 'ui-review-han', name: '韩立 · 演示', type: 'pc' },
    { id: 'ui-review-guard', name: '城门守卫 · 演示', type: 'npc' },
  ].map(identity => ({
    ...api.ruleset.actor.createFromImport({
      formName: '普通', identity: { name: identity.name }, description: { summary: '界面验收用独立演示角色。' },
      avatarDataUrl: identity.id === 'ui-review-silver' ? avatarDataUrl : null,
      resources: { hp: { max: 24 }, stamina: { max: 12 }, willpower: { max: 10 } },
      attributes: [], checks: { skills: [
        { category: '感知', name: '观察', checkValue: 6, level: 4, bonus: 2, specialties: '追踪' },
        { category: '体能', name: '运动', checkValue: 5, level: 3, bonus: 2, specialties: '' },
      ], saves: [{ name: '坚韧', checkValue: 5, totalBonus: 2 }, { name: '意志', checkValue: 6, totalBonus: 3 }] }, badStatuses: [],
      combat: { attacks: [], defenses: [] }, detection: { configured: true, preciseRangeMeters: 40, vagueRangeMeters: 60 }, source: { type: 'manual' },
    }, { actorId: identity.id, name: identity.name }),
    ...identity,
    partyId: identity.type === 'pc' ? 'party-default' : null,
  }));
  const positions = [];
  const candidates = [
    { x: mapPackage.width * .5, y: mapPackage.height * .55 },
    { x: mapPackage.width * .4, y: mapPackage.height * .5 },
  ];
  for (let ring = 0; ring < 12 && positions.length < actors.length; ring++) {
    for (const origin of candidates) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const point = { x: Math.floor(origin.x + dx * ring * 8) + .5, y: Math.floor(origin.y + dy * ring * 8) + .5 };
        if (positions.some(previous => Math.hypot(previous.x - point.x, previous.y - point.y) < 3)) continue;
        if (api.inspectTokenPlacement(null, point, { diameterMeters: 1, elevationMeters: 0 }).valid) positions.push(point);
        if (positions.length === actors.length) break;
      }
      if (positions.length === actors.length) break;
    }
  }
  if (positions.length < actors.length) throw new Error('UI fixture requires three walkable Token positions');
  const sceneId = api.world.get().activeSceneId;
  await api.world.performOperations([
    ...actors.map(actor => ({ type: 'actor.upsert', payload: { actor } })),
    ...actors.map((actor, index) => ({ type: 'token.create', payload: {
      sceneId,
      token: { id: `${actor.id}-token`, actorId: actor.id, name: actor.name, actorLink: actor.type === 'pc',
        placement: 'map', ...positions[index], diameterMeters: 1, elevationMeters: 0,
        visibility: { mode: 'public', userIds: [] }, effects: [] },
    } })),
  ], { source: 'ui-refresh:fixture' });
  await api.health.applyDamageToTokenIds([`${actors[0].id}-token`], { amount: 6, type: 'L' });
  await api.status.apply({ scope: 'token', targetId: `${actors[0].id}-token`, definitionId: 'status-strengthened', duration: { unit: 'turns', initial: 3, remaining: 3 } });
  await api.status.apply({ scope: 'token', targetId: `${actors[0].id}-token`, definitionId: 'status-bleeding', duration: { unit: 'turns', initial: 2, remaining: 2 } });
  return { api, sceneId, actorIds: actors.map(actor => actor.id), tokenIds: actors.map(actor => `${actor.id}-token`) };
}
