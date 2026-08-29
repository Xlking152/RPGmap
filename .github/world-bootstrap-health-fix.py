from pathlib import Path

path = Path('src/rulesets/infinite-horror/actor.js')
source = path.read_text()
old = '        legacyMaxOverride: legacyHpMaxOverride,\n'
new = '        legacyMaxOverride: hasHealthRuntime ? null : legacyHpMaxOverride,\n'
if old not in source:
    raise RuntimeError('Pattern not found: Health legacy max fallback')
path.write_text(source.replace(old, new, 1))
