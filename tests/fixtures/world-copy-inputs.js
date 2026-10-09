import { infiniteHorrorRuleset } from '../../src/rulesets/infinite-horror/index.js';
import { normalizeActorDocument } from '../../src/actor/index.js';

export const copyRuleset = infiniteHorrorRuleset;
export const copyMap = { id: 'copy-map', version: '1', title: 'Copy equivalence', width: 200, height: 200, metersPerUnit: 1 };

export function worldCopyInput(activeSceneId = 'scene-a') {
  const actor = normalizeActorDocument({ id: 'actor-a', name: 'Actor', type: 'pc', partyId: 'party', effects: [],
    system: { extension: { preserved: [1, 2, 3] } }, extension: { nested: { value: 'actor' } },
    createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:01:00.000Z' }, { ruleset: copyRuleset });
  const token = { extension: { nested: { value: 'token' } }, id: 'token-a', actorId: actor.id,
    actorLink: true, placement: 'map', x: 10, y: 20, elevationMeters: 1, effects: [],
    controllerUserIds: [], visibility: { mode: 'public', userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: 120, vagueRangeOverrideMeters: 500, overrideUserIds: [] } };
  const scene = { extension: { nested: { value: 'scene' } }, id: 'scene-a', name: 'A',
    mapPackage: { extension: { variant: 'night' }, id: copyMap.id, version: copyMap.version },
    tokens: [token], markers: [], attackAreas: [],
    sceneEvents: [{ id: 'damage', type: 'damage', objectIds: ['wall'], clipHits: [], craterPolygon: [[50, 50], [55, 50], [55, 55], [50, 55]] }],
    featureStates: { wall: { open: true, custom: { height: 4 } } }, occlusionShapes: [],
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: { party: { extension: { remembered: true }, rows: { 2: [[1, 3], [6, 8]] } } } },
    settings: { extension: { custom: true }, gridVisible: false, lineOfSightEnabled: true },
  };
  const world = { extension: { nested: { value: 'world' } }, scenes: [scene,
    { ...structuredClone(scene), id: 'scene-b', name: 'B', tokens: [{ ...structuredClone(token), id: 'token-b', placement: 'feature', featureId: 'wall' }] }],
    actors: [actor], id: 'world-copy', name: 'World', schemaVersion: 4,
    ruleset: { extension: { channel: 'stable' }, id: copyRuleset.id, version: copyRuleset.version },
    statusDefinitions: [], activeSceneId, createdAt: '2026-10-06T00:00:00.000Z', updatedAt: '2026-10-06T00:01:00.000Z' };
  const state = { extension: { nested: { value: 'state' } }, preferences: {
    extension: { nested: { value: 'preferences' } }, worldV2: structuredClone(world),
    gridVisible: true, featureStates: {}, featureInteractions: {},
    entitySystem: { extension: { nested: { value: 'entities' } }, schemaVersion: 4,
      actors: [structuredClone(actor)], tokens: [], statusDefinitions: [] },
  }, saveVersion: 2, mapId: copyMap.id, mapVersion: copyMap.version,
    markers: [{ id: 'old-marker', x: 1, y: 1 }], attackAreas: [], sceneEvents: [] };
  return { state, world };
}
