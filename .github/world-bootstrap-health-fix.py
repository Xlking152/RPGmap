from pathlib import Path

# Preserve Health Runtime authority over stale resources.hp migration mirrors.
path = Path('src/rulesets/infinite-horror/actor.js')
source = path.read_text()
old = '        legacyMaxOverride: legacyHpMaxOverride,\n'
new = '        legacyMaxOverride: hasHealthRuntime ? null : legacyHpMaxOverride,\n'
if old not in source:
    raise RuntimeError('Pattern not found: Health legacy max fallback')
path.write_text(source.replace(old, new, 1))

# The application entry is now registry-driven. The old test explicitly required
# createDefaultMapPackage(), which is the dependency this refactor retires.
test_path = Path('tests/map-package-framework.test.js')
test_source = test_path.read_text()
old_test = """test('application entry depends on Default MapPackage, not Lanzhou implementation details', async () => {
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const compatibilityShim = await readFile(new URL('../src/maps/lanzhou.js', import.meta.url), 'utf8');

  assert.match(mainSource, /createDefaultMapPackage/);
  assert.doesNotMatch(mainSource, /Lanzhou|lanzhou|assets\\/generated/);
  assert.match(compatibilityShim, /reference\\/maps\\/lanzhou\\/package\\.js/);
});"""
new_test = """test('application entry resolves MapPackages through the registry without implementation coupling', async () => {
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const compatibilityShim = await readFile(new URL('../src/maps/lanzhou.js', import.meta.url), 'utf8');

  assert.match(mainSource, /registerBuiltInMapPackages/);
  assert.match(mainSource, /mapPackageRegistry\\.load/);
  assert.doesNotMatch(mainSource, /createDefaultMapPackage/);
  assert.doesNotMatch(mainSource, /Lanzhou|lanzhou|assets\\/generated/);
  assert.match(compatibilityShim, /reference\\/maps\\/lanzhou\\/package\\.js/);
});"""
if old_test not in test_source:
    raise RuntimeError('Pattern not found: legacy Default MapPackage entry test')
test_path.write_text(test_source.replace(old_test, new_test, 1))

# Registry behavior is pure Node logic; use the asset-free minimal package.
registry_test = Path('tests/map-package-registry.test.js')
registry_source = registry_test.read_text()
registry_source = registry_source.replace(
    "import { createDefaultMapPackage } from '../src/map-package/default-map.js';",
    "import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';",
    1,
)
registry_source = registry_source.replace('createDefaultMapPackage()', 'createMinimalReferencePackage()')
registry_test.write_text(registry_source)

# LAN health/bootstrap metadata now contains enough identity to choose World,
# Ruleset, Active Scene and MapPackage before Runtime creation.
mp_test = Path('tests/multiplayer-server.test.js')
mp_source = mp_test.read_text()
mp_source = mp_source.replace(
"""    assert.deepEqual(empty.world, {
      initialized: false, kind: 'empty', schemaVersion: null, ruleset: null,
    });""",
"""    assert.deepEqual(empty.world, {
      initialized: false,
      kind: 'empty',
      schemaVersion: null,
      worldId: 'default',
      name: null,
      activeSceneId: null,
      mapPackage: null,
      ruleset: null,
    });""",
1)
mp_source = mp_source.replace(
"""    assert.deepEqual(health.world, {
      initialized: true,
      kind: 'world-v2',
      schemaVersion: 2,
      ruleset: { id: 'infinite-horror', version: '1.0.0' },
    });""",
"""    assert.deepEqual(health.world, {
      initialized: true,
      kind: 'world-v2',
      schemaVersion: 2,
      worldId: 'world-test',
      name: 'Test World',
      activeSceneId: 'scene-test',
      mapPackage: { id: 'test', version: '1' },
      ruleset: { id: 'infinite-horror', version: '1.0.0' },
    });""",
1)
mp_source = mp_source.replace(
"""    assert.deepEqual(health.world, {
      initialized: true, kind: 'legacy', schemaVersion: null, ruleset: null,
    });""",
"""    assert.deepEqual(health.world, {
      initialized: true,
      kind: 'legacy',
      schemaVersion: null,
      worldId: 'default',
      name: null,
      activeSceneId: null,
      mapPackage: null,
      ruleset: null,
    });""",
1)
mp_test.write_text(mp_source)

# Keep the default built-in MapPackage out of the startup module graph. The
# Registry publishes the ID/title immediately and imports the actual package only
# when the Active Scene asks Registry.load() for it.
Path('src/map-package/constants.js').write_text(
    "export const DEFAULT_REFERENCE_MAP_ID = 'northern-song-lanzhou-1104';\n"
)

default_map = Path('src/map-package/default-map.js')
default_source = default_map.read_text()
default_source = default_source.replace(
    "import { prepareMapPackage } from './contract.js';\n\nexport const DEFAULT_REFERENCE_MAP_ID = 'northern-song-lanzhou-1104';\n",
    "import { prepareMapPackage } from './contract.js';\n",
    1,
)
default_map.write_text(default_source)

Path('src/map-package/builtins.js').write_text("""import { DEFAULT_REFERENCE_MAP_ID } from './constants.js';
import { mapPackageRegistry } from './registry.js';

export function registerBuiltInMapPackages(registry = mapPackageRegistry) {
  if (!registry.has(DEFAULT_REFERENCE_MAP_ID)) {
    registry.registerLoader({
      id: DEFAULT_REFERENCE_MAP_ID,
      title: '北宋兰州 Reference Map',
      source: 'reference/maps/lanzhou',
      load: async () => {
        const { createDefaultMapPackage } = await import('./default-map.js');
        return createDefaultMapPackage();
      },
    });
  }
  return registry;
}
""")

index_path = Path('src/map-package/index.js')
index_source = index_path.read_text()
if "export * from './constants.js';" not in index_source:
    index_source = "export * from './constants.js';\n" + index_source
index_path.write_text(index_source)

# builtins.js is a deliberate adapter and is allowed to reference the built-in
# Lanzhou package alongside the compatibility/default adapters.
source_sep = Path('tests/source-separation.test.js')
source_text = source_sep.read_text()
source_text = source_text.replace(
"""  // - default-map.js bundles the selected built-in map at build time;
  // - the two src/maps files are legacy import shims kept for old callers/tests.""",
"""  // - builtins.js lazily registers the selected built-in map;
  // - default-map.js adapts the Lanzhou reference package to the generic contract;
  // - the two src/maps files are legacy import shims kept for old callers/tests.""",
1)
source_text = source_text.replace(
"""  const allowed = new Set([
    'map-package/default-map.js',""",
"""  const allowed = new Set([
    'map-package/builtins.js',
    'map-package/default-map.js',""",
1)
source_sep.write_text(source_text)

# UI architecture tests follow the World-first bootstrap and verify that the
# heavy built-in map is still dynamically split, now from the Registry loader.
ui_test = Path('tests/ui-shell.test.js')
ui_source = ui_test.read_text()
ui_source = ui_source.replace(
    "const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');\n",
    "const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');\nconst builtinsSource = readFileSync(new URL('../src/map-package/builtins.js', import.meta.url), 'utf8');\n",
    1,
)
ui_source = ui_source.replace(
    "assert.match(mainSource, /createWorldSystem\\(\\)/);",
    "assert.match(mainSource, /createWorldSystem\\(\\{ worldId, worldName \\}\\)/);\n  assert.match(mainSource, /createSceneManagerSystem\\(/);",
    1,
)
ui_source = ui_source.replace(
"""test('production entry splits the map and large vendors without suppressing chunk warnings', () => {
  assert.match(mainSource, /await import\\('\\.\\/map-package\\/default-map\\.js'\\)/);""",
"""test('production registry splits the built-in map and large vendors without suppressing chunk warnings', () => {
  assert.match(mainSource, /registerBuiltInMapPackages/);
  assert.match(mainSource, /mapPackageRegistry\\.load/);
  assert.match(builtinsSource, /await import\\('\\.\\/default-map\\.js'\\)/);""",
1)
ui_test.write_text(ui_source)

# World-id persistence is storage logic, not an asset-pipeline test.
world_id = Path('tests/world-id-persistence.test.js')
world_id_source = world_id.read_text()
world_id_source = world_id_source.replace(
    "import { createDefaultMapPackage } from '../src/map-package/default-map.js';",
    "import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';",
    1,
)
world_id_source = world_id_source.replace(
    'const mapPackage = createDefaultMapPackage();',
    'const mapPackage = createMinimalReferencePackage();',
    1,
)
world_id.write_text(world_id_source)
