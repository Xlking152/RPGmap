import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeSource = readFileSync(new URL('../src/engine/runtime.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const mapRuntimeSource = readFileSync(new URL('../src/runtime/map-runtime.js', import.meta.url), 'utf8');
const builtinsSource = readFileSync(new URL('../src/map-package/builtins.js', import.meta.url), 'utf8');
const rulesetBuiltinsSource = readFileSync(new URL('../src/ruleset/builtins.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const appShellSource = readFileSync(new URL('../src/ui/app-shell-v2.js', import.meta.url), 'utf8');
const entityUiSource = readFileSync(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');
const actorSheetPartsSource = readFileSync(new URL('../src/entities/sheet/parts.js', import.meta.url), 'utf8');
const tokenControllerSource = readFileSync(new URL('../src/entities/token-controller.js', import.meta.url), 'utf8');
const markerSource = readFileSync(new URL('../src/marker/system.js', import.meta.url), 'utf8');
const sceneRenderer = readFileSync(new URL('../src/render/scene-renderer.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const viteSource = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');

test('application entry boots the Character-free World/Scene Token runtime', () => {
  assert.match(mainSource, /await import\('\.\/runtime\/map-runtime\.js'\)/);
  assert.match(mapRuntimeSource, /createRpgMapRuntime/);
  assert.match(mapRuntimeSource, /createWorldSystem\(\{ worldId, worldName \}\)/);
  assert.match(mapRuntimeSource, /createSceneManagerSystem\(/);
  assert.match(mapRuntimeSource, /createTokenRuntimeSystem\(\)/);
  assert.match(mapRuntimeSource, /createTokenRendererSystem\(\)/);
  assert.match(mapRuntimeSource, /createSceneAreaSystem\(\)/);
  assert.doesNotMatch(`${mainSource}\n${mapRuntimeSource}`, /engine\/app\.js|character-retirement|createCanonicalPanelOwnershipSystem|createCharacterRetirementSystem/);
  assert.doesNotMatch(runtimeSource, /characterPane|selectCharacter|placeCharacter|repositionCharacter|deleteCharacter|character:create|character:move|character:delete/);
});

test('application chrome keeps the restrained neutral, river and brick palette', () => {
  assert.match(styles, /--accent: #963f2f;/);
  assert.match(styles, /--accent-2: #397783;/);
  assert.match(styles, /\.section \{[\s\S]*?border-bottom: 1px solid var\(--line\);/);
  assert.doesNotMatch(styles, /linear-gradient/i);
  assert.equal(packageJson.dependencies.lucide, '1.30.0');
  assert.equal(packageJson.version, '2.3.3');
  assert.match(indexSource, /application-version" content="2\.3\.3"/);
  assert.match(indexSource, /RPGmap 2\.3\.3/);
});

test('production registry splits the built-in map and large vendors without suppressing chunk warnings', () => {
  assert.match(mainSource, /registerBuiltInMapPackages/);
  assert.match(mainSource, /loadBuiltInRulesetReference/);
  assert.match(mainSource, /await import\('\.\/runtime\/map-runtime\.js'\)/);
  assert.match(mapRuntimeSource, /mapPackageRegistry\.load/);
  assert.doesNotMatch(mainSource, /leaflet|styles\.css|createRpgMapRuntime/);
  assert.doesNotMatch(mainSource, /ruleset\/index\.js|rulesets\/infinite-horror/);
  assert.match(rulesetBuiltinsSource, /await import\('\.\/index\.js'\)/);
  assert.match(builtinsSource, /await import\('\.\/default-map\.js'\)/);
  assert.match(viteSource, /manualChunks/);
  assert.match(viteSource, /vendor-leaflet/);
  assert.match(viteSource, /vendor-icons/);
  assert.match(viteSource, /vendor-geometry/);
  assert.doesNotMatch(viteSource, /chunkSizeWarningLimit/);
  assert.match(viteSource, /manifest: true/);
});

test('modern shell owns Actor/current panels and Token-first tools without legacy proxies', () => {
  assert.match(appShellSource, /api\.uiPanels\?\.actors/);
  assert.match(appShellSource, /api\.uiPanels\?\.get\?\.\('current'\)/);
  assert.match(appShellSource, /api\.movementUi\?\.begin\?\.\(token\.id/);
  assert.match(appShellSource, /openTokenElevationEditor\?\.\(token\.id, event\)/);
  assert.doesNotMatch(appShellSource, /legacyAction|legacyProxy|data-panel="characters"|selectCharacter|character:move|character:delete|characterPane/);
});

test('Token placement owns the map click directly through the canonical live Entity controller', () => {
  assert.match(entityUiSource, /mapElement\.addEventListener\('click', tokenController\.handleMapClick, true\)/);
  assert.match(entityUiSource, /tokenController\.beginPlacement\(actorId, \{ actorLink: shared \}\)/);
  assert.match(tokenControllerSource, /createActorTokenAtPoint\(api, actorId, point, pendingPlacementOptions\)/);
  assert.match(entityUiSource, /data-entity-share checked/);
  assert.match(tokenControllerSource, /relocateActorTokenAtPoint\(api, target, point\)/);
  assert.doesNotMatch(entityUiSource, /api\.placeCharacter|placePendingTokenAtMapClick|api\.setTool\('character-place'\)/);
  assert.doesNotMatch(tokenControllerSource, /api\.placeCharacter|api\.repositionCharacter|character:create|character:move|state\.characters/);
});

test('restricted audience records open a dedicated LIMITED summary instead of the full sheet', () => {
  assert.match(entityUiSource, /data-sheet-mode="limited"/);
  assert.match(entityUiSource, /actorSheet\.renderLimited/);
  assert.match(actorSheetPartsSource, /GM 尚未公开更多资料/);
  assert.doesNotMatch(entityUiSource, /无权读取该 Actor 模板卡/);
  assert.doesNotMatch(entityUiSource, /无权读取该 Token 的角色卡/);
  assert.match(entityUiSource, /api\.entities\.openToken\(token\.id\)/);
  assert.match(markerSource, /actor\.audienceRestricted === true \? '公开摘要' : '模板卡'/);
  assert.match(appShellSource, /view\.actor\.audienceRestricted \? '公开摘要' : '角色卡'/);
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
