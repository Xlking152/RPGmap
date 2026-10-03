const readers = new WeakMap();

// Internal readers must treat this snapshot as immutable. Public getState()
// still returns a detached copy; committed Document updates use copy-on-write.
export function registerRuntimeStateReader(api, read) {
  readers.set(api, read);
  return () => readers.delete(api);
}

export function readRuntimeState(api) {
  return readers.get(api)?.() ?? api.getState?.() ?? {};
}
