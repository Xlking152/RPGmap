import test from 'node:test';
import assert from 'node:assert/strict';

import {
  featureControlAction,
  featureControlDescriptor,
  featureControlTitle,
} from '../src/interaction/control-model.js';
import {
  LANZHOU_OPENABLE_FEATURE_IDS,
  applyLanzhouCapabilities,
} from '../reference/maps/lanzhou/capabilities.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

test('openable Features receive a compact default map toggle without category rules', () => {
  const feature = {
    id: 'portal-a',
    name: 'Portal A',
    category: 'mechanism',
    center: [50, 60],
    capabilities: {
      openable: true,
      actions: { open: true, close: true },
    },
  };
  assert.deepEqual(featureControlDescriptor(feature), {
    type: 'toggle',
    anchor: [50, 60],
    style: 'door',
    label: 'Portal A',
    size: 24,
  });
});

test('MapPackage presentation can move, resize, style or suppress a Feature control', () => {
  const base = {
    id: 'mechanism-a',
    center: [10, 20],
    capabilities: { openable: true },
  };
  const customized = featureControlDescriptor({
    ...base,
    presentation: {
      control: { type: 'toggle', anchor: [80, 90], style: 'lever', label: '机关', size: 34 },
    },
  });
  assert.deepEqual(customized, {
    type: 'toggle',
    anchor: [80, 90],
    style: 'lever',
    label: '机关',
    size: 34,
  });
  assert.equal(featureControlDescriptor({ ...base, presentation: { control: false } }), null);
});

test('Feature control action is derived only from generic Feature State', () => {
  assert.equal(featureControlAction({ open: false, destroyed: false }), 'open');
  assert.equal(featureControlAction({ open: true, destroyed: false }), 'close');
  assert.equal(featureControlAction({ open: true, destroyed: true }), null);
  assert.equal(featureControlTitle({ name: '北门' }, { open: false, destroyed: false }), '北门 · 已关闭 · 点击打开');
  assert.equal(featureControlTitle({ name: '北门' }, { open: true, destroyed: false }), '北门 · 已打开 · 点击关闭');
});

test('Minimal Reference door and Lanzhou openable Features all expose generic controls', () => {
  const minimal = createMinimalReferencePackage();
  const demoDoor = minimal.features.find((feature) => feature.id === 'demo-door');
  assert.ok(featureControlDescriptor(demoDoor));

  const source = createLanzhouMapPackage();
  const features = applyLanzhouCapabilities(source.features, source.navigation);
  for (const featureId of LANZHOU_OPENABLE_FEATURE_IDS) {
    const feature = features.find((item) => item.id === featureId);
    assert.ok(feature, `missing Lanzhou openable Feature ${featureId}`);
    assert.ok(featureControlDescriptor(feature), `missing generic map control for ${featureId}`);
  }
});
