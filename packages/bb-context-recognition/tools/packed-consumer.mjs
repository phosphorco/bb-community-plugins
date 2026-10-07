// Requires a coordinated check window: installs only into disposable scratch.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'bb-context-recognition-packed-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, npm_config_cache: join(scratch, 'npm-cache') } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageRoot))[0];
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'packed-recognition-consumer', version: '1.0.0', private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(scratch, packed.filename), '@get-bb/plugin-sdk@0.5.29', 'better-sqlite3@12.10.0', 'cron-parser@5.5.0', 'hono@4.11.9'], consumer);
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import * as root from '@phosphorco/bb-context-recognition';
import * as bb from '@phosphorco/bb-context-recognition/bb';
import * as kit from '@phosphorco/bb-context-recognition/testing';
assert.equal(root.METHODS.describe, 'contextRecognitionDescribe');
assert.equal(typeof bb.enumerateRecognitionSuppliers, 'function');
assert.equal(typeof kit.runSupplierConformance, 'function');
const report = await kit.runSupplierConformance({ pluginId: 'packed-supplier', register(host) {
  bb.registerRecognitionSupplier(host, { revision: 'packed/1', linkify: { providers: [{ provider: 'packed', kinds: ['item'] }], handler: () => ({ candidates: [] }) } });
} });
assert.equal(report.passed, true, JSON.stringify(report));
console.log('Packed consumer imports all three entries and runs source conformance; SDK 0.5.29.');
`);
  const output = run(process.execPath, ['probe.mjs'], consumer).trim();
  console.log(JSON.stringify({ proof: 'packed-consumer-source', version: manifest.version, sdk: '0.5.29', entries: ['.', './bb', './testing'], sdkTestingPeers: ['better-sqlite3@12.10.0', 'cron-parser@5.5.0', 'hono@4.11.9'], nativeDatabaseTested: false, output }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
