/** Browser adapter for verified server packages. No authoring inputs are bundled. */
export async function registerInstalledMapPackages(registry, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('/api/packages/maps', { cache: 'no-store' });
  if (!response.ok) throw new Error('map_catalog_unavailable');
  const catalog = await response.json();
  for (const entry of catalog.maps || []) registry.registerLoader({ ...entry, source: 'installed', load: async () => {
    const url = `/api/packages/maps/${encodeURIComponent(entry.id)}/${encodeURIComponent(entry.version)}`;
    const loaded = await fetchImpl(url, { cache: 'no-store' });
    if (!loaded.ok) throw Object.assign(new Error('map_package_not_found'), { code: 'map_package_not_found' });
    const map = await loaded.json();
    if (map.fingerprint !== entry.fingerprint) throw new Error('map_package_fingerprint_changed');
    return map;
  } });
  return catalog.maps || [];
}

export async function loadInstalledRulesetReference(reference) {
  const registry = await import('../ruleset/index.js');
  try { return registry.resolveRulesetReference(reference); }
  catch (error) {
    const url = `/api/packages/rulesets/${encodeURIComponent(reference.id)}/${encodeURIComponent(reference.version)}/files/entry.mjs`;
    const module = await import(/* @vite-ignore */ url);
    const ruleset = registry.rulesetRegistry.register(module.default || module.ruleset);
    if (ruleset.id !== reference.id || ruleset.version !== reference.version) throw new Error('ruleset_reference_mismatch');
    return ruleset;
  }
}
