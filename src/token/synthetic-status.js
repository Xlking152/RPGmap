import { reduceStatusOperation } from '../status/model.js';
import { createActorDelta, resolveTokenActor } from './actor.js';
import { updateSceneToken } from './model.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function required(value, label) {
  const result = String(value ?? '').trim();
  if (!result) {
    const error = new Error(`${label} is required`);
    error.code = 'invalid_status';
    throw error;
  }
  return result;
}

function normalizeOperation(operation = {}) {
  const type = String(operation.type || '');
  if (!['status.apply', 'status.remove', 'status.setStacks'].includes(type)) {
    const error = new Error(`Unsupported Synthetic Actor status operation: ${type}`);
    error.code = 'unknown_message';
    throw error;
  }
  const tokenId = required(operation.targetId ?? operation.tokenId ?? operation.id, 'targetId');
  const definitionId = required(operation.definitionId ?? operation.statusId, 'definitionId');
  return {
    ...clone(operation),
    type,
    scope: 'syntheticActor',
    targetId: tokenId,
    definitionId,
  };
}

/**
 * Apply an Actor-scoped Status operation to one unlinked Token instance.
 *
 * The existing Status reducer remains the single implementation of stacking,
 * definition validation, notes, enabled state, and numeric Actor changes. We
 * feed it the resolved Synthetic Actor as a temporary Actor target, then derive
 * a fresh ActorDelta from the updated result. The World Actor template is never
 * mutated.
 */
export function applySyntheticActorStatusOperation(rawWorld, rawOperation, context = {}) {
  const operation = normalizeOperation(rawOperation);
  const resolved = resolveTokenActor(rawWorld, operation.targetId, { ruleset: context.ruleset });
  if (!resolved.synthetic || resolved.token.actorLink !== false) {
    const error = new Error(`Token ${operation.targetId} is linked; apply Actor status to ${resolved.baseActor.id} instead`);
    error.code = 'synthetic_actor_required';
    throw error;
  }

  const entityState = {
    schemaVersion: 3,
    statusDefinitions: clone(rawWorld?.statusDefinitions || []),
    actors: [clone(resolved.actor)],
    tokens: [],
  };
  const reduced = reduceStatusOperation(entityState, {
    ...clone(operation),
    scope: 'actor',
    targetId: resolved.actor.id,
  }, context);
  const updatedActor = reduced.state.actors.find(actor => String(actor?.id) === String(resolved.actor.id));
  if (!updatedActor) throw new Error('Synthetic Actor status reducer did not return its Actor target');

  const actorDelta = createActorDelta(resolved.baseActor, updatedActor, {
    ruleset: context.ruleset,
    currentDelta: resolved.token.actorDelta,
  });
  const updated = updateSceneToken(rawWorld, operation.targetId, { actorDelta });
  return {
    world: updated.world,
    token: updated.token,
    actor: clone(updatedActor),
    actorDelta: clone(actorDelta),
    results: reduced.results.map(result => ({
      ...result,
      scope: 'syntheticActor',
      targetId: operation.targetId,
      actorId: resolved.baseActor.id,
    })),
  };
}

export function applySyntheticActorStatusBatch(rawWorld, operations = [], context = {}) {
  if (!Array.isArray(operations) || !operations.length) {
    const error = new Error('Synthetic Actor status batch cannot be empty');
    error.code = 'invalid_status';
    throw error;
  }
  let world = clone(rawWorld);
  const results = [];
  const tokens = [];
  for (const operation of operations) {
    const applied = applySyntheticActorStatusOperation(world, operation, context);
    world = applied.world;
    results.push(...applied.results);
    tokens.push(applied.token);
  }
  return { world, results, tokens };
}
