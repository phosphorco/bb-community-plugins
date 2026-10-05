// Negative self-tests: deliberately broken subjects must make the matching
// scenario fail. A kit that reimplemented the protocol, or checked nothing,
// would let these pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { invocationScenarios, ownerScenarios } from '@phosphorco/bb-provider-settings/testing';
import { createFingerprintIgnoringOwner, createTestOwner, spawningPlugin } from './test-owner.mjs';

const pick = (scenarios, id) => { const s = scenarios.find(x => x.id === id); assert.ok(s, `no scenario ${id}`); return s; };

test('negative self-test write-on-read: an owner that migrates storage during Read fails read-validate-no-side-effects', async () => {
  const owner = createTestOwner({ flaw: 'write-on-read' });
  try {
    await assert.rejects(pick(ownerScenarios(owner.subject()), 'read-validate-no-side-effects').run(), /\[read-validate-no-side-effects\] Read changed the plugin's stored data/);
  } finally { await owner.dispose(); }
});

test('negative self-test ignored-fingerprint: an owner that ignores expectedFingerprint fails stale-fingerprint-conflict', async () => {
  const owner = createFingerprintIgnoringOwner();
  try {
    await assert.rejects(pick(ownerScenarios(owner.subject()), 'stale-fingerprint-conflict').run(), /\[stale-fingerprint-conflict\] Save with a stale fingerprint returned saved, not conflict/);
    assert.deepEqual(JSON.parse(owner.store.expert).kind, 'tuple', 'the broken owner really overwrote the external write');
  } finally { await owner.dispose(); }
});

test('negative self-test inherit-leak: a dispatch that adds a model on inherit fails inherit-native-path against its baseline', async () => {
  await assert.rejects(pick(invocationScenarios(spawningPlugin({ leakOnInherit: true })), 'inherit-native-path').run(), /model is present but the baseline has it absent/);
});
