import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('actual gallery app/panel/dialog custom presentation integration', { timeout: 45000 }, () => {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', fileURLToPath(new URL('./gallery-custom-integration.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 40000, maxBuffer: 4194304, env });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr); assert.ifError(result.error); assert.equal(result.status, 0);
});
