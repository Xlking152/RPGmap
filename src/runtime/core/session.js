import { applyWorldOperationsAsync } from '../../world/operations.js';
import { documentWritesToWorldOperations, normalizeDocumentWrite } from '../../documents/protocol.js';

const clone = structuredClone;
const fail = (code, message = code) => Object.assign(new Error(message), { code });

/**
 * No-DOM command boundary shared by standalone sessions and the browser host.
 * An authority adapter owns validation/persistence when provided. A host may
 * supply its private canonical reader to avoid copying its World per command;
 * that reader and adapter are trusted, while public queries remain detached.
 */
export function createRuntimeSession({ initialState, ruleset, mapForScene, authority = null, persist = null,
  initialRevision = 0, getCanonicalState = null, getCanonicalRevision = null, onSubscriberError = null } = {}) {
  const hosted = typeof getCanonicalState === 'function';
  if (!ruleset?.id) throw fail('runtime_ruleset_required', 'Runtime requires a Ruleset');
  if (typeof mapForScene !== 'function') throw fail('runtime_map_resolver_required', 'Runtime requires mapForScene');
  if (authority && typeof authority.apply !== 'function') throw fail('runtime_authority_invalid');
  if (hosted && !authority) throw fail('runtime_authority_required', 'A canonical host reader requires an authority adapter');
  let current = hosted ? null : clone(initialState);
  if (!hosted && (!current || typeof current !== 'object' || Array.isArray(current))) throw fail('runtime_state_required');
  let revision = Number(initialRevision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw fail('invalid_revision');
  let generation = 0, disposed = false, tail = Promise.resolve();
  const listeners = new Set(), pending = new Set();
  const abort = new AbortController();
  const stateOf = () => hosted ? getCanonicalState() : current;
  const revisionOf = () => {
    const value = getCanonicalRevision?.();
    return Number.isSafeInteger(value) && value >= 0 ? value : revision;
  };
  const requireActive = () => { if (disposed) throw fail('runtime_session_disposed', 'Runtime session has been disposed'); };
  const subscriberFailed = error => { try { onSubscriberError?.(error); } catch { /* A subscriber error cannot roll back a committed command. */ } };

  function notify(result) {
    for (const listener of [...listeners]) {
      if (disposed || !listeners.has(listener)) continue;
      try { listener({ state: clone(stateOf()), revision: revisionOf(), result: clone(result) }); }
      catch (error) { subscriberFailed(error); }
    }
  }

  async function apply(request) {
    requireActive();
    const beforeRevision = revisionOf(), beforeGeneration = generation;
    if (request.baseRevision !== undefined && request.baseRevision !== beforeRevision) {
      throw fail('runtime_revision_conflict', 'Runtime revision changed before this command');
    }
    const before = stateOf();
    const context = { ...request.context, ruleset, mapForScene, signal: abort.signal };
    if (!hosted && (!context.source || typeof context.source === 'string')) {
      context.source = { role: 'offline', source: context.source || 'runtime.dispatch' };
    }
    const applied = authority ? await authority.apply({
      state: hosted ? before : clone(before), revision: beforeRevision,
      writes: request.writes, operations: request.operations, operationId: request.operationId,
      context, signal: abort.signal, ruleset, mapForScene,
    }) : await applyWorldOperationsAsync(before, request.operations, context);
    requireActive();
    if (!hosted && generation !== beforeGeneration) throw fail('runtime_context_changed', 'Runtime state was replaced while applying a command');
    const next = hosted ? stateOf() : applied?.state;
    if (!next || typeof next !== 'object' || Array.isArray(next)) throw fail('runtime_authority_result_invalid');
    // Hosted UI commits and server ACKs have different revision domains.
    // Check the host's monotonic counter, retaining the server ACK unchanged.
    const nextRevision = hosted && typeof getCanonicalRevision === 'function'
      ? revisionOf() : applied?.revision ?? (hosted ? revisionOf() : beforeRevision + 1);
    if (!Number.isSafeInteger(nextRevision) || nextRevision < beforeRevision) throw fail('runtime_authority_result_invalid');
    if (persist) {
      // Default standalone persistence precedes the visible commit. False is
      // a write failure, not a successful acknowledgement.
      const saved = await persist(clone(next), { revision: nextRevision, operationId: request.operationId, signal: abort.signal });
      if (saved === false) throw fail('runtime_persistence_failed');
      requireActive();
      if (!hosted && generation !== beforeGeneration) throw fail('runtime_context_changed');
    }
    if (!hosted) current = clone(next);
    revision = nextRevision;
    const result = hosted ? applied : { ...clone(applied), revision };
    notify(result);
    return result;
  }

  function dispatch(writes, { operationId = null, baseRevision, context = {} } = {}) {
    if (disposed) return Promise.reject(fail('runtime_session_disposed', 'Runtime session has been disposed'));
    let request;
    try {
      // Normalize now, so a caller cannot alter a command while it is queued.
      const operations = documentWritesToWorldOperations(writes);
      if (baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) throw fail('invalid_revision');
      request = { writes: writes.map((write, index) => normalizeDocumentWrite(write, `writes[${index}]`)),
        operations, operationId: operationId == null ? null : String(operationId), baseRevision,
        context: { ...context } };
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const job = { resolve, reject }; pending.add(job);
      // The live browser authority already schedules immutable commits and
      // background Fog with its own epoch/rebase checks. Serializing a waiting
      // Fog worker ahead of movement would block its foreground command lane.
      const execution = hosted && authority.managesScheduling === true ? apply(request) : tail.then(() => apply(request));
      // A failed command cannot poison the serialization queue.
      tail = execution.then(() => undefined, () => undefined);
      execution.then(result => {
        if (pending.delete(job)) resolve(result);
      }, error => { if (pending.delete(job)) reject(error); });
    });
  }

  return Object.freeze({
    dispatch,
    read: () => clone(stateOf()),
    getState: () => clone(stateOf()),
    getWorld: () => clone(stateOf()?.preferences?.worldV2 ?? null),
    getActiveScene() {
      const world = stateOf()?.preferences?.worldV2;
      return clone(world?.scenes?.find(scene => String(scene.id) === String(world.activeSceneId)) ?? null);
    },
    query(reader) {
      if (typeof reader !== 'function') throw fail('runtime_query_invalid');
      return reader(clone(stateOf()), revisionOf());
    },
    getRevision: revisionOf,
    subscribe(listener, { emitCurrent = false } = {}) {
      requireActive();
      if (typeof listener !== 'function') throw fail('runtime_subscription_invalid');
      listeners.add(listener);
      if (emitCurrent) {
        try { listener({ state: clone(stateOf()), revision: revisionOf(), result: null }); }
        catch (error) { subscriberFailed(error); }
      }
      return () => listeners.delete(listener);
    },
    synchronize(state, { revision: nextRevision = revisionOf() } = {}) {
      requireActive();
      if (hosted) throw fail('runtime_host_controls_state', 'Synchronize through the canonical host');
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw fail('runtime_state_required');
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 0) throw fail('invalid_revision');
      current = clone(state); revision = nextRevision; generation++;
      notify(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true; abort.abort(); listeners.clear();
      for (const job of pending) job.reject(fail('runtime_session_disposed', 'Runtime session has been disposed'));
      pending.clear();
    },
    get disposed() { return disposed; },
  });
}
