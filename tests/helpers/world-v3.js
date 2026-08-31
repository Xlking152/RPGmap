import { migrateWorldSchema3State } from '../../src/world/migration.js';

export function migrateTestStateToWorldV3(state) {
  return migrateWorldSchema3State(state).state;
}

export function migrateTestWorldToV3(world) {
  return migrateTestStateToWorldV3({ preferences: { worldV2: world } }).preferences.worldV2;
}
