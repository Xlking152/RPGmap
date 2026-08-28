import { resolveStatuses } from '../status/model.js';
import { applySyntheticActorStatusBatch, applySyntheticActorStatusOperation } from './synthetic-status.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function contextValue(context, tokenId) {
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    return tokenId == null ? { ...context } : { ...context, tokenId };
  }
  return context == null ? (tokenId == null ? {} : { tokenId }) : {
    actorId: context,
    ...(tokenId == null ? {} : { tokenId }),
  };
}

function tokenIdentity(context) {
  return context?.tokenId ?? context?.token?.id ?? null;
}

function mutationPayload(input, targetId, definitionId, options = {}) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const payload = { ...clone(input) };
    payload.definitionId = payload.definitionId ?? payload.statusId;
    delete payload.type;
    return payload;
  }
  return { ...clone(options), scope: input, targetId, definitionId };
}

function syntheticStatusState(api, context) {
  const tokenId = tokenIdentity(context);
  if (tokenId == null || typeof api.tokens?.resolveActor !== 'function') return null;

  let resolved;
  try { resolved = api.tokens.resolveActor(tokenId); }
  catch { return null; }
  if (!resolved?.synthetic || !resolved.actor) return null;

  const raw = api.getState?.()?.preferences?.entitySystem;
  if (!raw || typeof raw !== 'object') return null;
  const state = clone(raw);
  const index = (state.actors || []).findIndex(actor => String(actor?.id) === String(resolved.actor.id));
  if (index < 0) return null;

  // Only the resolution view is replaced. The persisted World Actor remains
  // the Base Actor while actorDelta owns this Token instance's overrides.
  state.actors[index] = clone(resolved.actor);
  return state;
}

function syntheticOperationId() {
  const value = globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `synthetic-status-${value}`;
}

export function createTokenStatusBridgeSystem() {
  return Object.freeze({
    register(api) {
      if (!api?.status || api.status.syntheticActorAware === true) return;
      const baseResolve = api.status.resolve?.bind(api.status);
      const baseApply = api.status.apply?.bind(api.status);
      const baseRemove = api.status.remove?.bind(api.status);
      const baseSetStacks = api.status.setStacks?.bind(api.status);
      const baseSetEnabled = api.status.setEnabled?.bind(api.status);
      const baseSetNote = api.status.setNote?.bind(api.status);
      const baseApplyBatch = api.status.applyBatch?.bind(api.status);
      if (typeof baseResolve !== 'function') return;

      function resolve(context = {}, tokenId = null) {
        const target = contextValue(context, tokenId);
        const synthetic = syntheticStatusState(api, target);
        return synthetic
          ? resolveStatuses(synthetic, { ...target, ruleset: api.ruleset })
          : baseResolve(context, tokenId);
      }

      function currentSyntheticStatus(tokenId, definitionId) {
        return resolve({ tokenId }).actorStatuses.find(status =>
          String(status.definitionId) === String(definitionId)) || null;
      }

      async function commitSyntheticOperations(operations) {
        if (typeof api.world?.get !== 'function' || typeof api.world?.commit !== 'function') {
          throw new Error('Synthetic Actor status writes require World V2');
        }
        const values = operations.map(operation => ({ ...clone(operation), scope: 'syntheticActor' }));
        const operationId = syntheticOperationId();
        api.emit?.('status:pending', {
          operationId,
          type: values.length > 1 ? 'status.batch' : values[0]?.type,
          scope: 'syntheticActor',
        });
        try {
          const applied = values.length === 1
            ? applySyntheticActorStatusOperation(api.world.get(), values[0], {
                source: { role: 'gm', authority: 'world-v2', scope: 'syntheticActor' },
                ruleset: api.ruleset,
              })
            : applySyntheticActorStatusBatch(api.world.get(), values, {
                source: { role: 'gm', authority: 'world-v2', scope: 'syntheticActor' },
                ruleset: api.ruleset,
              });

          await api.world.commit(applied.world, {
            source: 'status:syntheticActor',
            reason: 'status.syntheticActor',
            render: false,
          });
          const tokenIds = [...new Set(values.map(value => String(value.targetId || '')).filter(Boolean))];
          const snapshots = tokenIds.map(tokenId => ({ tokenId, snapshot: resolve({ tokenId }) }));
          api.emit?.('status:change', {
            type: values.length > 1 ? 'status.batch' : values[0]?.type,
            scope: 'syntheticActor',
            operationId,
            online: api.multiplayer?.getStatus?.()?.connected === true,
            confirmed: true,
            results: clone(applied.results),
            snapshots,
          });
          api.emit?.('status:operation-result', { operationId, ok: true });
          return {
            operationId,
            syntheticActor: true,
            confirmed: true,
            results: clone(applied.results),
          };
        } catch (error) {
          api.emit?.('status:operation-result', {
            operationId,
            ok: false,
            error: error?.message || String(error),
          });
          throw error;
        }
      }

      function syntheticOrBase(method, baseMethod, input, targetId, definitionId, options) {
        const payload = mutationPayload(input, targetId, definitionId, options);
        if (payload.scope !== 'syntheticActor') return baseMethod?.(input, targetId, definitionId, options);
        return commitSyntheticOperations([{ type: `status.${method}`, ...payload }]);
      }

      function apply(input, targetId, definitionId, options) {
        return syntheticOrBase('apply', baseApply, input, targetId, definitionId, options);
      }

      function remove(input, targetId, definitionId, options) {
        return syntheticOrBase('remove', baseRemove, input, targetId, definitionId, options);
      }

      function setStacks(input, targetId, definitionId, stacksOrOptions) {
        const options = stacksOrOptions && typeof stacksOrOptions === 'object'
          ? stacksOrOptions
          : { stacks: stacksOrOptions };
        const payload = mutationPayload(input, targetId, definitionId, options);
        if (payload.scope !== 'syntheticActor') return baseSetStacks?.(input, targetId, definitionId, stacksOrOptions);
        return commitSyntheticOperations([{ type: 'status.setStacks', ...payload }]);
      }

      function setEnabled(input, targetId, definitionId, enabledOrOptions) {
        const options = enabledOrOptions && typeof enabledOrOptions === 'object'
          ? enabledOrOptions
          : { enabled: Boolean(enabledOrOptions) };
        const payload = mutationPayload(input, targetId, definitionId, options);
        if (payload.scope !== 'syntheticActor') return baseSetEnabled?.(input, targetId, definitionId, enabledOrOptions);
        if (payload.stacks === undefined) {
          payload.stacks = currentSyntheticStatus(payload.targetId, payload.definitionId)?.stacks || 1;
        }
        return commitSyntheticOperations([{ type: 'status.setStacks', ...payload }]);
      }

      function setNote(input, targetId, definitionId, noteOrOptions) {
        const options = noteOrOptions && typeof noteOrOptions === 'object'
          ? noteOrOptions
          : { note: String(noteOrOptions ?? '') };
        const payload = mutationPayload(input, targetId, definitionId, options);
        if (payload.scope !== 'syntheticActor') return baseSetNote?.(input, targetId, definitionId, noteOrOptions);
        if (payload.stacks === undefined) {
          payload.stacks = currentSyntheticStatus(payload.targetId, payload.definitionId)?.stacks || 1;
        }
        return commitSyntheticOperations([{ type: 'status.setStacks', ...payload }]);
      }

      function applyBatch(operations = []) {
        const values = Array.isArray(operations) ? operations.map(operation => clone(operation)) : [];
        const synthetic = values.filter(operation => operation?.scope === 'syntheticActor');
        if (!synthetic.length) return baseApplyBatch?.(operations);
        if (synthetic.length !== values.length) {
          const error = new Error('Synthetic Actor statuses cannot share one batch with Actor/Token status targets');
          error.code = 'status_mixed_scope_batch';
          return Promise.reject(error);
        }
        return commitSyntheticOperations(values);
      }

      api.status.resolve = resolve;
      api.status.resolveStatuses = resolve;
      api.status.resolveToken = tokenId => resolve({ tokenId });
      api.status.resolveCapabilities = (context = {}, tokenId = null) => resolve(context, tokenId).capabilities;
      api.status.has = (context = {}, definitionId = null) => {
        const target = contextValue(context);
        const id = String(definitionId ?? target.definitionId ?? target.statusId ?? '');
        if (!id) return false;
        return resolve(target).statuses.some(status => status.enabled !== false
          && String(status.definitionId || status.statusId || status.id) === id);
      };

      api.status.apply = apply;
      api.status.remove = remove;
      api.status.setStacks = setStacks;
      api.status.setEnabled = setEnabled;
      api.status.setNote = setNote;
      api.status.applyBatch = applyBatch;
      api.status.applyStatus = apply;
      api.status.removeStatus = remove;
      api.status.setStatusStacks = setStacks;
      api.status.batch = applyBatch;
      api.status.applyToTokenActor = (tokenId, definitionId, options = {}) =>
        apply({ ...clone(options), scope: 'syntheticActor', targetId: tokenId, definitionId });
      api.status.removeFromTokenActor = (tokenId, definitionId, options = {}) =>
        remove({ ...clone(options), scope: 'syntheticActor', targetId: tokenId, definitionId });
      api.status.syntheticActorAware = true;

      api.emit?.('status:synthetic-ready', { enabled: true, writes: true });
    },
  });
}
