// V1 Character-era authorization is frozen behind this compatibility module.
// Modern server imports keep the same public surface, but World V2 movement is
// additionally authorized from canonical active-Scene Token placement.
export * from './access-control-legacy.mjs';
export { validatePlayerWorldPush } from './token-access-v2.mjs';
