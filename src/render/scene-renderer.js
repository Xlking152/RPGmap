import { deriveFloodRegions, deriveSceneState } from '../engine/state.js';
import { resolveRuinsResource, ruinsBounds, ruinsImageLayout, ruinsPath, ruinsPolygons } from './ruins-geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createSceneRenderer({ baseSvg, mapPackage, getSceneEvents, getDamagePreview }) {
  if (!baseSvg) throw new Error('场景渲染器缺少底图 SVG');
  if (!mapPackage) throw new Error('场景渲染器缺少地图包');
  const doc = baseSvg.ownerDocument;
  const featureById = new Map((mapPackage.features || []).map((feature) => [feature.id, feature]));
  const featureNodes = new Map();
  let featureGeometry = new WeakMap();
  const ruinRecords = new Map();
  const inactiveRuins = new Map();
  const inactiveRuinsLimit = Math.min(512, featureById.size);
  const floodRecords = new Map();
  let previousEvents = null;
  let previousAssets = null;
  let previousPreviewIds = new Set();
  let craterRecord = null;
  let runtimeDefs = null;
  let ruinsLayer = null;
  let floodLayer = null;
  let destroyed = false;
  let renderCount = 0;
  let maskBuildCount = 0;
  let reusedObjectCount = 0;
  let cachedFeatureGeometry = 0;
  let lastRenderMs = 0;
  let maxRenderMs = 0;

  function svgNode(tag, attributes = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function featureNode(id) {
    if (!featureNodes.has(id)) {
      const node = doc.getElementById('feature-' + id) || baseSvg.querySelector('[data-feature-id="' + CSS.escape(id) + '"]');
      if (node) node.classList.add('scene-feature');
      featureNodes.set(id, node || null);
    }
    return featureNodes.get(id);
  }

  function appendPolygonPaths(parent, polygons, fill) {
    for (const rings of polygons) parent.append(svgNode('path', {
      d: ruinsPath(rings), fill, 'fill-rule': 'evenodd', 'clip-rule': 'evenodd',
    }));
  }

  function outline(feature) {
    if (!featureGeometry.has(feature)) {
      cachedFeatureGeometry++;
      try {
        const polygons = ruinsPolygons(feature);
        featureGeometry.set(feature, { polygons, bounds: ruinsBounds(polygons) });
      } catch {
        // Imported unsupported presentation geometry does not alter its authoritative rules.
        featureGeometry.set(feature, { polygons: [], bounds: null });
      }
    }
    return featureGeometry.get(feature);
  }

  function ensureLayers() {
    if (ruinsLayer) return;
    ruinsLayer = baseSvg.querySelector('#layer-scene-ruins');
    if (!ruinsLayer) {
      ruinsLayer = svgNode('g', { id: 'layer-scene-ruins', 'data-layer': 'scene-ruins', 'pointer-events': 'none' });
      const structures = baseSvg.querySelector('#layer-destructible') || baseSvg.querySelector('[data-layer="structure"]');
      if (structures) structures.parentNode.insertBefore(ruinsLayer, structures);
      else {
        const labels = baseSvg.querySelector('#layer-labels');
        if (labels) labels.parentNode.insertBefore(ruinsLayer, labels); else baseSvg.append(ruinsLayer);
      }
    }
    floodLayer = baseSvg.querySelector('#layer-flood');
    if (!floodLayer) {
      floodLayer = svgNode('g', { id: 'layer-flood', 'data-layer': 'flood' });
      const labels = baseSvg.querySelector('#layer-labels');
      if (labels) labels.parentNode.insertBefore(floodLayer, labels); else baseSvg.append(floodLayer);
    }
    runtimeDefs = svgNode('defs', { id: 'scene-runtime-defs' });
    ruinsLayer.append(runtimeDefs);
    for (const [id, color] of [['scene-ruin-texture', '#81705a'], ['scene-severe-ruin-texture', '#514637']]) {
      const pattern = svgNode('pattern', { id, patternUnits: 'userSpaceOnUse', width: 48, height: 48 });
      pattern.append(svgNode('rect', { x: 0, y: 0, width: 48, height: 48, fill: color }));
      pattern.append(svgNode('path', { d: 'M 0 11 L 17 7 L 27 16 L 21 29 L 7 31 Z M 31 29 L 46 24 L 49 41 L 35 47 Z',
        fill: id === 'scene-severe-ruin-texture' ? '#30281f' : '#b09a7a', opacity: '.7' }));
      runtimeDefs.append(pattern);
    }
    const floodDepth = svgNode('radialGradient', { id: 'scene-flood-depth', cx: '50%', cy: '50%', r: '72%' });
    for (const [offset, color, opacity] of [['0%', '#2f5a6b', '.88'], ['55%', '#4f879b', '.72'],
      ['85%', '#7fa8ad', '.42'], ['100%', '#9dbdb8', '.12']]) {
      floodDepth.append(svgNode('stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
    }
    runtimeDefs.append(floodDepth);
  }

  function mask(id, bounds, initialFill) {
    const attributes = { x: bounds.minX, y: bounds.minY,
      width: Math.max(1e-8, bounds.maxX - bounds.minX), height: Math.max(1e-8, bounds.maxY - bounds.minY) };
    const node = svgNode('mask', { id, maskUnits: 'userSpaceOnUse', maskContentUnits: 'userSpaceOnUse',
      'mask-type': 'luminance', ...attributes });
    if (initialFill) node.append(svgNode('rect', { ...attributes, fill: initialFill }));
    return node;
  }

  function texture(feature, bounds, severe = false) {
    const group = svgNode('g', { class: severe ? 'scene-ruin-texture scene-ruin-texture-severe' : 'scene-ruin-texture' });
    // A static underlay remains visible if an optional map asset cannot be loaded.
    group.append(svgNode('rect', { x: bounds.minX, y: bounds.minY,
      width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY,
      fill: severe ? 'url(#scene-severe-ruin-texture)' : 'url(#scene-ruin-texture)' }));
    const resource = resolveRuinsResource(feature, mapPackage.artAssets, severe);
    if (resource) {
      const layout = ruinsImageLayout(feature, bounds, resource);
      const imageViewport = svgNode('svg', { x: layout.x, y: layout.y, width: layout.width, height: layout.height,
        viewBox: layout.viewBox, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
      const image = svgNode('image', { href: resource.url, x: 0, y: 0, width: layout.sourceWidth,
        height: layout.sourceHeight, preserveAspectRatio: 'none', 'data-rubble-variant': layout.variant });
      // A legacy/normal asset remains usable for severe damage, with the darker static underlay showing through.
      if (severe && resource.url === resolveRuinsResource(feature, mapPackage.artAssets)?.url) image.setAttribute('opacity', '.66');
      image.addEventListener('error', () => {
        imageViewport.setAttribute('visibility', 'hidden'); group.setAttribute('data-ruin-asset-failed', 'true');
      }, { once: true });
      imageViewport.append(image);
      group.append(imageViewport);
    }
    return group;
  }

  function removeRuin(id, retain = true) {
    const record = ruinRecords.get(id);
    if (!record) return;
    record.group.remove();
    for (const node of record.definitions) node.remove();
    const node = featureNode(id);
    node?.classList.remove('scene-destroyed');
    node?.removeAttribute('mask');
    for (const label of baseSvg.querySelectorAll('[data-label-for="' + CSS.escape(id) + '"]')) label.classList.remove('scene-label-destroyed');
    ruinRecords.delete(id);
    if (retain && inactiveRuinsLimit) {
      inactiveRuins.delete(id); inactiveRuins.set(id, record);
      while (inactiveRuins.size > inactiveRuinsLimit) inactiveRuins.delete(inactiveRuins.keys().next().value);
    }
  }

  function updateRuin(feature, damage, index) {
    // Event IDs identify authority history, not pixels. Whole ordinary damage
    // does not need its old ordinary local hits in the display signature.
    const signature = JSON.stringify({ damage: { whole: damage.whole, severeWhole: damage.severeWhole,
      hits: damage.hits.filter(hit => !damage.whole || hit.severe)
        .map(hit => ({ polygon: hit.polygon, severe: hit.severe })) }, normal: resolveRuinsResource(feature, mapPackage.artAssets),
      severe: resolveRuinsResource(feature, mapPackage.artAssets, true) });
    const existing = ruinRecords.get(feature.id);
    if (existing?.signature === signature) { reusedObjectCount++; return; }
    const cached = inactiveRuins.get(feature.id);
    const reusable = cached?.signature === signature && !cached.group.querySelector('[data-ruin-asset-failed]');
    if (reusable) inactiveRuins.delete(feature.id);
    removeRuin(feature.id);
    if (reusable) {
      runtimeDefs.append(...cached.definitions); ruinsLayer.append(cached.group);
      const node = featureNode(feature.id);
      if (cached.whole) {
        node?.classList.add('scene-destroyed');
        for (const label of baseSvg.querySelectorAll('[data-label-for="' + CSS.escape(feature.id) + '"]')) label.classList.add('scene-label-destroyed');
      } else node?.setAttribute('mask', `url(#${cached.originalMaskId})`);
      ruinRecords.set(feature.id, cached); reusedObjectCount++;
      return;
    }
    const geometry = outline(feature);
    if (!geometry.bounds) return;
    const prefix = `scene-ruin-${index}`;
    const definitions = [];
    const clipping = svgNode('clipPath', { id: prefix + '-outline', clipPathUnits: 'userSpaceOnUse' });
    appendPolygonPaths(clipping, geometry.polygons, '#fff');
    definitions.push(clipping);
    const group = svgNode('g', { class: 'scene-ruin', 'data-ruin-for': feature.id,
      'clip-path': `url(#${prefix}-outline)` });
    const normal = damage.severeWhole ? null : texture(feature, geometry.bounds);
    if (!damage.whole) {
      const displayMask = mask(prefix + '-damage', geometry.bounds, '#000');
      for (const hit of damage.hits) appendPolygonPaths(displayMask, ruinsPolygons(hit.polygon), '#fff');
      definitions.push(displayMask);
      normal.setAttribute('mask', `url(#${prefix}-damage)`);
      const originalMask = mask(prefix + '-original', {
        minX: -mapPackage.width * 4, minY: -mapPackage.height * 4,
        maxX: mapPackage.width * 5, maxY: mapPackage.height * 5,
      }, '#fff');
      for (const hit of damage.hits) appendPolygonPaths(originalMask, ruinsPolygons(hit.polygon), '#000');
      definitions.push(originalMask);
      featureNode(feature.id)?.setAttribute('mask', `url(#${prefix}-original)`);
    } else {
      featureNode(feature.id)?.classList.add('scene-destroyed');
      for (const label of baseSvg.querySelectorAll('[data-label-for="' + CSS.escape(feature.id) + '"]')) label.classList.add('scene-label-destroyed');
    }
    if (normal) group.append(normal);
    const severeHits = damage.hits.filter((hit) => hit.severe);
    if (damage.severeWhole || severeHits.length) {
      const severe = texture(feature, geometry.bounds, true);
      if (!damage.severeWhole) {
        const severeMask = mask(prefix + '-severe', geometry.bounds, '#000');
        for (const hit of severeHits) appendPolygonPaths(severeMask, ruinsPolygons(hit.polygon), '#fff');
        definitions.push(severeMask);
        severe.setAttribute('mask', `url(#${prefix}-severe)`);
      }
      group.append(severe);
    }
    runtimeDefs.append(...definitions);
    ruinsLayer.append(group);
    ruinRecords.set(feature.id, { signature, group, definitions, whole: damage.whole,
      originalMaskId: prefix + '-original' });
    maskBuildCount++;
  }

  function updateCraters(craters) {
    const signature = JSON.stringify(craters.map((crater) => ({ id: crater.eventId, polygon: crater.polygon })));
    if (craterRecord?.signature === signature) return;
    craterRecord?.group.remove(); craterRecord?.mask.remove(); craterRecord = null;
    if (!craters.length) return;
    // One map-aligned image and one union mask prevent overlapping crater decals from darkening.
    const bounds = { minX: 0, minY: 0, maxX: mapPackage.width, maxY: mapPackage.height };
    const displayMask = mask('scene-craters-mask', bounds, '#000');
    for (const crater of craters) appendPolygonPaths(displayMask, ruinsPolygons(crater.polygon), '#fff');
    const group = svgNode('g', { class: 'scene-crater', 'data-crater-regions': craters.length,
      mask: 'url(#scene-craters-mask)' });
    group.append(texture({ id: 'scene-ground', category: 'terrain', ruinStyle: 'terrain' }, bounds, true));
    runtimeDefs.append(displayMask);
    ruinsLayer.insertBefore(group, runtimeDefs.nextSibling);
    craterRecord = { signature, group, mask: displayMask };
    maskBuildCount++;
  }

  function updateFloods(scene) {
    const regions = deriveFloodRegions(scene, mapPackage.liquidBodies || [], mapPackage.features || [],
      mapPackage.floodRules || {}, mapPackage.metersPerUnit ?? 1);
    const active = new Set(regions.map((region) => region.id));
    for (const [id, record] of floodRecords) if (!active.has(id)) { record.group.remove(); floodRecords.delete(id); }
    for (const region of regions) {
      const signature = JSON.stringify(region);
      const old = floodRecords.get(region.id);
      if (old?.signature === signature) continue;
      old?.group.remove();
      const group = svgNode('g', { class: `scene-flood scene-flood-${region.kind}${previousEvents && !old ? ' scene-flood-new' : ''}`,
        'data-flood-for': region.id });
      for (const rings of ruinsPolygons(region.polygon)) {
        if (rings.length === 1) group.append(svgNode('polygon', { points: rings[0].map((point) => point.join(',')).join(' '),
          fill: 'url(#scene-flood-depth)' }));
        else appendPolygonPaths(group, [rings], 'url(#scene-flood-depth)');
      }
      if (region.kind === 'inlet' && Array.isArray(region.flowLine)) group.append(svgNode('path', {
        d: `M ${region.flowLine[0][0]} ${region.flowLine[0][1]} L ${region.flowLine[1][0]} ${region.flowLine[1][1]}`,
        class: 'scene-flood-flow-line', pathLength: 1,
      }));
      floodLayer.append(group);
      floodRecords.set(region.id, { signature, group });
    }
  }

  function updatePreview() {
    const preview = getDamagePreview?.();
    const next = new Set(preview?.featureIds || [...(preview?.objectIds || []), ...(preview?.clipHits || []).map((hit) => hit.featureId)]);
    for (const id of previousPreviewIds) if (!next.has(id)) featureNode(id)?.classList.remove('preview-hit');
    for (const id of next) if (!previousPreviewIds.has(id)) featureNode(id)?.classList.add('preview-hit');
    previousPreviewIds = next;
  }

  function renderScene() {
    if (destroyed) return;
    renderCount++;
    ensureLayers();
    const events = getSceneEvents?.() || [];
    const unchanged = previousAssets === mapPackage.artAssets && (events === previousEvents || (previousEvents && events.length === previousEvents.length
      && events.every((event, index) => event === previousEvents[index])));
    if (!unchanged) {
      const scene = deriveSceneState(events);
      const activeEventIds = new Set(scene.activeSceneEventIds);
      const severity = new Map(events.filter((event) => activeEventIds.has(event.id ?? event.eventId))
        .map((event) => [event.id ?? event.eventId, event.areaSnapshot?.severeDamage === true]));
      const wholeSeverity = new Map();
      for (const event of events) {
        const id = event.id ?? event.eventId;
        if (!activeEventIds.has(id)) continue;
        const type = String(event.type).toLowerCase();
        if (type === 'reset') { wholeSeverity.clear(); continue; }
        if (type === 'restore') {
          for (const featureId of event.featureIds || []) wholeSeverity.delete(featureId);
          continue;
        }
        if (type === 'damage') for (const featureId of event.objectIds || []) {
          wholeSeverity.set(featureId, wholeSeverity.get(featureId) === true || severity.get(id) === true);
        }
      }
      const damage = new Map();
      for (const id of scene.destroyedObjectIds) damage.set(id, { whole: true, severeWhole: wholeSeverity.get(id) === true, hits: [] });
      const craterEventIds = new Set(scene.craterRegions.map((crater) => crater.eventId));
      for (const hit of scene.clipHits) {
        const feature = featureById.get(hit.featureId);
        if (!feature || (feature.severeOnly && craterEventIds.has(hit.eventId))) continue;
        if (!damage.has(hit.featureId)) damage.set(hit.featureId, { whole: false, severeWhole: false, hits: [] });
        damage.get(hit.featureId).hits.push({ eventId: hit.eventId, polygon: hit.polygon,
          severe: feature.severeOnly === true || severity.get(hit.eventId) === true });
      }
      for (const id of ruinRecords.keys()) if (!damage.has(id)) removeRuin(id);
      let index = 0;
      for (const feature of featureById.values()) {
        const record = damage.get(feature.id);
        if (record) updateRuin(feature, record, index);
        index++;
      }
      updateCraters(scene.craterRegions);
      updateFloods(scene);
      previousEvents = [...events];
      previousAssets = mapPackage.artAssets;
    }
    updatePreview();
  }

  function render() {
    if (destroyed) return;
    const start = performance.now();
    try { renderScene(); }
    finally { lastRenderMs = performance.now() - start; maxRenderMs = Math.max(maxRenderMs, lastRenderMs); }
  }

  function reset() {
    for (const id of [...ruinRecords.keys()]) removeRuin(id, false);
    inactiveRuins.clear();
    for (const [id, node] of featureNodes) {
      node?.classList.remove('preview-hit', 'scene-destroyed'); node?.removeAttribute('mask');
      for (const label of baseSvg.querySelectorAll('[data-label-for="' + CSS.escape(id) + '"]')) label.classList.remove('scene-label-destroyed');
    }
    baseSvg.querySelector('#layer-damage')?.replaceChildren();
    ruinsLayer?.replaceChildren(); floodLayer?.replaceChildren();
    craterRecord = null; runtimeDefs = null; ruinsLayer = null; floodLayer = null;
    featureNodes.clear(); floodRecords.clear(); previousEvents = null; previousAssets = null; previousPreviewIds.clear();
    featureGeometry = new WeakMap(); cachedFeatureGeometry = 0;
  }

  function dispose() { reset(); destroyed = true; }
  return { render, reset, dispose, getDiagnostics: () => ({ renders: renderCount,
    ruinObjects: ruinRecords.size, craterObjects: craterRecord ? 1 : 0, floodObjects: floodRecords.size,
    maskBuilds: maskBuildCount, reusedObjects: reusedObjectCount, lastRenderMs, maxRenderMs,
    cachedFeatureGeometry, cachedNodes: featureNodes.size, ruinObjectsLimit: featureById.size,
    inactiveRuins: inactiveRuins.size, inactiveRuinsLimit,
    largestRuinVersions: Math.max(0, ...[...featureById.keys()].map(id => Number(ruinRecords.has(id)) + Number(inactiveRuins.has(id)))),
    cachedNodesLimit: featureById.size, featureGeometryLimit: featureById.size, craterObjectsLimit: 1 }) };
}
