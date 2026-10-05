// Kit self-test: the standard scenarios pass against the package's own
// test-owned owner, which uses the real registerProviderSettingsOwner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeCatalog, createOwnerProbe, crossOwnerScenario, defineScenarios, invocationScenarios,
  ownerScenarios, selectionFixture, withOverride,
} from '@phosphorco/bb-provider-settings/testing';
import { createTestOwner, spawningPlugin } from './test-owner.mjs';

const invocationRole = createTestOwner({ pluginId: 'owner-a' });
const destinationRole = createTestOwner({ pluginId: 'owner-b', roleId: 'reviewer', descriptor: { label: 'Reviewer', saveValidation: 'destination' }, destination: { route: { kind: 'host', hostId: 'h' }, preview: false } });
const readOnlyRole = createTestOwner({ pluginId: 'owner-c', roleId: 'auditor', descriptor: { label: 'Auditor', writable: false } });
test.after(async () => { for (const o of [invocationRole, destinationRole, readOnlyRole]) await o.dispose(); });

const kitSelf = (name, scenarios) => {
  for (const s of scenarios) assert.equal(s.skip, undefined, `${name} ${s.id} unexpectedly carries a gap: ${s.skip}`);
  defineScenarios(test, scenarios, `kit self-test ${name}: `);
};

kitSelf('invocation-validated owner', ownerScenarios(invocationRole.subject()));
kitSelf('destination-validated owner', ownerScenarios(destinationRole.subject()));
kitSelf('read-only owner', ownerScenarios(readOnlyRole.subject({ readOnly: true })));
kitSelf('cross-owner', [crossOwnerScenario([invocationRole.subject(), destinationRole.subject()])]);

test('kit self-test: a missing subject hook stays a visible gap, never a pass', () => {
  const { seedMalformed: _m, reload: _r, ...subject } = invocationRole.subject();
  const gaps = Object.fromEntries(ownerScenarios(subject).filter(s => s.skip).map(s => [s.id, s.skip]));
  assert.deepEqual(gaps, { 'reload-retains-intent': 'subject supplies no reload', 'malformed-retained': 'subject supplies no seedMalformed' });
  assert.equal(ownerScenarios(invocationRole.subject(), { skip: { describe: 'reason' } })[0].skip, 'reason');
});

test('kit self-test: owner probe holds and loses responses on the real owner', async () => {
  const owner = createTestOwner({ pluginId: 'owner-probe' }), probe = createOwnerProbe(owner.host, { catalog: owner.catalog });
  try {
    const client = probe.client();
    const pause = probe.holdNext('providerSettingsV1Read');
    const pending = client.read('expert');
    await pause.reached;
    assert.equal(probe.pending, 1);
    await assert.rejects(probe.settled(), /held owner call is unreleased/);
    pause.release();
    await probe.settled();
    const read = await pending;
    probe.loseNextResponse('providerSettingsV1Save');
    await assert.rejects(client.save('expert', { kind: 'tuple', selection: selectionFixture }, read.fingerprint, { kind: 'host', hostId: 'h' }), e => e.kind === 'transient');
    assert.deepEqual(JSON.parse(owner.store.expert), { kind: 'tuple', selection: selectionFixture }, 'a lost response still committed');
    await assert.rejects(probe.client('nobody').read('expert'), e => e.kind === 'vanished');
    assert.deepEqual((await probe.sdk.plugins.list({})).plugins.map(p => p.id), ['owner-probe']);
  } finally { await owner.dispose(); }
});


kitSelf('invocation', invocationScenarios(spawningPlugin()));

test('kit self-test: withOverride merges fields and keeps baseline provenance', () => {
  const request = { method: 'threads.spawn', args: { prompt: 'x', executionInputSources: { permissionMode: 'explicit' } } };
  assert.deepEqual(withOverride(request, { model: 'm', executionInputSources: { model: 'explicit' } }).args, { prompt: 'x', model: 'm', executionInputSources: { permissionMode: 'explicit', model: 'explicit' } });
  assert.deepEqual(withOverride({ method: 'send', args: { input: [] } }, { reasoningLevel: 'high' }).args, { input: [], reasoningLevel: 'high' });
  assert.equal(createFakeCatalog().calls.length, 0);
});
