import assert from 'node:assert/strict';
import test from 'node:test';
import { createSceneRenderer } from '../src/render/scene-renderer.js';
import { resolveRuinsResource, ruinsImageLayout, ruinsPath, ruinsPolygons } from '../src/render/ruins-geometry.js';

function fakeDocument() {
  function matches(node, selector) {
    if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attribute) return attribute[2] === undefined ? node.attributes.has(attribute[1]) : node.getAttribute(attribute[1]) === attribute[2];
    return node.tagName === selector;
  }
  const document = { root: null, createElementNS(_namespace, tag) {
    const node = {
      tagName: tag, ownerDocument: document, attributes: new Map(), children: [], parentNode: null, listeners: new Map(),
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      append(...children) { for (const child of children) this.insertBefore(child, null); },
      insertBefore(child, reference) {
        child.remove();
        const index = reference ? this.children.indexOf(reference) : this.children.length;
        if (index < 0) throw new Error('Invalid reference node');
        this.children.splice(index, 0, child); child.parentNode = this;
      },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
      remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; },
      querySelectorAll(selector) {
        const result = [];
        const visit = (child) => { if (matches(child, selector)) result.push(child); for (const nested of child.children) visit(nested); };
        for (const child of this.children) visit(child);
        return result;
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
    };
    node.classList = {
      contains(name) { return (node.getAttribute('class') || '').split(/\s+/).includes(name); },
      add(...names) { node.setAttribute('class', [...new Set([...(node.getAttribute('class') || '').split(/\s+/).filter(Boolean), ...names])].join(' ')); },
      remove(...names) { node.setAttribute('class', (node.getAttribute('class') || '').split(/\s+/).filter((name) => name && !names.includes(name)).join(' ')); },
    };
    return node;
  }, getElementById(id) { return this.root?.querySelector('#' + id) || null; } };
  return document;
}

function ring(x = 0, y = 0, width = 100, height = 100) {
  return [[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]];
}
function feature(id = 'building', category = 'building', geometry = { type: 'polygon', points: ring() }) {
  return { id, category, ruinStyle: 'test-style', geometry,
    capabilities: { vision: { occluder: true }, navigation: { blocks: true } } };
}
function damage(id, options = {}) { return { id, type: 'damage', objectIds: [], clipHits: [], ...options }; }

function fixture(t, features = [feature()], artAssets = {}) {
  const document = fakeDocument();
  const previousCSS = globalThis.CSS;
  globalThis.CSS = { escape: (value) => String(value) };
  t.after(() => { if (previousCSS === undefined) delete globalThis.CSS; else globalThis.CSS = previousCSS; });
  const svg = document.createElementNS('', 'svg'); document.root = svg;
  const node = (tag, attributes = {}) => {
    const result = document.createElementNS('', tag);
    for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, value);
    return result;
  };
  const ground = node('g', { id: 'layer-terrain' });
  const staticRuins = node('g', { id: 'layer-ruins', 'data-layer': 'ruins' });
  const structures = node('g', { id: 'layer-destructible' });
  const damageLayer = node('g', { id: 'layer-damage' });
  const floods = node('g', { id: 'layer-flood' });
  const labels = node('g', { id: 'layer-labels' });
  for (const value of features) {
    structures.append(node('g', { id: 'feature-' + value.id, 'data-feature-id': value.id }));
    labels.append(node('text', { 'data-label-for': value.id }));
  }
  svg.append(ground, staticRuins, structures, damageLayer, floods, labels);
  let events = [], preview = null;
  const mapPackage = { width: 1000, height: 1000, metersPerUnit: 1, features, artAssets, liquidBodies: [] };
  const renderer = createSceneRenderer({ baseSvg: svg, mapPackage, getSceneEvents: () => events, getDamagePreview: () => preview });
  return { svg, renderer, structures, staticRuins, mapPackage,
    setEvents(value) { events = value; }, setPreview(value) { preview = value; },
    original(id) { return svg.querySelector('#feature-' + id); },
    ruin(id) { return svg.querySelector('[data-ruin-for="' + id + '"]'); },
  };
}

test('display paths preserve exact damage coordinates, holes and disconnected pieces', () => {
  const damaged = ring(1.123456789, 2.987654321, 5, 9);
  assert.equal(ruinsPath(ruinsPolygons(damaged)[0]), `M ${damaged.map((point) => point.join(' ')).join(' L ')} Z`);
  const value = feature('courtyard', 'building', { type: 'multipolygon', coordinates: [[ring(), ring(20, 20, 30, 30)], [ring(200, 0, 40, 40)]] });
  const polygons = ruinsPolygons(value);
  assert.equal(polygons.length, 2);
  assert.equal(polygons[0].length, 2);
  assert.equal(ruinsPath(polygons[0]).split(' Z').length - 1, 2);
});

test('runtime ruins live above ground and below intact structures without changing the static ruins layer', (t) => {
  const f = fixture(t);
  f.setEvents([damage('hit', { clipHits: [{ featureId: 'building', polygon: ring(0, 0, 50, 100) }] })]);
  f.renderer.render();
  const layer = f.svg.querySelector('#layer-scene-ruins');
  assert.equal(layer.getAttribute('data-layer'), 'scene-ruins');
  assert.ok(f.svg.children.indexOf(f.staticRuins) < f.svg.children.indexOf(layer));
  assert.ok(f.svg.children.indexOf(layer) < f.svg.children.indexOf(f.structures));
  assert.equal(f.staticRuins.children.length, 0);
  assert.equal(f.svg.querySelectorAll('[data-feature-id]').length, 1);
  assert.equal(f.ruin('building').getAttribute('data-feature-id'), null);
  assert.match(f.original('building').getAttribute('mask'), /scene-ruin-0-original/);
  const originalMask = f.svg.querySelector('#scene-ruin-0-original');
  assert.equal(originalMask.querySelector('path').getAttribute('d'), ruinsPath(ruinsPolygons(ring(0, 0, 50, 100))[0]));
  assert.equal(originalMask.querySelector('path').getAttribute('fill'), '#000');
  assert.equal(f.svg.querySelectorAll('filter').length, 0);
});

test('overlapping attacks use one fixed image and a white union mask instead of stacking decals', (t) => {
  const f = fixture(t, [feature()], { ruins: { 'test-style': { normal: 'rubble-normal.webp' } } });
  const first = damage('first', { clipHits: [{ featureId: 'building', polygon: ring(0, 0, 60, 100) }] });
  f.setEvents([first]); f.renderer.render();
  const initialImage = f.ruin('building').querySelector('svg');
  const initialLayout = ['x', 'y', 'width', 'height', 'viewBox'].map((key) => initialImage.getAttribute(key));
  f.setEvents([first, damage('second', { clipHits: [{ featureId: 'building', polygon: ring(30, 0, 65, 100) }] })]);
  f.renderer.render();
  assert.equal(f.ruin('building').querySelectorAll('image').length, 1);
  assert.deepEqual(['x', 'y', 'width', 'height', 'viewBox'].map((key) => f.ruin('building').querySelector('svg').getAttribute(key)), initialLayout);
  const displayMask = f.svg.querySelector('#scene-ruin-0-damage');
  assert.equal(displayMask.querySelectorAll('path').length, 2);
  assert.ok(displayMask.querySelectorAll('path').every((path) => path.getAttribute('fill') === '#fff' && path.getAttribute('opacity') === null));
});

test('whole destruction hides the original without changing capabilities and uses the same object-aligned image', (t) => {
  const source = feature();
  const before = structuredClone(source);
  const f = fixture(t, [source], { ruins: { 'test-style': { normal: 'rubble.webp' } } });
  f.setEvents([damage('partial', { clipHits: [{ featureId: source.id, polygon: ring(0, 0, 10, 10) }] })]);
  f.renderer.render();
  const imageBefore = f.ruin(source.id).querySelector('svg');
  const bounds = ['x', 'y', 'width', 'height'].map((key) => imageBefore.getAttribute(key));
  f.setEvents([damage('whole', { objectIds: [source.id] })]); f.renderer.render();
  assert.equal(f.original(source.id).classList.contains('scene-destroyed'), true);
  assert.equal(f.original(source.id).getAttribute('mask'), null);
  assert.deepEqual(source, before);
  assert.deepEqual(['x', 'y', 'width', 'height'].map((key) => f.ruin(source.id).querySelector('svg').getAttribute(key)), bounds);
  assert.equal(f.svg.querySelector('[data-label-for="building"]').classList.contains('scene-label-destroyed'), true);
});

test('whole destruction appended after overlapping normal and severe clips exposes the complete ordinary texture', (t) => {
  const f = fixture(t, [feature(), feature('neighbor')], { ruins: { 'test-style': { normal: 'normal.webp', severe: 'severe.webp' } } });
  const events = [
    damage('partial', { clipHits: [{ featureId: 'building', polygon: ring(0, 0, 30, 100) },
      { featureId: 'neighbor', polygon: ring(0, 0, 10, 10) }] }),
    damage('overlap', { clipHits: [{ featureId: 'building', polygon: ring(20, 0, 30, 100) }] }),
    damage('severe', { areaSnapshot: { severeDamage: true },
      clipHits: [{ featureId: 'building', polygon: ring(30, 0, 40, 100) }], craterPolygon: ring(200, 200, 10, 10) }),
  ];
  f.setEvents(events); f.renderer.render();
  assert.ok(f.ruin('building').querySelector('.scene-ruin-texture').getAttribute('mask'));
  const neighbor = f.ruin('neighbor'), crater = f.svg.querySelector('.scene-crater');
  f.setEvents([...events, damage('explicit-whole', { objectIds: ['building'] })]); f.renderer.render();
  const textures = f.ruin('building').querySelectorAll('.scene-ruin-texture');
  assert.equal(textures.length, 2);
  assert.equal(textures[0].getAttribute('mask'), null, 'whole ordinary texture is independent of all prior clip masks');
  assert.ok(textures[1].getAttribute('mask'), 'old severe damage remains restricted to its actual area');
  assert.equal(f.original('building').classList.contains('scene-destroyed'), true);
  assert.equal(f.original('building').getAttribute('mask'), null);
  assert.equal(f.svg.querySelector('#scene-ruin-0-damage'), null);
  assert.equal(f.ruin('neighbor'), neighbor);
  assert.equal(f.svg.querySelector('.scene-crater'), crater);
});

test('severe regions select the severe asset while normal and severe overlapping hits remain two fixed images', (t) => {
  const f = fixture(t, [feature()], { ruins: { 'test-style': { normal: 'normal.webp', severe: { url: 'severe.webp' } } } });
  f.setEvents([
    damage('normal', { clipHits: [{ featureId: 'building', polygon: ring(0, 0, 70, 100) }] }),
    damage('severe', { areaSnapshot: { severeDamage: true }, clipHits: [{ featureId: 'building', polygon: ring(40, 0, 50, 100) }] }),
    damage('severe-again', { areaSnapshot: { severeDamage: true }, clipHits: [{ featureId: 'building', polygon: ring(50, 0, 50, 100) }] }),
  ]);
  f.renderer.render();
  assert.deepEqual(f.ruin('building').querySelectorAll('image').map((image) => image.getAttribute('href')), ['normal.webp', 'severe.webp']);
  assert.equal(f.svg.querySelector('#scene-ruin-0-severe').querySelectorAll('path').length, 2);
});

test('restoring an object clears its old severity and preserves other objects and independent crater damage', (t) => {
  const f = fixture(t, [feature(), feature('wall', 'wall')], { ruins: { 'test-style': { normal: 'normal.webp', severe: 'severe.webp' } } });
  const events = [
    damage('whole-severe', { areaSnapshot: { severeDamage: true }, objectIds: ['building'] }),
    damage('wall-damage', { clipHits: [{ featureId: 'wall', polygon: ring(0, 0, 20, 20) }] }),
    damage('independent-crater', { craterPolygon: ring(200, 200, 10, 10) }),
  ];
  f.setEvents(events); f.renderer.render();
  const wallRuin = f.ruin('wall'), crater = f.svg.querySelector('.scene-crater');
  f.setEvents([...events, { id: 'restore-building', type: 'restore', featureIds: ['building'] }]); f.renderer.render();
  assert.equal(f.ruin('building'), null);
  assert.equal(f.original('building').classList.contains('scene-destroyed'), false);
  assert.equal(f.ruin('wall'), wallRuin);
  assert.equal(f.svg.querySelector('.scene-crater'), crater);
  f.setEvents([...events, { id: 'restore-building', type: 'restore', featureIds: ['building'] }, damage('normal-again', { objectIds: ['building'] })]);
  f.renderer.render();
  assert.deepEqual(f.ruin('building').querySelectorAll('image').map((image) => image.getAttribute('href')), ['normal.webp']);
});

test('severe ground crater overlays share one map-aligned union texture and do not darken repeated intersections', (t) => {
  const f = fixture(t, [], { ruins: { terrain: { normal: 'terrain.webp', severe: 'crater.webp' } } });
  f.setEvents([damage('first-crater', { craterPolygon: ring(20, 20, 100, 100) }), damage('second-crater', { craterPolygon: ring(60, 60, 100, 100) })]);
  f.renderer.render();
  assert.equal(f.svg.querySelectorAll('.scene-crater').length, 1);
  assert.equal(f.svg.querySelector('.scene-crater').querySelectorAll('image').length, 1);
  assert.equal(f.svg.querySelector('.scene-crater').querySelector('image').getAttribute('href'), 'crater.webp');
  assert.equal(f.svg.querySelector('#scene-craters-mask').querySelectorAll('path').length, 2);
});

test('courtyard holes and disconnected pieces use even-odd clipping on the original outline', (t) => {
  const source = feature('court', 'building', { type: 'multipolygon', coordinates: [[ring(), ring(20, 20, 60, 60)], [ring(200, 0, 20, 20)]] });
  const f = fixture(t, [source]);
  f.setEvents([damage('whole', { objectIds: ['court'] })]); f.renderer.render();
  const paths = f.svg.querySelector('#scene-ruin-0-outline').querySelectorAll('path');
  assert.equal(paths.length, 2);
  assert.ok(paths.every((path) => path.getAttribute('clip-rule') === 'evenodd'));
  assert.equal(paths[0].getAttribute('d').split(' Z').length - 1, 2);
});

test('unchanged renders and unrelated destruction preserve existing DOM nodes and mask counts', (t) => {
  const f = fixture(t, [feature(), feature('wall', 'wall')]);
  const events = [damage('building-hit', { clipHits: [{ featureId: 'building', polygon: ring(0, 0, 20, 20) }] })];
  f.setEvents(events); f.renderer.render();
  const ruin = f.ruin('building');
  for (let index = 0; index < 20; index++) { f.setEvents([...events]); f.renderer.render(); }
  assert.equal(f.ruin('building'), ruin);
  assert.equal(f.renderer.getDiagnostics().maskBuilds, 1);
  f.setEvents([...events, damage('wall-hit', { objectIds: ['wall'] })]); f.renderer.render();
  assert.equal(f.ruin('building'), ruin);
  assert.equal(f.renderer.getDiagnostics().maskBuilds, 2);
  assert.ok(f.renderer.getDiagnostics().reusedObjects > 0);
});

test('whole destruction and restore reuse detached display nodes without retaining an active decal or tag', t => {
  const source = feature(), f = fixture(t), history = [], original = structuredClone(source);
  let first;
  for (let index = 0; index < 12; index++) {
    history.push(damage(`whole-${index}`, { objectIds: ['building'] }));
    f.setEvents([...history]); f.renderer.render();
    first ||= f.ruin('building');
    assert.equal(f.ruin('building'), first);
    assert.equal(f.original('building').classList.contains('scene-destroyed'), true);
    history.push({ id: `restore-${index}`, type: 'restore', featureIds: ['building'] });
    f.setEvents([...history]); f.renderer.render();
    assert.equal(f.ruin('building'), null);
    assert.equal(f.original('building').classList.contains('scene-destroyed'), false);
    assert.equal(f.original('building').getAttribute('mask'), null);
    assert.equal(f.renderer.getDiagnostics().inactiveRuins, 1);
    assert.ok(f.renderer.getDiagnostics().largestRuinVersions <= 2);
  }
  assert.equal(f.renderer.getDiagnostics().maskBuilds, 1);
  assert.deepEqual(source, original);
  f.renderer.reset();
  assert.equal(f.renderer.getDiagnostics().inactiveRuins, 0);
});

test('cached partial versions restore their exact mask and image while new history IDs alone do not rebuild pixels', t => {
  const f = fixture(t);
  const clipped = (id, x) => damage(id, { clipHits: [{ featureId: 'building', polygon: ring(x, 0, 20, 20) }] });
  f.setEvents([clipped('a', 0)]); f.renderer.render();
  const a = f.ruin('building'), originalMask = f.svg.querySelector('#scene-ruin-0-original');
  f.setEvents([clipped('same-pixels-new-id', 0)]); f.renderer.render();
  assert.equal(f.ruin('building'), a);
  f.setEvents([clipped('b', 50)]); f.renderer.render();
  const b = f.ruin('building'); assert.notEqual(b, a);
  f.setEvents([clipped('a-again', 0)]); f.renderer.render();
  assert.equal(f.ruin('building'), a);
  assert.equal(f.svg.querySelector('#scene-ruin-0-original'), originalMask);
  assert.equal(f.original('building').getAttribute('mask'), 'url(#scene-ruin-0-original)');
  assert.equal(f.renderer.getDiagnostics().maskBuilds, 2);
  assert.equal(f.renderer.getDiagnostics().largestRuinVersions, 2);
});

test('failed cached images are recreated after restore so an asset can become available', t => {
  const f = fixture(t, [feature()], { ruins: { 'test-style': { normal: 'temporarily-missing.webp' } } });
  f.setEvents([damage('whole', { objectIds: ['building'] })]); f.renderer.render();
  const first = f.ruin('building'); first.querySelector('image').dispatchEvent({ type: 'error' });
  f.setEvents([{ id: 'restored', type: 'restore', featureIds: ['building'] }]); f.renderer.render();
  f.setEvents([damage('whole-again', { objectIds: ['building'] })]); f.renderer.render();
  assert.notEqual(f.ruin('building'), first);
  assert.equal(f.ruin('building').querySelector('svg').getAttribute('visibility'), null);
});

test('inactive display cache is bounded at 512 objects and reset releases every detached version', t => {
  const features = Array.from({ length: 514 }, (_, index) => feature(`building-${index}`));
  const f = fixture(t, features), ids = features.map(value => value.id);
  f.setEvents([damage('all', { objectIds: ids })]); f.renderer.render();
  f.setEvents([{ id: 'restore-all', type: 'restore', featureIds: ids }]); f.renderer.render();
  const stats = f.renderer.getDiagnostics();
  assert.equal(stats.inactiveRuinsLimit, 512);
  assert.equal(stats.inactiveRuins, 512);
  assert.equal(stats.ruinObjects, 0);
  assert.equal(f.svg.querySelectorAll('[data-ruin-for]').length, 0);
  f.renderer.reset();
  assert.equal(f.renderer.getDiagnostics().inactiveRuins, 0);
  assert.equal(f.renderer.getDiagnostics().largestRuinVersions, 0);
});

test('missing images expose a static fallback, and replacing the resource table refreshes affected decals', (t) => {
  const f = fixture(t, [feature()], { ruins: { 'test-style': { normal: 'missing.webp' } } });
  f.setEvents([damage('whole', { objectIds: ['building'] })]); f.renderer.render();
  const ruin = f.ruin('building'), image = ruin.querySelector('image'), imageViewport = ruin.querySelector('svg');
  image.dispatchEvent({ type: 'error' });
  assert.equal(imageViewport.getAttribute('visibility'), 'hidden');
  assert.equal(ruin.querySelector('rect').getAttribute('fill'), 'url(#scene-ruin-texture)');
  f.mapPackage.artAssets = { ruins: { 'test-style': { normal: 'replacement.webp' } } };
  f.renderer.render();
  assert.equal(f.ruin('building').querySelector('image').getAttribute('href'), 'replacement.webp');
});

test('reset and dispose clear all original masks, hidden labels, previews and derived node caches', (t) => {
  const f = fixture(t, [feature(), feature('wall', 'wall')]);
  const events = [damage('whole', { objectIds: ['building'], clipHits: [{ featureId: 'wall', polygon: ring(0, 0, 20, 20) }] })];
  f.setEvents(events); f.setPreview({ featureIds: ['wall'] }); f.renderer.render();
  f.renderer.reset();
  assert.equal(f.svg.querySelectorAll('.scene-ruin').length, 0);
  assert.equal(f.original('wall').getAttribute('mask'), null);
  assert.equal(f.original('wall').classList.contains('preview-hit'), false);
  assert.equal(f.original('building').classList.contains('scene-destroyed'), false);
  assert.equal(f.svg.querySelector('[data-label-for="building"]').classList.contains('scene-label-destroyed'), false);
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 0);
  assert.equal(f.renderer.getDiagnostics().cachedFeatureGeometry, 0);
  assert.equal(f.renderer.getDiagnostics().cachedNodes, 0);
  f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 2);
  f.renderer.dispose(); f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 0);
});

test('legacy severe texture stays visibly distinct and renderer diagnostics expose bounded caches and elapsed time', (t) => {
  const atlas = { url: 'atlas.webp', width: 1536, height: 1024, columns: 3, rows: 2 };
  const f = fixture(t, [feature()], { rubbleAtlas: atlas });
  f.setEvents([damage('severe', { objectIds: ['building'], areaSnapshot: { severeDamage: true } })]);
  f.renderer.render();
  const images = f.ruin('building').querySelectorAll('image');
  assert.equal(images.length, 1);
  assert.equal(images[0].getAttribute('opacity'), '.66');
  const stats = f.renderer.getDiagnostics();
  assert.equal(stats.cachedFeatureGeometry, 1);
  assert.equal(stats.cachedNodes, 1);
  assert.equal(stats.ruinObjectsLimit, 1);
  assert.equal(stats.craterObjectsLimit, 1);
  assert.ok(stats.lastRenderMs >= 0 && stats.maxRenderMs >= stats.lastRenderMs);
});

test('floods retain inlet geometry, animation polygon nodes and remain independent of the ruins cache', (t) => {
  const f = fixture(t, []);
  f.mapPackage.liquidBodies = [{ id: 'river', polygon: ring(0, 0, 100, 100) }];
  f.mapPackage.floodRules = { maxInflowGapMeters: 12, inletWidthMeters: 6, propagationGapMeters: 1 };
  f.setEvents([]); f.renderer.render();
  const near = damage('near-bank', { craterPolygon: ring(105, 20, 10, 20) });
  f.setEvents([near]); f.renderer.render();
  const inlet = f.svg.querySelector('.scene-flood-inlet');
  assert.ok(inlet);
  assert.ok(inlet.classList.contains('scene-flood-new'));
  assert.equal(inlet.querySelectorAll('polygon').length, 1);
  assert.equal(inlet.querySelector('.scene-flood-flow-line').getAttribute('pathLength'), '1');
  assert.equal(f.svg.querySelector('#layer-flood').querySelectorAll('.scene-crater').length, 0);
  f.setEvents([near, damage('unrelated')]); f.renderer.render();
  assert.equal(f.svg.querySelector('.scene-flood-inlet'), inlet);
  f.setEvents([near, { id: 'scene-reset', type: 'reset' }]); f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().floodObjects, 0);
  assert.equal(f.svg.querySelectorAll('.scene-flood').length, 0);
});

test('asset resolution keeps legacy building atlases and supports explicit style/category bindings', () => {
  const atlas = { url: 'atlas.webp', width: 1536, height: 1024, columns: 3, rows: 2 };
  assert.equal(resolveRuinsResource(feature(), { rubbleAtlas: atlas }), atlas);
  assert.equal(resolveRuinsResource(feature('wall', 'wall'), { rubbleAtlas: atlas }), null);
  assert.deepEqual(resolveRuinsResource(feature('wall', 'wall'), { ruins: { wall: { normal: 'wall.webp' } } }), { url: 'wall.webp' });
  const source = feature();
  const resource = { ...atlas, column: 2, row: 1, align: { offsetX: -10, offsetY: 20, scaleX: 1.2, scaleY: 2 } };
  const layout = ruinsImageLayout(source, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, resource);
  assert.equal(layout.viewBox, '1024 512 512 512');
  assert.deepEqual([layout.x, layout.y, layout.width, layout.height], [-10, 20, 120, 100]);
  assert.deepEqual(ruinsImageLayout(source, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, atlas), ruinsImageLayout(source, { minX: 0, minY: 0, maxX: 100, maxY: 50 }, atlas));
});
