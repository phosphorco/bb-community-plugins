import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('pending resolve fairness through registered gallery/suppliers and actual SQLite', { timeout: 60000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync('node', ['--experimental-transform-types', '--test-reporter=tap', '--test', fileURLToPath(new URL('./resolve-fairness.sqlite.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 45000, maxBuffer: 4194304, env });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.ifError(result.error); assert.equal(result.status, 0); assert.match(result.stdout, /# fail 0\b/);
});
