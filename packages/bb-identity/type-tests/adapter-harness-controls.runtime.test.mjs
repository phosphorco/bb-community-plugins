import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdapterHarness, personFixture } from '../testing-runtime.js';

const codec = { decode: (value) => ({ ok: true, value }), encode: (value) => value };

test('multi-user actor replacement advances session, invalidates issued request, and notifies subscribers', async () => {
  const harness = createAdapterHarness({ mode: 'multi-user', inputCodec: codec });
  const host = harness.connect();
  const events = [];
  host.subscribe((event) => events.push(event));
  const context = harness.request();
  const opened = await host.openPersonRequest(context);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const before = opened.value.session;

  const replacement = harness.setActor(personFixture({ subject: 'bob', name: 'Bob' }));
  const after = await host.session(harness.request());

  assert.deepEqual(replacement, { ok: true, value: undefined });
  assert.equal(opened.value.signal.aborted, true);
  assert.equal(opened.value.validate(before ? { actor: before.actor.identity.key, session: before.stamp } : null).ok, false);
  assert.equal(after.status, 'ready');
  if (after.status === 'ready') {
    assert.equal(after.actor.identity.subject, 'bob');
    assert.notEqual(after.stamp, before.stamp);
  }
  assert.deepEqual(events, [{ kind: 'session', reason: 'actor' }]);
});

test('singleton actor replacement rejects explicitly and unsupported controls never pretend to work', () => {
  const harness = createAdapterHarness({ mode: 'single-user', inputCodec: codec });
  const rejected = harness.setActor(personFixture({ subject: 'bob', name: 'Bob' }));
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, 'unsupported');
  const request = harness.request();
  const unsupported = [
    () => harness.setLookup('pending'),
    () => harness.constructStreamingResponse(request),
    () => harness.finishStream(request),
    () => harness.pauseAcceptance('before-commit'),
    () => harness.loseNextAcceptanceResponse(),
    () => harness.beginAttempt([]),
    () => harness.editContribution('contribution-1', personFixture({ subject: 'bob', name: 'Bob' })),
    () => harness.continueAttempt('attempt-1', 'continue'),
    () => harness.toolCallForAttempt('attempt-1'),
    () => harness.accepted,
  ];
  for (const control of unsupported) assert.throws(control, /unsupported by this fixture/);
});
