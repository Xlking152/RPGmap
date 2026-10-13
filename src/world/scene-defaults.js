/** The shared defaults used for new Scenes and an explicit Scene clear. */
export function createDefaultSceneSettings() {
  return {
    gridVisible: true,
    lineOfSightEnabled: false,
    movementBudgetMetersPerTurn: null,
    defaultDoorInteractionRangeMeters: 2,
  };
}
