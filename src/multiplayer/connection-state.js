// Hot paths need connection/identity scalars, not copies of the access tables.
// Legacy controllers still provide their complete public snapshot as a fallback.
export function readConnectionState(api) {
  const multiplayer = api?.multiplayer;
  return typeof multiplayer?.getConnectionState === 'function'
    ? multiplayer.getConnectionState() : multiplayer?.getStatus?.();
}
