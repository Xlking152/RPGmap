import test from 'node:test';
import assert from 'node:assert/strict';

import {
  boxesOverlap,
  chooseLabelPlacement,
  zoomTierForScale,
  createMapPresentation,
} from '../src/render/map-presentation.js';

test('zoom presentation uses stable overview, mid and detail thresholds', () => {
  assert.equal(zoomTierForScale(0.12), 'overview');
  assert.equal(zoomTierForScale(0.24), 'overview');
  assert.equal(zoomTierForScale(0.25), 'mid');
  assert.equal(zoomTierForScale(0.52), 'mid');
  assert.equal(zoomTierForScale(0.53), 'detail');
});

function layoutFixture(nested = false) {
  const reads = new Map(), events = [];
  function node(id, dataset, box, classes = []) {
    const names = new Set(classes), attributes = new Map([['transform', 'scale(1)']]);
    return { id, dataset, contains: other => nested && id === 'obstacle' && other.id === 'first',
      classList: { contains: name => names.has(name), add: (...values) => values.forEach(name => names.add(name)),
        remove: (...values) => values.forEach(name => names.delete(name)), toggle(name, on) { on ? names.add(name) : names.delete(name); } },
      getAttribute: name => attributes.get(name),
      setAttribute(name, value) { attributes.set(name, value); events.push(`write:${id}`); },
      removeAttribute(name) { attributes.delete(name); events.push(`write:${id}`); },
      getBoundingClientRect() { reads.set(id, (reads.get(id) || 0) + 1); events.push(`read:${id}`); return box; } };
  }
  const box = { left: 100, right: 150, top: 100, bottom: 120 };
  const first = node('first', { labelFor: 'own', labelPriority: '80', labelCandidates: '0,0|80,0' }, box);
  const second = node('second', { labelAnchor: 'own', labelPriority: '70', labelCandidates: '0,0|80,0' }, box);
  const hidden = node('hidden', { labelPriority: '90' }, box, ['scene-label-destroyed']);
  const obstacle = node('obstacle', { featureId: 'other' }, { left: 300, right: 350, top: 300, bottom: 350 });
  const own = node('own', { featureId: 'own' }, box);
  const destroyed = node('destroyed', { featureId: 'destroyed' }, box, ['scene-destroyed']);
  const baseSvg = { dataset: {}, querySelectorAll: selector => selector === '[data-map-label]'
    ? [second, hidden, first] : [obstacle, own, destroyed],
    getBoundingClientRect: () => ({ width: 600, height: 400 }) };
  const map = { getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, right: 600, top: 0, bottom: 400 }) }) };
  const presentation = createMapPresentation({ map, baseSvg, mapPackage: { width: 1000 } });
  events.length = 0;
  return { first, second, reads, events, presentation };
}

test('independent SVG labels retain priority, anchoring and placement with one obstacle measurement per refresh', () => {
  const { first, second, reads, events, presentation } = layoutFixture();
  presentation.refresh();
  assert.equal(first.getAttribute('transform'), 'translate(0.00 0.00) scale(1)');
  assert.equal(second.getAttribute('transform'), 'translate(133.33 0.00) scale(1)');
  assert.equal(reads.get('obstacle'), 1); assert.equal(reads.get('own'), 1);
  assert.equal(reads.get('hidden'), undefined); assert.equal(reads.get('destroyed'), undefined);
  const lastRead = events.findLastIndex(event => event.startsWith('read:'));
  assert.deepEqual(events.slice(lastRead + 1), ['write:first', 'write:second']);
  presentation.refresh(); assert.equal(reads.get('obstacle'), 2);
  assert.equal(second.getAttribute('transform'), 'translate(133.33 0.00) scale(1)');
});

test('nested SVG labels or obstacles keep sequential geometry measurements', () => {
  const { reads, presentation } = layoutFixture(true); presentation.refresh();
  assert.equal(reads.get('obstacle'), 2);
  assert.equal(reads.get('own'), undefined, 'own obstacle remains excluded before measurement');
});

test('label placement selects the first collision-free candidate', () => {
  const placement = chooseLabelPlacement({
    box: { left: 10, right: 40, top: 10, bottom: 30 },
    candidates: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 }],
    occupied: [{ left: 5, right: 45, top: 5, bottom: 35 }],
    viewport: { left: 0, right: 120, top: 0, bottom: 100 },
    padding: 2,
  });

  assert.deepEqual(placement.offset, { x: 40, y: 0 });
  assert.equal(placement.score, 0);
});

test('label overlap treats configured padding as protected breathing room', () => {
  const left = { left: 0, right: 20, top: 0, bottom: 20 };
  const nearby = { left: 23, right: 40, top: 0, bottom: 20 };
  assert.equal(boxesOverlap(left, nearby, 0), false);
  assert.equal(boxesOverlap(left, nearby, 4), true);
});

test('label placement reports unavoidable viewport overflow separately from collisions', () => {
  const placement = chooseLabelPlacement({
    box: { left: -30, right: 20, top: 10, bottom: 30 },
    candidates: [{ x: 0, y: 0 }, { x: 5, y: 0 }],
    viewport: { left: 0, right: 100, top: 0, bottom: 100 },
    padding: 4,
  });

  assert.ok(placement.overflow > 0);
  assert.equal(placement.collisions, 0);
});
