import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/engine/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const appShellSource = readFileSync(new URL('../src/ui/app-shell.js', import.meta.url), 'utf8');
const entityUiSource = readFileSync(new URL('../src/entities/ui.js', import.meta.url), 'utf8');
const sceneRenderer = readFileSync(new URL('../src/render/scene-renderer.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('topbar uses scoped Lucide icons instead of emoji glyphs', () => {
  const shell = appSource.match(/function shellMarkup\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  const iconNames = [
    'landmark',
    'hand',
    'map-pin',
    'scan',
    'mouse-pointer-2',
    'user-round',
    'ruler',
    'route',
    'bomb',
    'trash-2',
    'locate-fixed',
    'rotate-ccw',
    'download',
    'upload'
  ];

  for (const name of iconNames) {
    assert.match(shell, new RegExp(`data-lucide="${name}"`));
  }
  assert.doesNotMatch(shell, /[✋📍📏🧭💥🧹🏯]/u);
  assert.match(appSource, /createIcons\(\{[\s\S]*?root: container,/);
  assert.equal(packageJson.dependencies.lucide, '1.30.0');
  assert.match(shell, /data-tool="inspect"/);
  assert.match(shell, /data-panel="inspect"/);
  assert.match(shell, /data-tool="character-move"/);
  assert.match(shell, /data-panel="characters"/);
  assert.match(appSource, /function planCharacterMove\(/);
  assert.match(appSource, /function enterBuilding\(/);
  assert.match(appSource, /function processAvatarFile\(/);
});

test('application chrome keeps the restrained neutral, river and brick palette', () => {
  assert.match(styles, /--accent: #963f2f;/);
  assert.match(styles, /--accent-2: #397783;/);
  assert.match(styles, /\.section \{[\s\S]*?border-bottom: 1px solid var\(--line\);/);
  assert.doesNotMatch(styles, /linear-gradient/i);
  assert.match(styles, /\.rpg-character-core/);
  assert.match(styles, /\.character-portrait/);
});

test('closed topbar portal menus cannot remain visible above the map', () => {
  assert.match(appShellSource, /\.ui-menu-popover\[hidden\]\s*\{\s*display:none !important;/);
});

test('modern sidebar synchronizes real panels and cannot revive the retired marker editor', () => {
  assert.match(appSource, /activeTab: 'characters'/);
  assert.match(appSource, /setActivePanel,/);
  assert.match(appSource, /function setActivePanel\(panel\)/);
  assert.match(appSource, /\['characters', 'inspect', 'measure', 'areas', 'layers'\]/);
  assert.match(appSource, /tool === 'marker' \|\| tool === 'marker-select'/);
  assert.match(appShellSource, /if \(name === 'characters'\) api\.setTool\('pan'\);/);
  assert.match(appShellSource, /if \(name !== 'current'\) api\.setActivePanel\?\.\(name\);/);
});

test('Token placement owns the map click instead of chaining through the legacy character tool', () => {
  assert.match(appSource, /setTool,\s*\n\s*setActivePanel,\s*\n\s*placeCharacter,/);
  assert.match(entityUiSource, /api\.placeCharacter\?\.\(point, \{ suppressEditor: true \}\)/);
  assert.match(entityUiSource, /mapElement\.addEventListener\('click', placePendingTokenAtMapClick, true\)/);
  assert.doesNotMatch(entityUiSource, /api\.setTool\('character-place'\)/);
});

test('destruction rendering separates buildings, pontoon bridges and wall breaches', () => {
  assert.match(sceneRenderer, /function appendBuildingDebris\(/);
  assert.match(sceneRenderer, /function appendBridgeRuin\(/);
  assert.match(sceneRenderer, /function appendWallBreach\(/);
  assert.match(sceneRenderer, /irregularDamagePolygon\(/);
  assert.match(sceneRenderer, /data-irregular-damage/);
  assert.match(styles, /\.scene-fallen-timber/);
  assert.match(styles, /\.scene-bridge-stub/);
  assert.match(styles, /\.scene-wall-breach/);
  assert.match(styles, /\.scene-local-timber/);
});
