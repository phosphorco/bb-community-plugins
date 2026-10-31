import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('production supplier composition uses actual SQLite in Node (Bun native addon unsupported)', { timeout: 60_000 }, () => {
  const result = spawnSync('node', ['--experimental-transform-types', '--test-reporter=tap', fileURLToPath(new URL('./supplier.sqlite.mjs', import.meta.url))],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests 7/u); assert.match(result.stdout, /# fail 0/u);
});
