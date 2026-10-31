import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('production React gallery/panel lifetimes through selected public SDK harness', { timeout: 30000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', fileURLToPath(new URL('./gallery-frontend.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 2097152, env });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  assert.ifError(result.error); assert.equal(result.status, 0);
});
