// Mounted-editor self-test: the production RoleSettingsEditor, wired to the
// test-owned owner through an OwnerProbe, passes every editor scenario.
// Negative self-tests mount deliberately broken editors that must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { experimental_ProviderModelPicker as Picker } from '@get-bb/plugin-sdk/app';
import { RoleSettingsEditor } from '@phosphorco/bb-provider-settings/react';
import { createFakeCatalog, createOwnerProbe, defineScenarios } from '@phosphorco/bb-provider-settings/testing';
import { crossOwnerEditorScenario, editorScenarios, mountEditor } from '@phosphorco/bb-provider-settings/testing/react';
import { createTestOwner } from './test-owner.mjs';

const h = React.createElement;
const sampleRoute = { kind: 'host', hostId: 'h' };
const catalog = createFakeCatalog();
const a = createTestOwner({ pluginId: 'owner-a', catalog });
const b = createTestOwner({ pluginId: 'owner-b', roleId: 'reviewer', descriptor: { label: 'Reviewer' }, catalog });
const probe = createOwnerProbe({ 'owner-a': a.host, 'owner-b': b.host }, { catalog });
test.after(async () => { await a.dispose(); await b.dispose(); });

function editorSubject(owner, render) {
  return {
    owner: owner.pluginId, probe, catalog,
    render: render ?? (() => h(RoleSettingsEditor, { client: probe.client(owner.pluginId), role: owner.role, catalogSdk: catalog.sdk, sampleRoute })),
    readRaw: () => ({ ...owner.store }),
    writeExternally: owner.writeExternally,
    seedMalformed: () => owner.subject().seedMalformed(),
    restore: () => owner.subject().restore(),
  };
}

const scenarios = editorScenarios(editorSubject(a));
for (const s of scenarios) assert.equal(s.skip, undefined, `${s.id} unexpectedly carries a gap`);
defineScenarios(test, scenarios, 'kit ui self-test: ');
defineScenarios(test, [crossOwnerEditorScenario([editorSubject(a), editorSubject(b)])], 'kit ui self-test cross-owner: ');

test('kit ui self-test: mountEditor settles the actual pending initial Read before resolving', async () => {
  // A slow real owner response is unfinished async work, unlike holdNext(),
  // whose intentional unreleased pause must make settled() reject.
  const readReached = Promise.withResolvers(), readReleased = Promise.withResolvers();
  const settlementReached = Promise.withResolvers();
  const slowHost = { harness: { behavior: {
    async callRpc(method, input) {
      const result = await a.host.harness.behavior.callRpc(method, input);
      if (method === 'providerSettingsV1Read') {
        readReached.resolve();
        await readReleased.promise;
      }
      return result;
    },
  } } };
  const slowProbe = createOwnerProbe({ 'owner-a': slowHost }, { catalog });
  const mountProbe = Object.create(slowProbe); // Preserve the live pending getter.
  mountProbe.settled = () => {
    const pending = slowProbe.settled();
    settlementReached.resolve();
    return pending;
  };
  let resolved = false;
  const mounted = mountEditor(h(RoleSettingsEditor, {
    client: slowProbe.client('owner-a'), role: a.role, catalogSdk: catalog.sdk, sampleRoute,
  }), { probe: mountProbe });
  // Observe rejections immediately; never create an unhandled child promise.
  void mounted.then(() => { resolved = true; }, () => {});
  let editor;
  try {
    // An early return or rejection fails rather than stranding the handshake.
    const early = mounted.then(() => { throw new Error('mountEditor returned before awaiting the pending Read'); });
    await Promise.race([readReached.promise, early]);
    await Promise.race([settlementReached.promise, early]);
    assert.equal(slowProbe.pending, 1, 'the real initial Read must still be pending at settlement');
    assert.equal(resolved, false, 'mountEditor resolved while the initial Read was still pending');
    readReleased.resolve();
    editor = await mounted;
    assert.equal(slowProbe.pending, 0);
    assert.equal(editor.button('Edit').disabled, false);
    assert.match(editor.text(), /Current: Inherit/);
  } finally {
    readReleased.resolve();
    editor ??= await mounted.catch(() => undefined);
    await editor?.dispose();
  }
  assert.equal(typeof globalThis.document, 'undefined', 'dispose restores the global scope');
});

test('kit ui self-test: an intentional held Read rejects settlement and recovers after release', async () => {
  const pause = probe.holdNext('providerSettingsV1Read', 'owner-a');
  let editor;
  try {
    editor = await mountEditor(editorSubject(a).render(), { probe, settle: false });
    await pause.reached;
    assert.equal(probe.pending, 1);
    await assert.rejects(editor.settled(), /held owner call is unreleased/);
    pause.release();
    await editor.settled();
    assert.equal(probe.pending, 0);
    assert.equal(editor.button('Edit').disabled, false);
  } finally {
    pause.release();
    try { await probe.settled(); } finally { await editor?.dispose(); }
  }
  assert.equal(typeof globalThis.document, 'undefined', 'dispose restores the global scope after held-call recovery');
});

// A deliberately broken editor. 'late-callback' turns any picker callback into
// save intent; 'delayed-read' enables Edit before the initial Read settles.
function BrokenEditor({ client, role, flaw }) {
  const [read, setRead] = React.useState(null), [browsing, setBrowsing] = React.useState(false), [dirty, setDirty] = React.useState(false);
  React.useEffect(() => { void client.read(role.id).then(setRead); }, [client, role.id]);
  return h('section', null,
    h('p', null, read ? `Current: ${read.stored.status === 'valid-shape' ? read.stored.choice.kind : 'Malformed'}` : 'Reading…'),
    h('button', { disabled: flaw === 'delayed-read' ? false : !read, onClick: () => setBrowsing(true) }, 'Edit'),
    browsing && h(Picker, { value: { providerId: 'p', model: 'exec-model', reasoningLevel: 'low' }, onChange: () => { if (flaw === 'late-callback') setDirty(true); } }),
    h('button', { disabled: !dirty }, 'Save'));
}
const broken = flaw => editorScenarios(editorSubject(a, () => h(BrokenEditor, { client: probe.client('owner-a'), role: a.role, flaw })));
const pick = (list, id) => list.find(s => s.id === id);

test('negative ui self-test late-callback: an editor that promotes a picker callback fails late-callback-no-promotion', async () => {
  await assert.rejects(pick(broken('late-callback'), 'late-callback-no-promotion').run(), /\[late-callback-no-promotion\] a picker callback without explicit promotion enabled Save/);
  await pick(broken(undefined), 'late-callback-no-promotion').run();
});

test('negative ui self-test delayed-read: an editor that enables Edit before its initial Read settles fails delayed-read', async () => {
  await assert.rejects(pick(broken('delayed-read'), 'delayed-read').run(), /\[delayed-read\] Edit is enabled before the initial Read settled/);
  await pick(broken(undefined), 'delayed-read').run();
});
