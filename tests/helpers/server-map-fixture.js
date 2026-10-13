import runtimeData from '../../maps/lanzhou/runtime.json' with { type: 'json' };
import { createMinimalReferencePackage } from '../../maps/minimal/package.js';
import { buildMapArchive, inspectMapArchive } from '../../src/packages/map-archive.js';
import { prepareMapPackage } from '../../src/map-package/contract.js';
import { setServerMapResolver } from '../../src/server/movement-authority-entry.js';

function freeze(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value); Object.values(value).forEach(child => freeze(child, visited)); return Object.freeze(value);
}

/** The collision fixture goes through the production archive receipt, never a bounds-only stub. */
export function verifiedServerMapFixture(source) {
  const svg = source.svg || `<svg xmlns="http://www.w3.org/2000/svg" width="${source.width}" height="${source.height}"><g data-layer="base"/></svg>`;
  const checked = inspectMapArchive(buildMapArchive({ data: source, svg }));
  return freeze(prepareMapPackage({ ...checked.data, svg: checked.svg, manifest: checked.manifest,
    fingerprint: checked.fingerprint }, { source: 'verified-test-map' }));
}

export function installServerMapFixtures(sources = [runtimeData, createMinimalReferencePackage()]) {
  const packages = sources.map(verifiedServerMapFixture);
  const byReference = new Map(packages.map(pkg => [JSON.stringify([pkg.id, pkg.version]), pkg]));
  setServerMapResolver(scene => {
    const ref = scene?.mapPackage || {};
    return byReference.get(JSON.stringify([ref.id ?? ref.mapId, ref.version ?? ref.mapVersion])) || null;
  });
  return packages;
}
