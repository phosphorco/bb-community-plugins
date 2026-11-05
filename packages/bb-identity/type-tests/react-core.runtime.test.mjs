/** Emitted graph and identity checks; mounted mixed-entry ownership is the browser fixture. */
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as core from '@phosphorco/bb-identity/react-core';
import * as native from '@phosphorco/bb-identity/react';
test('every borrowed core export is the exact native export, with native acquisition excluded', () => {
  assert.ok(Object.keys(core).length > 10);
  for (const [key, value] of Object.entries(core)) assert.equal(native[key], value, key);
  assert.equal(core.BbIdentity.Provider, native.BbIdentity.Provider);
  assert.equal(core.BbIdentity.Context, native.BbIdentity.Context);
  assert.equal('useBbIdentityClient' in core, false); assert.equal('useBbIdentityConnection' in core, false);
  assert.equal(typeof native.useBbIdentityClient, 'function'); assert.equal(typeof native.useBbIdentityConnection, 'function');
});
async function graph(entry) {
  const files = new Set(), external = new Set();
  async function visit(file) {
    if (files.has(file)) return; files.add(file);
    const source = await readFile(file, 'utf8');
    for (const item of new Bun.Transpiler({ loader: 'js' }).scanImports(source)) {
      if (item.path.startsWith('.')) await visit(resolve(dirname(file), item.path)); else external.add(item.path);
    }
  }
  await visit(entry); return { files, external };
}
test('full emitted core closure has no SDK import and both entries share one chunk', async () => {
  const coreGraph = await graph(fileURLToPath(import.meta.resolve('@phosphorco/bb-identity/react-core')));
  const nativeGraph = await graph(fileURLToPath(import.meta.resolve('@phosphorco/bb-identity/react')));
  assert.ok(coreGraph.files.size >= 2); assert.ok(coreGraph.external.has('react'));
  assert.equal([...coreGraph.external].some(value => value.startsWith('@get-bb/')), false);
  assert.ok(nativeGraph.external.has('@get-bb/plugin-sdk/app'), 'negative control must detect native slot-hook graph');
  const shared = [...coreGraph.files].filter(value => nativeGraph.files.has(value));
  assert.equal(shared.length, 1); assert.ok(shared[0].endsWith('/react-core-shared.js'));
});
