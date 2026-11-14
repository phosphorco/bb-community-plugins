import { test, expect } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('all emitted public entries and declarations exist, kit uses sibling public modules', () => {
 const manifest = JSON.parse(read('package.json'));
 expect(manifest.name).toBe('@phosphorco/bb-thread-attachments'); expect(manifest.version).toBe('0.1.1');
 for (const entry of Object.values(manifest.exports)) { expect(read(entry.import).length).toBeGreaterThan(0); expect(read(entry.types).length).toBeGreaterThan(0); }
 expect(read('dist/testing.js')).toContain('"./bb.js"');
 expect(read('dist/testing.js')).toContain('"./index.js"');
 for (const path of ['src/index.ts', 'dist/index.js', 'dist/bb.js']) {
  expect(read(path)).not.toMatch(/(?:from\s*|import\s*\()["'](?:react|@get-bb\/plugin-sdk)/);
 }
});

test('root and bb import under Node with Zod alone and no SDK or React installed', () => {
 const scratch = mkdtempSync(join(tmpdir(), 'attachments-no-peers-'));
 try {
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(scratch, 'node_modules'));
  const zodPath = dirname(fileURLToPath(import.meta.resolve('zod/package.json')));
  symlinkSync(zodPath, join(scratch, 'node_modules/zod'));
  writeFileSync(join(scratch, 'index.js'), read('dist/index.js'));
  writeFileSync(join(scratch, 'bb.js'), read('dist/bb.js'));
  const result = spawnSync('node', ['--input-type=module', '-e', "await import('./index.js');await import('./bb.js');console.log('imports-ok')"], { cwd: scratch, encoding: 'utf8' });
  expect(result.stderr).toBe(''); expect(result.status).toBe(0); expect(result.stdout).toContain('imports-ok');
 } finally { rmSync(scratch, { recursive: true, force: true }); }
});
