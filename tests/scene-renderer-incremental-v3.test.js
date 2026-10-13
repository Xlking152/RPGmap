import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneRenderer } from '../src/render/scene-renderer.js';

function documentFixture() {
  const matches = (node, selector) => {
    if (selector.startsWith('#')) return node.getAttribute('id') === selector.slice(1);
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return attribute ? attribute[2] === undefined ? node.attributes.has(attribute[1]) : node.getAttribute(attribute[1]) === attribute[2]
      : node.tagName === selector;
  };
  const document = { root: null, createElementNS(_namespace, tag) {
    const node = { tagName: tag, ownerDocument: document, attributes: new Map(), children: [], parentNode: null, mutations: 0,
      setAttribute(name, value) { this.mutations++; this.attributes.set(name, String(value)); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.mutations++; this.attributes.delete(name); },
      append(...children) { for (const child of children) this.insertBefore(child, null); },
      insertBefore(child, before) { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
        if (index < 0) throw new Error('bad reference'); this.children.splice(index, 0, child); child.parentNode = this; },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); },
      remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } },
      get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; },
      querySelectorAll(selector) { const result = [];
        const visit = child => { if (matches(child, selector)) result.push(child); for (const nested of child.children) visit(nested); };
        for (const child of this.children) visit(child); return result; },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }, addEventListener() {} };
    node.classList = { contains: value => (node.getAttribute('class') || '').split(/\s+/).includes(value),
      add(...values) { node.setAttribute('class', [...new Set([...(node.getAttribute('class') || '').split(/\s+/).filter(Boolean), ...values])].join(' ')); },
      remove(...values) { node.setAttribute('class', (node.getAttribute('class') || '').split(/\s+/).filter(value => value && !values.includes(value)).join(' ')); } };
    return node;
  }, getElementById: id => document.root.querySelector(`#${id}`) };
  return document;
}

function fixture(t, count = 600) {
  const previousCSS = globalThis.CSS;
  globalThis.CSS = { escape: value => String(value) };
  t.after(() => { if (previousCSS === undefined) delete globalThis.CSS; else globalThis.CSS = previousCSS; });
  const document = documentFixture(), svg = document.createElementNS('', 'svg'); document.root = svg;
  const node = (tag, attributes) => { const value = document.createElementNS('', tag);
    for (const [key, item] of Object.entries(attributes)) value.setAttribute(key, item); return value; };
  const structures = node('g', { id: 'layer-destructible' }), labels = node('g', { id: 'layer-labels' });
  svg.append(structures, labels);
  const reads = new Map(), originals = new Map();
  const features = Array.from({ length: count }, (_, index) => {
    const id = `feature-${index}`, original = node('g', { id: `feature-${id}`, 'data-feature-id': id });
    original.mutations = 0; originals.set(id, original); structures.append(original);
    labels.append(node('text', { 'data-label-for': id }));
    return { get id() { reads.set(id, (reads.get(id) || 0) + 1); return id; }, category: 'building', ruinStyle: 'building',
      geometry: { type: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] } };
  });
  let events = [], preview = null;
  const renderer = createSceneRenderer({ baseSvg: svg, mapPackage: { width: 100, height: 100, metersPerUnit: 1, features, liquidBodies: [] },
    getSceneEvents: () => events, getDamagePreview: () => preview });
  reads.clear();
  return { svg, renderer, originals, reads, setEvents: value => { events = value; }, setPreview: value => { preview = value; },
    ruin: id => svg.querySelector(`[data-ruin-for="${id}"]`) };
}
const damage = (id, featureId) => ({ id, type: 'damage', objectIds: [featureId], clipHits: [] });

test('damage on a large map visits damaged features and leaves unrelated SVG nodes untouched', t => {
  const f = fixture(t), event = damage('hit', 'feature-599');
  f.setEvents([event]); f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().lastDamagedFeatureVisits, 1);
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 1);
  assert.equal(f.originals.get('feature-0').mutations, 0);
  // A map without liquids no longer needs an unrelated flood-feature scan.
  assert.equal(f.reads.get('feature-0') || 0, 0);
  assert.equal(f.ruin('feature-599').getAttribute('clip-path'), 'url(#scene-ruin-599-outline)');
  f.reads.clear();
  f.setEvents([event, damage('neighbor', 'feature-598')]); f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().lastDamagedFeatureVisits, 2);
  assert.equal(f.reads.get('feature-0') || 0, 0);
  assert.equal(f.originals.get('feature-0').mutations, 0);
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 2);
});

test('restore, undo and preview preserve original stable mask indices and reuse the same unaffected ruin', t => {
  const f = fixture(t, 8), first = damage('first', 'feature-7'), second = damage('second', 'feature-2');
  f.setEvents([first, second]); f.setPreview({ featureIds: ['feature-0'] }); f.renderer.render();
  const cached = f.ruin('feature-7'), unaffected = f.ruin('feature-2');
  assert.equal(cached.getAttribute('clip-path'), 'url(#scene-ruin-7-outline)');
  assert.equal(unaffected.getAttribute('clip-path'), 'url(#scene-ruin-2-outline)');
  assert.equal(f.originals.get('feature-0').classList.contains('preview-hit'), true);
  const restore = { id: 'restore', type: 'restore', featureIds: ['feature-7'] };
  f.setEvents([first, second, restore]); f.renderer.render();
  assert.equal(f.ruin('feature-7'), null); assert.equal(f.ruin('feature-2'), unaffected);
  assert.equal(f.renderer.getDiagnostics().lastDamagedFeatureVisits, 1);
  f.setEvents([first, second, restore, { id: 'undo', type: 'undo', targetEventId: 'restore' }]); f.renderer.render();
  assert.equal(f.ruin('feature-7'), cached); assert.equal(f.ruin('feature-2'), unaffected);
  assert.equal(f.originals.get('feature-0').classList.contains('preview-hit'), true);
  const maskCount = f.renderer.getDiagnostics().maskBuilds;
  f.renderer.render();
  assert.equal(f.renderer.getDiagnostics().lastDamagedFeatureVisits, 0);
  assert.equal(f.renderer.getDiagnostics().maskBuilds, maskCount);
  f.renderer.dispose();
  assert.equal(f.originals.get('feature-0').classList.contains('preview-hit'), false);
  assert.equal(f.renderer.getDiagnostics().ruinObjects, 0);
});
