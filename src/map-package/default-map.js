import runtimeSvgUrl from '../../reference/maps/lanzhou/runtime.svg?url';
import runtimeDataUrl from '../../reference/maps/lanzhou/runtime.json?url';
import { createLanzhouGeneratedArtAssets } from '../../reference/maps/lanzhou/assets.js';
import { prepareMapPackage } from './contract.js';

function resolvePath(source, path) {
  return path.split('.').reduce((value, key) => value?.[key], source);
}

function applyArtAssetUrls(svg, artAssets) {
  return svg.replace(/__RPGMAP_ASSET_([A-Za-z0-9.]+)__/g, (_token, path) => {
    const value = resolvePath(artAssets, path);
    if (!value) throw new Error(`Missing Lanzhou runtime art asset: ${path}`);
    return String(value);
  });
}

export async function createDefaultMapPackage() {
  const artAssets = createLanzhouGeneratedArtAssets();
  const [svgResponse, dataResponse] = await Promise.all([
    fetch(runtimeSvgUrl),
    fetch(runtimeDataUrl),
  ]);
  if (!svgResponse.ok || !dataResponse.ok) {
    const error = new Error(`Unable to load Lanzhou runtime assets (${svgResponse.status}/${dataResponse.status})`);
    error.code = 'map_package_asset_load_failed';
    throw error;
  }
  const svg = applyArtAssetUrls(await svgResponse.text(), artAssets);
  const source = await dataResponse.json();
  const mapPackage = {
    ...source,
    artAssets,
    svg,
    createSvg: () => svg,
  };
  return prepareMapPackage(mapPackage, {
    source: 'reference/maps/lanzhou',
  });
}
