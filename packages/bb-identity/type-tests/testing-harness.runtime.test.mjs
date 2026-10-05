import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConnectionHarness,
  createManualClock,
  createStateStorageHarness,
} from '../testing-runtime.ts';

const address = {
  instanceId: 'fixture-instance', pluginId: 'fixture-plugin', collection: 'preferences',
  recordId: 'appearance', owner: 'fixture:alex',
};
const actor = {
  identity: { kind: 'person', key: 'fixture:alex', issuer: 'fixture', subject: 'alex' },
  presentation: { displayName: 'Alex', handle: null, avatarUrl: null }, evidence: 'provider-verified',
};
const mutation = (operationId, value, expectedVersion = { epoch: 'fixture-empty-r1', sequence: 0 }) => ({
  kind: 'replace', address: { ...address }, expectedVersion: { ...expectedVersion },
  expected: { actor: 'fixture:alex', session: 'fixture-session' }, ownerSession: 'owner-session',
  localGeneration: 1, operationId, schemaVersion: 1, value,
});

test('connection harness drives production connection decoding, pause, health, and disposal', async () => {
  const harness = createConnectionHarness();
  const events = [];
  const health = [];
  const stopEvents = harness.connection.subscribe(event => events.push(event));
  const stopHealth = harness.connection.subscribeHealth(() => health.push(harness.connection.getHealth()));
  harness.replyNext('fixture/request', { value: 'accepted' });
  const pause = harness.pauseNextRequest('fixture/request');
  const pending = harness.connection.request('fixture/request', {});
  await pause.reached;
  assert.deepEqual(harness.observations.methods, ['fixture/request']);
  pause.release();
  assert.deepEqual(await pending, { value: 'accepted' });
  harness.setHealth({ generation: 2, identity: { status: 'healthy' }, state: { status: 'unavailable', error: { code: 'unavailable', message: 'state down', retry: 'after-reconnect' } } });
  harness.emit({ kind: 'session' });
  assert.equal(health.length, 1);
  assert.deepEqual(events, [{ kind: 'session' }]);
  const transport = harness.connect();
  const blocked = await transport.bootstrap();
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.error.code, 'unavailable');
  stopEvents(); stopHealth();
  harness.connection.dispose(); harness.connection.dispose();
  assert.equal(harness.observations.disposeCalls, 1);
});

test('state storage harness preserves atomic receipts, response loss, expiry, and commit lifetime', async () => {
  const clock = createManualClock();
  const harness = createStateStorageHarness({ clock });
  let validations = 0;
  harness.loseNextCommitResponse();
  const first = await harness.storage.commit({ mutation: mutation('operation-1', 'dark'), validateAtCommit: () => { validations++; return { ok: true, value: actor }; } });
  assert.deepEqual(first, { ok: true, value: { status: 'indeterminate', operationId: 'operation-1' } });
  const recovered = await harness.storage.reconcile({ address, operationId: 'operation-1' });
  assert.equal(recovered.ok, true);
  if (recovered.ok) {
    assert.equal(recovered.value.status, 'final');
    if (recovered.value.status === 'final') assert.equal(recovered.value.outcome.status, 'saved');
  }
  const replay = await harness.storage.commit({ mutation: mutation('operation-1', 'dark'), validateAtCommit: () => { validations++; return { ok: true, value: actor }; } });
  assert.equal(replay.ok, true);
  assert.equal(validations, 1, 'receipt replay must not validate or re-commit');
  const changed = await harness.storage.commit({ mutation: mutation('operation-1', 'light'), validateAtCommit: () => ({ ok: true, value: actor }) });
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'invalid-operation');
  assert.equal(harness.readCommitted(address)?.value, 'dark');
  harness.expireReceipt('operation-1');
  const expired = await harness.storage.reconcile({ address, operationId: 'operation-1' });
  assert.deepEqual(expired, { ok: true, value: { status: 'unknown', reason: 'expired' } });

  const pause = harness.pauseNextCommit();
  const stale = harness.storage.commit({ mutation: mutation('operation-2', 'light', { epoch: 'fixture-empty-r1', sequence: 1 }), validateAtCommit: () => ({ ok: false, error: { code: 'expired', message: 'request lifetime ended', retry: 'never' } }) });
  await pause.reached;
  pause.release();
  const rejected = await stale;
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'expired');
  assert.equal(harness.readCommitted(address)?.value, 'dark');
  assert.deepEqual(harness.commits.map(commit => commit.version.sequence), [1]);
});

test('state storage harness makes snapshot timing and read failures explicit', async () => {
  const clock = createManualClock();
  const harness = createStateStorageHarness({ clock });
  harness.seed({ address, version: { epoch: 'fixture-empty-r1', sequence: 4 }, schemaVersion: 1, value: 'light', lastEditedBy: actor });
  const pause = harness.pauseNextRead({ capture: 'before-pause' });
  const read = harness.storage.read(address);
  await pause.reached;
  harness.seed({ address, version: { epoch: 'fixture-empty-r1', sequence: 5 }, schemaVersion: 1, value: 'dark', lastEditedBy: actor });
  pause.release();
  const stale = await read;
  assert.equal(stale.ok, true);
  if (stale.ok && stale.value.status === 'present') assert.equal(stale.value.envelope.value, 'light');
  harness.seedReadFailure({ code: 'unavailable', message: 'fixture read outage', retry: 'after-reconnect' });
  const failure = await harness.storage.read(address);
  assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.code, 'unavailable');
});
