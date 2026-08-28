function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function requireActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
    const error = new Error('Actor operation requires an Actor document');
    error.code = 'actor_document_required';
    throw error;
  }
  const actorId = String(actor.id ?? '').trim();
  if (!actorId) {
    const error = new Error('Actor operation requires actor.id');
    error.code = 'actor_id_required';
    throw error;
  }
  return actorId;
}

/**
 * Persist one already-mutated Actor through the canonical World V2 operation
 * channel. Callers may mutate an isolated editor draft first, but must never
 * persist ordinary Actor edits by writing the Entity projection directly.
 */
export async function upsertCanonicalActor(api, actor, {
  source = 'entities:actor.upsert',
  render = false,
  immediate = true,
} = {}) {
  const actorId = requireActor(actor);
  if (typeof api?.world?.performOperations !== 'function') {
    const error = new Error('Canonical Actor writes require World V2 operations');
    error.code = 'world_operation_required';
    throw error;
  }

  const result = await api.world.performOperations([{
    type: 'actor.upsert',
    payload: { actor: clone(actor) },
  }], {
    source,
    render,
    kind: 'actor',
  });

  if (immediate) api.persistNow?.();
  api.emit?.('actor:change', {
    actorId,
    source,
    canonical: true,
  });
  return result;
}

export default upsertCanonicalActor;
