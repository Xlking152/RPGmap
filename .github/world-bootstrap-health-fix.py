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
