import path from 'node:path';
import runtimeData from '../maps/lanzhou/runtime.json' with { type: 'json' };
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { buildMapArchive } from '../src/packages/map-archive.js';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';

// Test and benchmark servers receive real, validated external packages. These
// fixtures are never imported by the application or desktop distribution.
export async function installServerPackageFixtures(root, extraMaps = []) {
  const store = await new MapPackageStore({ root: path.join(root, 'packages', 'maps') }).initialize();
  const plainMap = (id, width, height) => ({ id, version: '1', name: id,
    width, height, metersPerUnit: 1, features: [], layerPlan: [{ id: 'base', role: 'base', sourceLayers: ['base'] }] });
  const sources = [runtimeData, createMinimalReferencePackage(), plainMap('test', 5000, 5000),
    plainMap('test-map', 1000, 1000), { ...plainMap('benchmark-map', 5000, 5000), version: '1.0.0' }, ...extraMaps];
  for (const data of sources) {
    const svg = data.svg || `<svg xmlns="http://www.w3.org/2000/svg" width="${data.width}" height="${data.height}"><g data-layer="base"/></svg>`;
    await store.install(buildMapArchive({ data, svg }));
  }
  return store;
}
