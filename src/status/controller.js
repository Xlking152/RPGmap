import {
  getStatusDefinitions,
  normalizeEntityStatusState,
  reduceStatusOperation,
  resolveStatuses,
  statusStateFingerprint,
} from './model.js';

const ENTITY_PREFERENCE_KEY = 'entitySystem';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function entityStateFromApi(api) {
  return api.getState?.()?.preferences?.[ENTITY_PREFERENCE_KEY] || null;
}

function connected(api) {
  const capabilities = api.multiplayer?.getCapabilities?.();
  if (capabilities?.connected === true) return true;
  return api.multiplayer?.getStatus?.()?.connected === true;
}

function contextValue(context, tokenId) {
  if (context && typeof context === 'object' && !Array.isArray(context)) return context;
  return context == null ? {} : { actorId: context, ...(tokenId == null ? {} : { tokenId }) };
}

function targetPayload(input, targetId, definitionId, options = {}) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const payload = { ...clone(input) };
    payload.definitionId = payload.definitionId ?? payload.statusId;
    delete payload.type;
    return payload;
  }
  return { ...clone(options), scope: input, targetId, definitionId };
}

function mutationDetail(type, payload, result, online, snapshot) {
  return {
    type,
    payload: clone(payload),
    result: clone(result),
    online,
    confirmed: true,
    snapshot,
  };
}

function resolutionContext(payload) {
  if (payload?.scope === 'actor') return { actorId: payload.targetId };
  if (payload?.scope === 'token') return { tokenId: payload.targetId };
  return {};
}

export function applyStatusOperationsToState(state, operations = [], context = {}) {
  const values = Array.isArray(operations) ? operations.map(operation => clone(operation)) : [];
  if (!values.length) return clone(state);
  const isWorld = Boolean(state?.preferences?.[ENTITY_PREFERENCE_KEY]);
  const entityState = isWorld ? state.preferences[ENTITY_PREFERENCE_KEY] : state;
  const reduced = reduceStatusOperation(entityState, { type: 'status.batch', operations: values }, context);
  if (!isWorld) return reduced.state;
  const next = clone(state);
  next.preferences ||= {};
  next.preferences[ENTITY_PREFERENCE_KEY] = reduced.state;
  return next;
}

/**
 * Register the synchronous status resolver and confirmation-based Promise
 * mutation API. LAN writes are never applied optimistically: the multiplayer
 * controller resolves only after both status.ack and its canonical snapshot.
 */
export function createStatusController() {
  return {
    register(api) {
      let suppressStateEvents = 0;
      let deferredStateChange = false;
      let lastFingerprint = statusStateFingerprint(entityStateFromApi(api));

      function currentEntityState() {
        return normalizeEntityStatusState(entityStateFromApi(api));
      }

      function definitions() {
        return getStatusDefinitions(currentEntityState());
      }

      function resolve(context = {}, tokenId = null) {
        return resolveStatuses(currentEntityState(), contextValue(context, tokenId));
      }

      function emitChange(detail) {
        lastFingerprint = statusStateFingerprint(entityStateFromApi(api));
        api.emit?.('status:change', detail);
      }

      function observeStateChange(source) {
        const fingerprint = statusStateFingerprint(entityStateFromApi(api));
        if (fingerprint === lastFingerprint) return;
        if (suppressStateEvents > 0) {
          deferredStateChange = true;
          return;
        }
        lastFingerprint = fingerprint;
        api.emit?.('status:change', {
          type: 'state.sync',
          source,
          online: connected(api),
          confirmed: true,
          snapshot: resolve({}),
        });
      }

      async function perform(type, payload = {}) {
        const online = connected(api);
        suppressStateEvents += 1;
        deferredStateChange = false;
        try {
          let result;
          if (online) {
            if (typeof api.multiplayer?.performStatusOperation !== 'function') {
              throw new Error('当前联机控制器不支持状态操作');
            }
            result = await api.multiplayer.performStatusOperation(type, clone(payload));
          } else {
            if (typeof api.world?.performOperations === 'function') {
              const operationPayload = clone(payload);
              const requestedOperationId = operationPayload.operationId || null;
              delete operationPayload.operationId;
              result = await api.world.performOperations([{ type, payload: operationPayload }], {
                source: `status:${type}`,
                render: false,
                kind: 'status',
                requestedOperationId,
              });
            } else {
              const appState = clone(api.getState?.() || {});
              appState.preferences ||= {};
              const reduced = reduceStatusOperation(appState.preferences[ENTITY_PREFERENCE_KEY], { type, ...clone(payload) }, {
                source: { role: 'offline' },
              });
              appState.preferences[ENTITY_PREFERENCE_KEY] = reduced.state;
              if (typeof api.commitState === 'function') {
                api.commitState(appState, { source: `status:${type}`, render: false });
              } else if (typeof api.importState === 'function') {
                api.importState(appState);
              } else {
                throw new Error('当前运行环境无法保存状态变更');
              }
              api.persistNow?.();
              result = { offline: true, results: reduced.results };
            }
          }
          const snapshot = resolve(resolutionContext(payload));
          emitChange(mutationDetail(type, payload, result, online, snapshot));
          deferredStateChange = false;
          return result;
        } finally {
          suppressStateEvents = Math.max(0, suppressStateEvents - 1);
          // On failure, a denied LAN operation may still have reloaded a
          // canonical rollback snapshot. Surface that state without reporting
          // the rejected mutation itself as successful.
          if (suppressStateEvents === 0 && deferredStateChange) {
            deferredStateChange = false;
            queueMicrotask(() => observeStateChange('status.rollback'));
          }
        }
      }

      function apply(input, targetId, definitionId, options) {
        return perform('status.apply', targetPayload(input, targetId, definitionId, options));
      }

      function remove(input, targetId, definitionId, options) {
        return perform('status.remove', targetPayload(input, targetId, definitionId, options));
      }

      function setStacks(input, targetId, definitionId, stacksOrOptions) {
        const options = stacksOrOptions && typeof stacksOrOptions === 'object'
          ? stacksOrOptions
          : { stacks: stacksOrOptions };
        return perform('status.setStacks', targetPayload(input, targetId, definitionId, options));
      }

      function setEnabled(input, targetId, definitionId, enabledOrOptions) {
        const options = enabledOrOptions && typeof enabledOrOptions === 'object'
          ? enabledOrOptions
          : { enabled: Boolean(enabledOrOptions) };
        const payload = targetPayload(input, targetId, definitionId, options);
        if (payload.stacks === undefined) {
          const snapshot = resolve(resolutionContext(payload));
          const status = [...snapshot.actorStatuses, ...snapshot.tokenStatuses]
            .find(item => String(item.definitionId) === String(payload.definitionId));
          payload.stacks = status?.stacks || 1;
        }
        return perform('status.setStacks', payload);
      }

      function setNote(input, targetId, definitionId, noteOrOptions) {
        const options = noteOrOptions && typeof noteOrOptions === 'object'
          ? noteOrOptions
          : { note: String(noteOrOptions ?? '') };
        const payload = targetPayload(input, targetId, definitionId, options);
        if (payload.stacks === undefined) {
          const snapshot = resolve(resolutionContext(payload));
          const status = [...snapshot.actorStatuses, ...snapshot.tokenStatuses]
            .find(item => String(item.definitionId) === String(payload.definitionId));
          payload.stacks = status?.stacks || 1;
        }
        return perform('status.setStacks', payload);
      }

      function applyBatch(operations = []) {
        const values = Array.isArray(operations) ? operations.map(operation => clone(operation)) : [];
        return perform('status.batch', { operations: values });
      }

      function upsertDefinition(definition) {
        return perform('status.definition.upsert', { definition: clone(definition) });
      }

      function deleteDefinition(definitionId) {
        const id = definitionId && typeof definitionId === 'object'
          ? definitionId.definitionId ?? definitionId.statusId ?? definitionId.id
          : definitionId;
        return perform('status.definition.delete', { definitionId: String(id || '') });
      }

      api.status = {
        getDefinitions: definitions,
        resolve,
        resolveStatuses: resolve,
        has(context = {}, definitionId = null) {
          const target = contextValue(context);
          const id = String(definitionId ?? target.definitionId ?? target.statusId ?? '');
          if (!id) return false;
          return resolve(target).statuses.some(status => status.enabled !== false
            && String(status.definitionId || status.statusId || status.id) === id);
        },
        resolveCapabilities(context = {}, tokenId = null) {
          return resolve(context, tokenId).capabilities;
        },
        apply,
        remove,
        setStacks,
        setEnabled,
        setNote,
        applyBatch,
        applyOperationsToState: applyStatusOperationsToState,
        upsertDefinition,
        deleteDefinition,
        // Explicit aliases keep map-package integrations readable and preserve
        // compatibility with the first status UI prototype.
        applyStatus: apply,
        removeStatus: remove,
        setStatusStacks: setStacks,
        batch: applyBatch,
        createDefinition: upsertDefinition,
        updateDefinition: upsertDefinition,
      };

      api.on?.('state:import', () => observeStateChange('state:import'));
      api.on?.('state:commit', () => observeStateChange('state:commit'));
    },
  };
}

export default createStatusController;
