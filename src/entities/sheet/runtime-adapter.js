import { ActorSheet } from './actor-sheet.js';

/**
 * Runtime bridge used during the v2.3.1 migration.
 * Keeps ui-live ownership/window management intact while moving rendering
 * decisions into the FVTT-style ActorSheet layer.
 */
export function renderActorSheetRuntime({
  actor,
  userId,
  description,
  mode = 'play',
} = {}) {
  const sheet = new ActorSheet({
    actor,
    userId,
    description,
    mode,
  });

  return sheet.render();
}

export function createActorSheetRuntime(options = {}) {
  return {
    render(overrides = {}) {
      return renderActorSheetRuntime({ ...options, ...overrides });
    },
  };
}
