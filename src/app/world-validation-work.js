import { prepareRuntimeStateValidationInput, exportPreparedRuntimeStateAsync, yieldRuntimeValidationFrame } from '../engine/runtime-state.js';
import { infiniteHorrorRuleset } from '../rulesets/infinite-horror/index.js';
import { registeredInfiniteHorrorRuleset } from '../ruleset/index.js';
import { isPreparedMapPackage } from '../map-package/contract.js';
import { currentWorldValidationRecipe, copyWorldValidationMap, sameWorldValidationMap } from './world-validation-context.js';

function abortError(signal) {
  return signal?.reason ?? new DOMException('World validation cancelled', 'AbortError');
}

function remoteValidationError(error) {
  const constructors = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
  const ErrorType = Object.hasOwn(constructors, error.name) ? constructors[error.name] : null;
  const result = ErrorType ? new ErrorType(error.message) : new DOMException(error.message, error.name || 'Error');
  if (Object.hasOwn(error, 'code') && result.code !== error.code) {
    Object.defineProperty(result, 'code', { value: error.code, enumerable: true, configurable: true });
  }
  return result;
}

function validResponse(data) {
  const hasJSON = Object.hasOwn(data, 'json'), hasError = Object.hasOwn(data, 'error');
  const hasInfrastructure = Object.hasOwn(data, 'infrastructureError');
  if (Number(hasJSON) + Number(hasError) + Number(hasInfrastructure) !== 1) return false;
  if (hasJSON) return typeof data.json === 'string' && data.json.startsWith('{') && data.json.endsWith('}');
  if (hasInfrastructure) return typeof data.infrastructureError === 'string';
  const error = data.error;
  return Boolean(error && typeof error === 'object' && !Array.isArray(error)
    && typeof error.name === 'string' && typeof error.message === 'string'
    && (!Object.hasOwn(error, 'code') || error.code === undefined || error.code === null
      || ['string', 'number', 'boolean'].includes(typeof error.code)));
}

function copyablePlainMap(mapPackage) {
  // Compatibility callers with tiny ordinary maps can prove cloneability
  // once. Never read irrelevant getters or walk a production map's geometry.
  const visited = new Set();
  let properties = 0;
  function dataOnly(value) {
    if (value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value)) return true;
    if (!value || typeof value !== 'object') return false;
    if (visited.has(value)) return true;
    if (visited.size >= 256 || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (++properties > 2048 || typeof key !== 'string' || !descriptor || !Object.hasOwn(descriptor, 'value')
        || !dataOnly(descriptor.value)) return false;
    }
    return true;
  }
  try {
    if (!dataOnly(mapPackage)) return false;
    structuredClone(mapPackage); // Proxies are rejected by the platform.
    return true;
  } catch { return false; }
}

/** Full save validation in one reusable realm; no persistence authority here. */
export function createWorldValidationWork({ mapPackage, ruleset, workerFactory = null, timeoutMs = 10000 } = {}) {
  let worker = null, active = null, disposed = false, disabled = false;
  let generation = 0, nextId = 0, tail = Promise.resolve();
  const cancellations = new Set();
  const options = { mapPackage, ruleset };
  const available = Boolean(workerFactory || typeof Worker === 'function');
  const builtIn = ruleset === infiniteHorrorRuleset || ruleset === registeredInfiniteHorrorRuleset;
  const mapOwned = isPreparedMapPackage(mapPackage) || copyablePlainMap(mapPackage);

  function terminate() {
    const previous = worker;
    worker = null;
    if (previous) {
      try { previous.onmessage = previous.onerror = previous.onmessageerror = null; } catch { /* Broken transport. */ }
      try { previous.terminate(); } catch { /* Already closed. */ }
    }
  }

  function infrastructureFailure(error) {
    disabled = true;
    terminate();
    active?.finish({ infrastructureError: error?.message || 'World validation Worker failed' });
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = workerFactory ? workerFactory() : new Worker(new URL('./world-validation-worker.js', import.meta.url), { type: 'module' });
    if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') {
      throw new TypeError('World validation Worker is unavailable');
    }
    const instance = worker;
    worker.onmessage = ({ data }) => {
      const request = active;
      if (worker !== instance || !request || data?.id !== request.id || data.generation !== request.generation) return;
      if (data.protocol !== 1 || data.kind !== 'runtime-world-export-result'
        || !validResponse(data)) {
        infrastructureFailure(new Error('Invalid World validation Worker response'));
      } else if (data.infrastructureError) {
        infrastructureFailure(new Error(String(data.infrastructureError)));
      } else request.finish(data);
    };
    worker.onerror = event => { event?.preventDefault?.(); if (worker === instance) infrastructureFailure(new Error(event?.message || 'World validation Worker failed')); };
    worker.onmessageerror = () => { if (worker === instance) infrastructureFailure(new Error('World validation Worker message failed')); };
    return instance;
  }

  function runWorker(prepared, map, recipe, signal) {
    return new Promise((resolve, reject) => {
      const id = ++nextId, requestGeneration = generation;
      let timer = null, finished = false;
      const abort = () => {
        terminate();
        finish(null, abortError(signal));
      };
      function finish(result, error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (active?.id === id) active = null;
        error ? reject(error) : resolve(result);
      }
      active = { id, generation: requestGeneration, finish };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const instance = ensureWorker();
        timer = setTimeout(() => infrastructureFailure(new Error('World validation Worker timed out')),
          Math.max(1, Number(timeoutMs) || 10000));
        instance.postMessage({ protocol: 1, kind: 'runtime-world-export', id, generation: requestGeneration,
          prepared, mapPackage: map, recipe });
      } catch (error) {
        if (signal?.aborted) abort();
        else infrastructureFailure(error);
      }
    });
  }

  function qualification(prepared) {
    const recipe = prepared.hasCanonicalWorld && builtIn && mapOwned && available && !disabled ? currentWorldValidationRecipe() : null;
    const map = recipe ? copyWorldValidationMap(mapPackage) : null;
    return recipe && map ? { recipe, map } : null;
  }

  async function perform(prepared, scheduler, controller, context) {
    const signal = controller.signal;
    signal.throwIfAborted();
    const fallback = async () => JSON.stringify(await exportPreparedRuntimeStateAsync(prepared, options, {
      budgetMs: scheduler.budgetMs ?? 0, signal,
      yieldTask: scheduler.yieldTask ?? (() => yieldRuntimeValidationFrame({ signal })),
    }));
    if (!context || disabled || currentWorldValidationRecipe() !== context.recipe
      || !sameWorldValidationMap(context.map, copyWorldValidationMap(mapPackage))) return fallback();
    const { recipe, map } = context;
    const response = await runWorker(prepared, map, recipe, signal);
    signal.throwIfAborted();
    // Definitions and map aliases remain editable by integrations. Never use
    // a result calculated against an obsolete captured context.
    if (response.infrastructureError || currentWorldValidationRecipe() !== recipe
      || !sameWorldValidationMap(map, copyWorldValidationMap(mapPackage))) return fallback();
    if (response.error) throw remoteValidationError(response.error);
    return response.json;
  }

  function serialize(state, scheduler = {}) {
    if (disposed) return Promise.reject(new DOMException('World validation disposed', 'AbortError'));
    const controller = new AbortController();
    const aborted = () => controller.abort(abortError(scheduler.signal));
    if (scheduler.signal?.aborted) aborted();
    else scheduler.signal?.addEventListener('abort', aborted, { once: true });
    cancellations.add(controller);
    let prepared;
    try {
      controller.signal.throwIfAborted();
      // Capture authority at the call, before waiting behind an older request.
      // Raw getters and the original class rejection remain on this realm.
      prepared = prepareRuntimeStateValidationInput(state, options);
    } catch (error) {
      cancellations.delete(controller);
      scheduler.signal?.removeEventListener('abort', aborted);
      return Promise.reject(error);
    }
    // Noncanonical legacy input retains the original asynchronous export's
    // first complete phase before yielding: it is never posted to a Worker.
    const context = qualification(prepared);
    const local = !context ? perform(prepared, scheduler, controller, null) : null;
    if (local) local.catch(() => {});
    const task = tail.then(() => local || perform(prepared, scheduler, controller, context));
    tail = task.catch(() => {});
    let stopped;
    const cancelled = new Promise((resolve, reject) => {
      stopped = () => reject(abortError(controller.signal));
      if (controller.signal.aborted) stopped();
      else controller.signal.addEventListener('abort', stopped, { once: true });
    });
    return Promise.race([task, cancelled]).finally(() => {
      cancellations.delete(controller);
      controller.signal.removeEventListener('abort', stopped);
      scheduler.signal?.removeEventListener('abort', aborted);
    });
  }

  function cancel() {
    generation += 1;
    for (const controller of cancellations) controller.abort(new DOMException('World validation cancelled', 'AbortError'));
    terminate();
  }

  return Object.freeze({ serialize, cancel, dispose() { if (!disposed) { disposed = true; cancel(); } } });
}
