import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('production gallery and image factories compose through actual SDK RPC and SQLite', { timeout: 60000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync('node', ['--experimental-transform-types', '--test-reporter=tap', '--test', fileURLToPath(new URL('./consume.sqlite.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2097152, env });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.ifError(result.error); assert.equal(result.status, 0);
  assert.match(result.stdout, /# tests 15\b/); assert.match(result.stdout, /# fail 0\b/);
});
