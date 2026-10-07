const readers = new WeakMap();
const operationInputs = new WeakMap();

// Internal readers must treat this snapshot as immutable. Public getState()
// still returns a detached copy; committed Document updates use copy-on-write.
export function registerRuntimeStateReader(api, read) {
  readers.set(api, read);
  return () => readers.delete(api);
}

export function readRuntimeState(api) {
  return readers.get(api)?.() ?? api.getState?.() ?? {};
}

// Internal WorldSystem capability. The caller owns the controlled read-only
// reducer context; public reducer options cannot substitute a boolean proof.
export function createRuntimeOperationInputProof(api, state, context) {
  const reader = readers.get(api), revisionReader = api?.getStateRevision;
  if (typeof reader !== 'function' || typeof revisionReader !== 'function') return null;
  const revision = revisionReader.call(api);
  if (!Number.isSafeInteger(revision) || reader() !== state) return null;
  const proof = Object.freeze({});
  operationInputs.set(proof, { api, reader, revisionReader, state, revision, context,
    fields: Object.entries(context).filter(([key]) => key !== 'runtimeOperationInputProof'),
    visionDescribe: context.ruleset?.vision?.describe,
    sourceRole: context.source?.role, sourceName: context.source?.source });
  return proof;
}

export function isCurrentRuntimeOperationInput(proof, state, context) {
  const input = operationInputs.get(proof);
  if (!input || input.state !== state || input.context !== context
    || readers.get(input.api) !== input.reader || input.api.getStateRevision !== input.revisionReader
    || input.revisionReader.call(input.api) !== input.revision || input.reader() !== state
    || context.ruleset?.vision?.describe !== input.visionDescribe
    || context.source?.role !== input.sourceRole || context.source?.source !== input.sourceName) return false;
  const fields = Object.entries(context).filter(([key]) => key !== 'runtimeOperationInputProof');
  return fields.length === input.fields.length
    && fields.every(([key, value], index) => key === input.fields[index][0] && value === input.fields[index][1]);
}
