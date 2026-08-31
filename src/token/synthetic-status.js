import { reduceStatusOperation } from '../status/model.js';
import { resolveTokenActor } from './actor.js';
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
 * Synthetic Actor effects are persisted directly in Token.actorDelta.effects.
 * Feeding a Monster/NPC/Summon back through an `actor` target would correctly
 * trip the template guard, so the canonical Status reducer must receive the
 * unlinked Token itself with `scope: syntheticActor`.
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
    actors: [clone(resolved.baseActor)],
    tokens: [clone(resolved.token)],
  };
  const reduced = reduceStatusOperation(entityState, operation, context);
  const reducedToken = reduced.state.tokens.find(token => String(token?.id) === String(operation.targetId));
  if (!reducedToken) throw new Error('Synthetic Actor status reducer did not return its Token target');

  const actorDelta = clone(reducedToken.actorDelta || {});
  const updated = updateSceneToken(rawWorld, operation.targetId, { actorDelta });
  const updatedResolved = resolveTokenActor(updated.world, operation.targetId, { ruleset: context.ruleset });
  return {
    world: updated.world,
    token: updated.token,
    actor: clone(updatedResolved.actor),
    actorDelta,
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
