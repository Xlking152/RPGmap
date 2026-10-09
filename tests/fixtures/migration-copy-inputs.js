import { worldCopyInput } from './world-copy-inputs.js';

export const migrationCopyDefinitions = [{ id: 'configured-status', name: 'Configured', scopes: ['actor'],
  category: 'neutral', icon: 'circle-dot', color: '#64748b', maxStacks: 1, changes: [], capabilities: {} }];

export function migrationCopyInput(schemaVersion) {
  const { state, world } = worldCopyInput();
  world.schemaVersion = schemaVersion;
  world.ruleset.version = schemaVersion < 4 ? '1.0.0' : '1.1.0';
  const actor = world.actors[0];
  if (schemaVersion === 2) { delete actor.type; delete actor.partyId; }
  actor.prototypeToken.elevationFt = 5;
  delete actor.prototypeToken.elevationMeters;
  actor.effects = [{ id: 'legacy-actor-effect', label: 'Legacy slow', enabled: true, stacks: 2 }];
  world.extension.aliasedActor = actor;
  world.statusDefinitions = [{ id: 'custom-status', name: 'Custom', scopes: ['actor'], extension: { value: 'definition' } }];
  for (const [index, scene] of world.scenes.entries()) {
    scene.mapPackage.id = 'northern-song-lanzhou-1104';
    scene.mapPackage.version = schemaVersion < 4 ? '1.0.6' : '1.1.0';
    const token = scene.tokens[0];
    token.id = 'same-token-id'; token.x = index + 1; token.y = index + 2;
    token.placement = 'map'; token.featureId = null;
    token.elevationFt = 12; delete token.elevationMeters;
    token.hidden = index === 0;
    token.effects = [{ id: `legacy-token-effect-${index}`, label: 'Legacy light', enabled: true }];
    scene.featureStates.wall.custom.blockingHeightFt = 20;
    scene.combat = { turnOrigin: { elevationFt: 8, extension: { preserve: true } } };
    delete scene.settings.lineOfSightEnabled;
    scene.fog.exploredByParty.party.rows[2] = [[6, 8], [1, 3], [3, 5]];
    scene.extension.aliasedToken = token;
    scene.extension.aliasedFeatureState = scene.featureStates.wall;
  }
  state.mapId = 'northern-song-lanzhou-1104';
  state.mapVersion = schemaVersion < 4 ? '1.0.6' : '1.1.0';
  state.preferences.worldV2 = world;
  state.preferences.entitySystem.schemaVersion = 3;
  state.preferences.combatSystem = { combat: { turnOrigin: { elevationFt: 10 } } };
  return state;
}
