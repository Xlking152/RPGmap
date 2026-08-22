const lifecycleWrappedApis = new WeakSet();

/**
 * Close the AppCore/runtime-adapter lifecycle boundary without teaching the
 * legacy app shell about individual tools. Runtime adapters subscribe to the
 * generic `app:destroy` event and clean up their own listeners/observers before
 * Leaflet and the shell are torn down.
 */
export function createAppLifecycleSystem() {
  return Object.freeze({
    register(api) {
      if (!api || lifecycleWrappedApis.has(api) || typeof api.destroy !== 'function') return;

      lifecycleWrappedApis.add(api);
      const destroyCore = api.destroy.bind(api);
      let destroyed = false;

      api.destroy = () => {
        if (destroyed) return false;
        destroyed = true;
        api.emit?.('app:destroy', null);
        destroyCore();
        return true;
      };
    },
  });
}
