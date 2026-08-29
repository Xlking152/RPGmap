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

# TEMPORARY DIAGNOSTIC ONLY: expose the actual outer-catch exception in test
# mode so a request_failed cannot hide the failing server boundary.
server = Path('deployment/local-server/server.mjs')
server_source = server.read_text()
old_catch = "if (!socket.destroyed) sendSocket(socket, { type: 'error', code: 'request_failed', message: '请求未完成，服务器保持运行。' });"
new_catch = "if (!socket.destroyed) sendSocket(socket, { type: 'error', code: 'request_failed', message: process.env.NODE_ENV === 'test' ? `请求失败：${error?.message || error}` : '请求未完成，服务器保持运行。' });"
if old_catch not in server_source:
    raise RuntimeError('Pattern not found: server request_failed catch')
server.write_text(server_source.replace(old_catch, new_catch, 1))
