import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/publish-local-server-release.yml', import.meta.url),
  'utf8',
);

test('release publishing declares the repository without requiring a checkout', () => {
  assert.match(
    workflow,
    /gh release create[\s\S]*?--repo "\$GITHUB_REPOSITORY"[\s\S]*?--target/,
  );
});
