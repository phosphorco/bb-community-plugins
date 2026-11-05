import assert from 'node:assert/strict';
import test from 'node:test';
import { createIdentityEditingState, EDITING_PROTOCOL } from '../editing-runtime.js';
import { createManualClock, deferred } from '../testing-runtime.js';
import { ok, fail, codec, address, expected, read, receipt, rejected, settle, fixture, submit } from './editing-fixtures.mjs';

test('unknown A/type B/reconcile exact A leaves B dirty without dispatch', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.saves[0].response.resolve(fail()); assert.equal((await flushing).ok, false);
  assert.equal(f.state.edit('B').ok, true); assert.equal(f.state.getSnapshot().publication.status, 'unknown');
  for (const lookup of [{ status: 'pending' }, { status: 'unknown', reason: 'expired' }, { status: 'absent-final', retry: 'same-operation-only' }]) {
    f.setLookup(lookup); assert.equal((await f.state.flush()).ok, false); assert.equal(f.saves.length, 1);
  }
  f.setLookup({ status: 'final', outcome: receipt(request) }); assert.equal((await f.state.flush()).ok, true);
  const s = f.state.getSnapshot(); assert.equal(s.desired, 'B'); assert.equal(s.acknowledged.envelope.value, 'A'); assert.equal(s.dirty, true);
  assert.deepEqual(f.lookups.at(-1), request); await f.clock.advance(60_000); assert.equal(f.saves.length, 1); f.state.dispose();
});
test('real rejected A preserves B and requires a new explicit corrected operation', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.state.edit('B'); f.saves[0].response.resolve(ok(rejected(request))); assert.equal((await flushing).ok, false);
  let s = f.state.getSnapshot(); assert.equal(s.publication.status, 'rejected'); assert.equal(s.submitted, null); assert.equal(s.desired, 'B'); assert.equal(s.acknowledged.envelope.value, 'base');
  await f.state.checkpoint(); assert.equal(f.state.getSnapshot().publication.status, 'rejected');
  const corrected = f.state.flush(); await settle(); assert.equal(f.saves.length, 2);
  assert.notEqual(f.saves[1].request.mutation.operationId, request.mutation.operationId); assert.equal(f.saves[1].request.mutation.value, 'B');
  f.saves[1].response.resolve(ok(receipt(f.saves[1].request, 'B'))); assert.equal((await corrected).ok, true);
  assert.equal(f.state.getSnapshot().publication.rejection, null); f.state.dispose();
});
test('conflict/type B rotates local decision token immediately', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.saves[0].response.resolve(ok({ protocol: EDITING_PROTOCOL, request, outcome: { status: 'conflict', current: read('C', 3), operationId: request.mutation.operationId } })); await flushing;
  const old = f.state.getSnapshot().publication.conflict; assert.equal(f.state.edit('B').ok, true);
  const next = f.state.getSnapshot().publication.conflict; assert.notEqual(next.token, old.token); assert.equal(next.local, 'B'); assert.equal(next.base.envelope.value, 'base');
  assert.equal((await f.state.resolveConflict(old.token, { kind: 'accept-remote' })).ok, false); assert.equal(f.state.getSnapshot().desired, 'B'); f.state.dispose();
});
test('checkpoint fail/type B/export B/retry backup never resolves unknown A', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.saves[0].response.resolve(fail()); await flushing; f.failWrites(true);
  assert.equal((await f.state.checkpoint()).ok, false); assert.equal(f.state.edit('B').ok, true);
  let s = f.state.getSnapshot(); assert.equal(s.draft.draft.desired, 'B'); assert.deepEqual(s.submitted, request); assert.equal(s.checkpoint.status, 'failed');
  f.failWrites(false); assert.equal((await f.state.checkpoint()).ok, true);
  s = f.state.getSnapshot(); assert.equal(s.checkpoint.status, 'backed-up'); assert.equal(s.publication.status, 'unknown'); assert.equal(s.desired, 'B'); f.state.dispose();
});
test('remote C/late receipt A preserves B and original base in conflict', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.state.edit('B'); f.setRemote(read('C', 3)); f.notify(3);
  f.saves[0].response.resolve(ok(receipt(request, 'A', 2))); await flushing;
  const s = f.state.getSnapshot(); assert.equal(s.desired, 'B'); assert.equal(s.acknowledged.envelope.value, 'A');
  assert.equal(s.publication.conflict.base.envelope.value, 'A'); assert.equal(s.publication.conflict.remote.envelope.value, 'C'); assert.equal(f.saves.length, 1); f.state.dispose();
});
test('reload B+pending A retains exact request in fresh owner session', async () => {
  const old = fixture(); await old.state.start(); const { flushing, request } = await submit(old); old.state.edit('B');
  const checkpoint = (await old.state.checkpoint()).value;
  old.state.detach('unmount'); old.saves[0].response.resolve(fail()); await flushing;
  const next = fixture({ ownerSession: 'owner-a3', sessionStamp: 'session-a3/new%2Fopaque' }); await next.state.start();
  next.setLookup({ status: 'unknown', reason: 'unavailable' }); assert.equal((await next.state.recover(checkpoint)).ok, false);
  assert.equal(next.state.getSnapshot().desired, 'B'); assert.deepEqual(next.lookups[0], request); assert.equal(next.state.getSnapshot().scope.expected.session, 'session-a3/new%2Fopaque'); assert.equal(next.state.edit('C').ok, true);
  assert.equal((await next.state.checkpoint()).ok, true); assert.deepEqual(next.state.getSnapshot().draft.draft.inFlight, request.mutation);
  next.setLookup({ status: 'final', outcome: receipt(request) }); assert.equal((await next.state.flush()).ok, true);
  assert.equal(next.state.getSnapshot().desired, 'C'); assert.equal(next.saves.length, 0); next.state.dispose(); old.state.dispose();
});
test('wrong full request with same ID remains unknown, never a fake rejection', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  const changed = { ...request, mutation: { ...request.mutation, value: 'changed' } };
  f.saves[0].response.resolve(ok(rejected(changed))); assert.equal((await flushing).ok, false);
  assert.equal(f.state.getSnapshot().publication.status, 'unknown'); assert.deepEqual(f.state.getSnapshot().submitted, request); f.state.dispose();
});
test('owner A1/B2/A3 and detach fence old controller callbacks', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  f.setSession({ status: 'ready', instanceId: 'instance-1', actor: { identity: { key: 'person:b' } }, stamp: 'session-b2' }); assert.equal(f.state.edit('wrong').ok, false);
  f.setSession({ status: 'ready', instanceId: 'instance-1', actor: { identity: { key: 'person:a' } }, stamp: expected.session }); assert.equal(f.state.edit('old revived').ok, false);
  f.state.detach('identity-invalidated'); f.saves[0].response.resolve(ok(receipt(request))); assert.equal((await flushing).ok, false); assert.equal(f.state.getSnapshot().status, 'detached'); assert.equal(f.state.getSnapshot().desired, 'A'); f.state.dispose();
});
test('timeout retains A while B remains editable and unsent', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  await f.clock.advance(30_000); assert.equal((await flushing).ok, false); assert.equal(f.state.edit('B').ok, true);
  assert.deepEqual(f.state.getSnapshot().submitted, request); f.saves[0].response.resolve(ok(receipt(request))); await settle();
  assert.equal(f.state.getSnapshot().desired, 'B'); assert.equal(f.saves.length, 1); f.state.dispose();
});

test('receipt metadata at same desired generation is local-only until its checkpoint commits', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f);
  assert.equal(f.state.getSnapshot().checkpoint.status, 'backed-up'); // pre-dispatch pending A
  f.failWrites(true); f.saves[0].response.resolve(ok(rejected(request))); assert.equal((await flushing).ok, false);
  let s = f.state.getSnapshot(); assert.equal(s.localGeneration, 1); assert.equal(s.checkpoint.status, 'failed'); assert.equal(s.submitted, null); assert.equal(s.publication.status, 'rejected');
  assert.equal(f.state.edit('B').ok, true); const exported = f.state.getSnapshot().draft; assert.equal(exported.rejection.outcome.status, 'rejected');
  f.failWrites(false); assert.equal((await f.state.checkpoint()).ok, true);
  s = f.state.getSnapshot(); assert.equal(s.checkpoint.status, 'backed-up'); assert.equal(s.publication.status, 'rejected');
  assert.equal(f.saves.length, 1); f.state.dispose();
});
test('recovered rejection retains corrected B and allows only an explicit new operation', async () => {
  const prior = fixture(); await prior.state.start(); const { flushing, request } = await submit(prior); prior.state.edit('B');
  prior.saves[0].response.resolve(ok(rejected(request))); await flushing; const checkpoint = (await prior.state.checkpoint()).value; prior.state.dispose();
  const f = fixture({ ownerSession: 'owner-a3', sessionStamp: 'session-a3/new%2Fopaque' }); await f.state.start(); assert.equal((await f.state.recover(checkpoint)).ok, true);
  assert.equal(f.state.getSnapshot().desired, 'B'); assert.equal(f.state.getSnapshot().publication.status, 'rejected');
  const corrected = f.state.flush(); await settle(); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].request.mutation.value, 'B');
  assert.notEqual(f.saves[0].request.mutation.operationId, request.mutation.operationId);
  f.saves[0].response.resolve(ok(receipt(f.saves[0].request, 'B'))); assert.equal((await corrected).ok, true); f.state.dispose();
});
test('lost definitive rejection reconciles original A after remote C and keeps B', async () => {
  const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f); f.saves[0].response.resolve(fail()); await flushing;
  f.state.edit('B'); f.setRemote(read('C', 3)); f.notify(3); f.setLookup({ status: 'final', outcome: rejected(request) });
  assert.equal((await f.state.flush()).ok, false); const s = f.state.getSnapshot(); assert.equal(s.desired, 'B'); assert.equal(s.acknowledged.envelope.value, 'base');
  assert.equal(s.publication.status, 'rejected'); assert.equal(s.submitted, null); assert.equal(f.saves.length, 1); f.state.dispose();
});
test('load failure and migration fence editing until an authoritative successful load', async () => {
  let result = read('base'); const f = fixture({ load: async () => ok(result) }); await f.state.start(); f.state.edit('B');
  result = { status: 'migration-required', address, storedSchemaVersion: 0 }; assert.equal((await f.state.reconnect()).ok, false);
  assert.equal(f.state.edit('C').ok, false); assert.equal(f.state.getSnapshot().desired, 'B');
  result = read('base'); assert.equal((await f.state.reconnect()).ok, true); assert.equal(f.state.edit('C').ok, true); f.state.dispose();
});

test('typed transport normalization cannot bless foreign outer or nested protocol finality', async () => {
  for (const change of [value => ({ ...value, protocol: 'bb-identity.editing/v9' }),
    value => ({ ...value, request: { ...value.request, protocol: 'bb-identity.editing/v9' } })]) {
    const f = fixture(); await f.state.start(); const { flushing, request } = await submit(f); f.state.edit('B');
    f.saves[0].response.resolve(ok(change(rejected(request)))); assert.equal((await flushing).ok, false);
    let s = f.state.getSnapshot(); assert.deepEqual(s.submitted, request); assert.equal(s.publication.rejection, null); assert.equal(s.desired, 'B');
    f.setLookup({ status: 'final', outcome: change(rejected(request)) }); assert.equal((await f.state.flush()).ok, false);
    s = f.state.getSnapshot(); assert.deepEqual(s.submitted, request); assert.equal(s.publication.rejection, null); assert.equal(f.saves.length, 1);
    f.setLookup({ status: 'final', outcome: rejected(request) }); assert.equal((await f.state.flush()).ok, false);
    assert.equal(f.state.getSnapshot().submitted, null); assert.equal(f.state.getSnapshot().publication.status, 'rejected'); assert.equal(f.state.getSnapshot().desired, 'B'); f.state.dispose();
  }
});
test('recovery rejects future-generation or cross-schema rejection without poisoning an A3 draft', async () => {
  const prior = fixture(); await prior.state.start(); const { flushing, request } = await submit(prior);
  prior.saves[0].response.resolve(ok(rejected(request))); await flushing; prior.state.edit('B'); const checkpoint = (await prior.state.checkpoint()).value; prior.state.dispose();
  const f = fixture({ ownerSession: 'owner-a3', sessionStamp: 'session-a3/opaque%2F' }); await f.state.start();
  for (const change of [mutation => { mutation.localGeneration = 99; }, mutation => { mutation.schemaVersion = 9; }]) {
    const inconsistent = structuredClone(checkpoint); change(inconsistent.draft.rejection.request.mutation);
    assert.equal((await f.state.recover(inconsistent)).ok, false); assert.equal(f.state.getSnapshot().desired, 'base'); assert.equal(f.state.getSnapshot().publication.rejection, null); assert.equal(f.saves.length, 0);
  }
  assert.equal((await f.state.recover(checkpoint)).ok, true); assert.equal(f.state.getSnapshot().desired, 'B');
  const corrected = f.state.flush(); await settle(); assert.equal(f.saves.length, 1); assert.equal(f.saves[0].request.mutation.value, 'B');
  assert.equal(f.saves[0].request.mutation.expected.session, 'session-a3/opaque%2F'); assert.notEqual(f.saves[0].request.mutation.operationId, request.mutation.operationId);
  f.saves[0].response.resolve(ok(receipt(f.saves[0].request, 'B'))); assert.equal((await corrected).ok, true); f.state.dispose();
});
