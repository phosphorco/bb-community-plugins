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
  const pause = probe.holdNext('providerSettingsV1Read', 'owner-a');
  const mounted = mountEditor(editorSubject(a).render(), { probe });
  await pause.reached;
  let resolved = false;
  void mounted.then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false, 'mountEditor resolved while the initial Read was still pending');
  pause.release();
  const editor = await mounted;
  try {
    assert.equal(editor.button('Edit').disabled, false);
    assert.match(editor.text(), /Current: Inherit/);
  } finally { await editor.dispose(); }
  assert.equal(typeof globalThis.document, 'undefined', 'dispose restores the global scope');
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
