import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkArtifacts } from './check-turn-results-artifacts.mjs';

function fixture(app, run) {
  const root = mkdtempSync(join(tmpdir(), 'turn-results-artifact-test-'));
  try {
    mkdirSync(join(root, 'dist'));
    const id = app ? 'turn-results' : 'turn-result-images';
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: `@phosphorco/bb-plugin-${id}`, version: '0.1.0', bb: app ? { app: './app.tsx' } : {} }));
    const meta = { sdkVersion: '0.6.52', builtWith: { pluginSdkVersion: '0.6.52' }, pluginId: id, pluginVersion: '0.1.0', artifactFormatVersion: 1 };
    writeFileSync(join(root, 'dist/server.js'), 'export default () => {};');
    const write = (name, value) => writeFileSync(join(root, `dist/${name}.meta.json`), JSON.stringify(value));
    write('server', meta);
    const generation = 'a'.repeat(32), bytes = Buffer.from('export default {};');
    const artifact = { ...meta, artifactFormatVersion: 2, appArtifact: { generation, files: [{ path: 'app.js', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] } };
    if (app) {
      mkdirSync(join(root, 'dist/.bb-artifacts', generation), { recursive: true });
      writeFileSync(join(root, 'dist/.bb-artifacts', generation, 'app.js'), bytes);
      write('app', artifact);
    }
    run({ root, meta, artifact, write });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('accepts selected server and format-two generated frontend', () => {
  fixture(false, ({ root }) => assert.equal(checkArtifacts(root).id, 'turn-result-images'));
  fixture(true, ({ root }) => assert.equal(checkArtifacts(root).generation, 'a'.repeat(32)));
});
test('rejects the older npm compiler stamp and wrong package identity', () => {
  fixture(false, ({ root, meta, write }) => {
    for (const patch of [{ sdkVersion: '0.6.49' }, { builtWith: { pluginSdkVersion: '0.6.49' } }, { pluginId: 'foreign' }, { pluginVersion: '9.9.9' }]) {
      write('server', { ...meta, ...patch });
      assert.throws(() => checkArtifacts(root), /metadata/);
    }
  });
});
test('rejects older frontend format, invalid generation, digest and byte mismatches', () => {
  fixture(true, ({ root, artifact, write }) => {
    for (const change of [
      { ...artifact, artifactFormatVersion: 1 },
      { ...artifact, appArtifact: { ...artifact.appArtifact, generation: '../foreign' } },
      { ...artifact, appArtifact: { ...artifact.appArtifact, files: [{ ...artifact.appArtifact.files[0], sha256: 'b'.repeat(64) }] } },
      { ...artifact, appArtifact: { ...artifact.appArtifact, files: [{ ...artifact.appArtifact.files[0], bytes: 0 }] } },
    ]) {
      write('app', change);
      assert.throws(() => checkArtifacts(root));
    }
  });
});
test('rejects duplicate, escaped and missing frontend entries', () => {
  fixture(true, ({ root, artifact, write }) => {
    for (const files of [
      [...artifact.appArtifact.files, ...artifact.appArtifact.files],
      [{ ...artifact.appArtifact.files[0], path: '../app.js' }],
      [],
    ]) {
      write('app', { ...artifact, appArtifact: { ...artifact.appArtifact, files } });
      assert.throws(() => checkArtifacts(root));
    }
  });
});

test('both workflows initialize ignored-script leaf Bun and SQLite before declared tests', () => {
  for (const name of ['publish.yml', 'validate-pull-request.yml']) {
    const text = readFileSync(new URL(`../workflows/${name}`, import.meta.url), 'utf8');
    const start = text.indexOf('      - name: Install published Turn Results development inputs\n');
    const end = text.indexOf('      - name: Test\n', start);
    assert.ok(start >= 0 && end > start, name);
    const block = text.slice(start, end);
    const ignored = block.indexOf('--include=dev --ignore-scripts');
    const sqlite = block.indexOf('npm rebuild --prefix plugins/turn-result-images/node_modules/better-sqlite3 --workspaces=false');
    const bun = block.indexOf('npm rebuild --prefix plugins/turn-result-images/node_modules/bun --workspaces=false');
    assert.ok(ignored >= 0 && sqlite > ignored && bun > sqlite, name);
  }
});
