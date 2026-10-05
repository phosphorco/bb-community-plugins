import assert from "node:assert/strict";
import test from "node:test";
import { createIdentityState } from "../state-controller-runtime.js";
import { createManualClock, deferred } from "../testing-runtime.js";

const codec = { decode: (value) => typeof value === "string" ? { ok: true, value } : { ok: false, error: { code: "invalid-input", message: "string", retry: "never" } }, encode: (value) => value };
const address = { instanceId: "instance-1", pluginId: "plugin-1", collection: "preferences", recordId: "theme", owner: "person:a" };
const expected = { actor: "person:a", session: "session-a" };
const version = (sequence) => ({ epoch: "epoch-1", sequence });
const empty = { status: "empty", address, version: version(0) };
const envelope = (value, sequence) => ({ address, version: version(sequence), schemaVersion: 1, value, lastEditedBy: null });
const ok = (value) => ({ ok: true, value });
const failure = (code = "unavailable") => ({ ok: false, error: { code, message: code, retry: "never" } });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const clock = createManualClock(); let session = { status: "ready", instanceId: "instance-1", mode: "multi-user", actor: { identity: { kind: "person", key: "person:a", issuer: "fixture", subject: "a" }, presentation: { displayName: "A", handle: null, avatarUrl: null }, evidence: "provider-verified" }, stamp: "session-a", capabilities: {} };
  const loads = []; const saves = []; const reconciles = []; const subscriptions = new Set(); const writes = []; const removes = [];
  const transport = {
    load: () => { const next = deferred(); loads.push(next); return next.promise; },
    save: (mutation) => { const next = deferred(); saves.push({ mutation, next }); return next.promise; },
    reconcile: (input) => { reconciles.push(input); return options.reconcile ? options.reconcile(input) : Promise.resolve(ok({ status: "pending" })); },
    subscribe: (_address, listener) => { subscriptions.add(listener); return () => subscriptions.delete(listener); },
  };
  const drafts = options.drafts === null ? undefined : { find: async () => ok([]), write: async (draft) => { writes.push(draft); return options.write ? options.write(draft, writes.length) : options.failWrite ? failure("unavailable") : ok({ revision: writes.length, draft }); }, remove: async (key, revision) => { removes.push({ key, revision }); return ok(undefined); } };
  const state = createIdentityState({ address, expected, ownerSession: options.ownerSession ?? "owner-a", definition: { collection: "preferences", schemaVersion: 1, codec: options.codec ?? codec, initialValue: () => options.nullInitial ? null : "light", equal: (a, b) => a === b }, transport, ...(drafts ? { drafts } : {}), scheduler: clock, debounceMs: 10, retryLimit: options.retryLimit ?? 1, onConflict: () => options.conflictDecision ?? ({ kind: "needs-review", reason: "review" }), initializeEmpty: options.initializeEmpty ?? true, currentSession: () => ok(session) });
  const start = async (read = empty) => { const started = state.start(); loads.shift().resolve(ok(read)); await started; };
  return { clock, state, loads, saves, reconciles, subscriptions, writes, removes, start, setSession: (next) => { session = next; } };
}

test("rapid edits coalesce and B remains pending while A saves", async () => {
  const f = fixture(); await f.start();
  f.state.edit("A"); f.state.edit("B"); await f.clock.advance(10); await settle();
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].mutation.value, "B");
  f.state.edit("C");
  f.saves[0].next.resolve(ok({ status: "saved", envelope: envelope("B", 1), operationId: f.saves[0].mutation.operationId }));
  await settle(); await f.clock.advance(10); await settle();
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1].mutation.value, "C");
});

test("a no-draft preference initializes and reconciles without creating a browser checkpoint", async () => {
  const f = fixture({ drafts: null }); await f.start(); await f.clock.advance(10); await settle();
  assert.equal(f.saves.length, 1); assert.equal(f.writes.length, 0);
  f.saves[0].next.resolve(ok({ status: "saved", envelope: envelope("light", 1), operationId: f.saves[0].mutation.operationId }));
  await settle();
  assert.deepEqual((await f.state.recoveryCandidates()).value, []);
  assert.equal((await f.state.checkpoint()).value, null);
  assert.equal((await f.state.close({ pending: "preserve" })).ok, true);
  assert.equal(f.removes.length, 0);
});

test('health recovery reuses held load or receipt lookup without superseding explicit recovery', async () => {
  const receipt = deferred(); const f = fixture({ reconcile: () => receipt.promise });
  await f.start({ status: 'present', envelope: envelope('base', 1) });
  const reload = f.state.reconnect(); const notification = f.state.reconnect({ reuseInFlight: true });
  assert.equal(f.loads.length, 1); f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('base', 1) }));
  assert.equal((await reload).ok, true); assert.equal((await notification).ok, true);
  f.state.edit('local'); const saving = f.state.flush(); await settle();
  const sent = f.saves[0]; sent.next.resolve(failure()); assert.equal((await saving).ok, false);
  const recovery = f.state.flush(); await settle();
  const healthy = f.state.reconnect({ reuseInFlight: true }); assert.equal(f.reconciles.length, 1);
  receipt.resolve(ok({ status: 'final', outcome: { status: 'saved', envelope: envelope('local', 2), operationId: sent.mutation.operationId } }));
  assert.equal((await recovery).ok, true); assert.equal((await healthy).ok, true);
  assert.equal(f.saves.length, 1); assert.equal(f.state.getSnapshot().desired, 'local');
  assert.equal(f.loads.length, 0); f.state.dispose();
});

test("late loads and dirty reconnect create explicit superseding conflicts", async () => {
  const f = fixture(); await f.start(); f.state.edit("local");
  const reconnect1 = f.state.reconnect(); f.loads.shift().resolve(ok({ status: "present", envelope: envelope("remote-1", 1) })); await reconnect1;
  const first = f.state.getSnapshot(); assert.equal(first.status, "blocked"); assert.equal(first.reason, "conflict"); const token1 = first.conflict.token;
  const reconnect2 = f.state.reconnect(); f.loads.shift().resolve(ok({ status: "present", envelope: envelope("remote-2", 2) })); await reconnect2;
  const second = f.state.getSnapshot(); assert.equal(second.status, "blocked"); const token2 = second.conflict.token; assert.notEqual(token1, token2);
  const stale = await f.state.resolveConflict(token1, { kind: "accept-remote" }); assert.equal(stale.ok, false);
  await f.state.resolveConflict(token2, { kind: "rebase", value: "explicit" });
  assert.equal(f.state.getSnapshot().status, "ready"); assert.equal(f.state.getSnapshot().desired, "explicit");
});

test("session freshness, detach, checkpoint failure and exact recovery retain intent", async () => {
  const f = fixture(); await f.start(); f.state.edit("dark");
  f.setSession({ status: "ready", instanceId: "instance-1", mode: "multi-user", actor: { identity: { kind: "person", key: "person:b", issuer: "fixture", subject: "b" }, presentation: { displayName: "B", handle: null, avatarUrl: null }, evidence: "provider-verified" }, stamp: "session-b", capabilities: {} });
  const blocked = await f.state.flush(); assert.equal(blocked.ok, false); assert.equal(f.saves.length, 0);
  f.setSession({ status: "ready", instanceId: "instance-1", mode: "multi-user", actor: { identity: { kind: "person", key: "person:a", issuer: "fixture", subject: "a" }, presentation: { displayName: "A", handle: null, avatarUrl: null }, evidence: "provider-verified" }, stamp: "session-a", capabilities: {} });
  const refreshed = f.state.reconnect(); f.loads.shift().resolve(ok(empty)); await refreshed;
  const flushing = f.state.flush(); await settle(); const pending = f.saves[0]; const retained = f.state.detach("unmount"); assert.equal(retained.inFlight.operationId, pending.mutation.operationId);
  pending.next.resolve(ok({ status: "saved", envelope: envelope("dark", 1), operationId: pending.mutation.operationId })); await flushing; assert.equal(f.state.getSnapshot().status, "detached");
  const recovered = fixture(); await recovered.start(); const checkpoint = { revision: 1, draft: retained };
  await recovered.state.recover(checkpoint); assert.equal(recovered.reconciles[0].operationId, pending.mutation.operationId); assert.equal(recovered.saves.length, 0);
  await recovered.state.close({ pending: "discard" }); assert.equal(recovered.removes.length, 1);
});

test('an exact recovery checkpoint can be explicitly forgotten without erasing a newer revision', async () => {
  const original = fixture(); await original.start(); original.state.edit('old draft');
  const retained = original.state.detach(); const checkpoint = { revision: 7, draft: retained };
  const f = fixture(); await f.start();
  assert.equal((await f.state.discardRecovery(checkpoint)).ok, true);
  assert.deepEqual(f.removes, [{ key: retained.key, revision: 7 }]);
  const wrongActor = { revision: 7, draft: { ...retained, key: { ...retained.key, actor: 'person:b' } } };
  assert.equal((await f.state.discardRecovery(wrongActor)).ok, false);
  assert.equal(f.removes.length, 1);
  f.state.dispose();
});

test("failed checkpoint preservation blocks dispatch without discarding desired intent", async () => {
  const f = fixture({ failWrite: true }); await f.start(); f.state.edit("preserve-me");
  const result = await f.state.flush(); assert.equal(result.ok, false); assert.equal(f.saves.length, 0);
  const blocked = f.state.getSnapshot(); assert.equal(blocked.status, "blocked"); assert.equal(blocked.draft.desired, "preserve-me");
});

test('dirty same-version reload preserves intent and ignores obsolete load errors', async () => {
  const f = fixture(); await f.start({ status: 'present', envelope: envelope('base', 1) }); f.state.edit('local');
  const old = f.state.reconnect(); const oldLoad = f.loads.shift();
  const newer = f.state.reconnect(); f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('base', 1) })); await newer;
  oldLoad.resolve(failure()); await old;
  assert.equal(f.state.getSnapshot().status, 'ready'); assert.equal(f.state.getSnapshot().desired, 'local'); assert.equal(f.state.getSnapshot().acknowledged.envelope.version.sequence, 1);
  f.state.dispose();
});

test('uncertain save is retained through pending lookup and exact same-operation retry', async () => {
  let lookup = { status: 'pending' }; const f = fixture({ reconcile: async () => ok(lookup) }); await f.start(); f.state.edit('first');
  const first = f.state.flush(); await settle(); const submitted = f.saves[0].mutation;
  f.saves[0].next.resolve(ok({ status: 'indeterminate', operationId: submitted.operationId })); assert.equal((await first).ok, false);
  assert.equal(f.state.getSnapshot().draft.inFlight.operationId, submitted.operationId);
  assert.equal((await f.state.flush()).ok, false); assert.equal(f.saves.length, 1); assert.equal(f.state.edit('unsafe').ok, false);
  lookup = { status: 'absent-final', retry: 'same-operation-only' };
  const retried = f.state.flush(); await settle(); assert.equal(f.saves.length, 2); assert.deepEqual(f.saves[1].mutation, submitted);
  f.saves[1].next.resolve(ok({ status: 'saved', envelope: envelope('first', 1), operationId: submitted.operationId })); assert.equal((await retried).ok, true);
  f.state.dispose();
});

test('recovery keeps a newer desired value beyond the exact acknowledged flight generation', async () => {
  const prior = fixture(); await prior.start(); prior.state.edit('submitted'); const saving = prior.state.flush(); await settle();
  prior.state.edit('newer'); const retained = prior.state.detach(); prior.saves[0].next.resolve(failure()); await saving;
  const operationId = retained.inFlight.operationId;
  const f = fixture({ ownerSession: 'owner-new', reconcile: async () => ok({ status: 'final', outcome: { status: 'saved', envelope: envelope('submitted', 1), operationId } }) });
  await f.start(); const recovering = f.state.recover({ revision: 1, draft: retained }); await settle();
  f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('submitted', 1) })); assert.equal((await recovering).ok, true);
  assert.equal(f.state.getSnapshot().desired, 'newer'); assert.equal(f.state.getSnapshot().dirty, true);
  f.state.dispose();
});

test('unknown recovery stays blocked and a late reconciliation cannot revive a detached controller', async () => {
  const original = fixture(); await original.start(); original.state.edit('A'); const first = original.state.flush(); await settle();
  const retained = original.state.detach(); original.saves[0].next.resolve(failure()); await first;
  const lookup = deferred(); const f = fixture({ reconcile: () => lookup.promise }); await f.start();
  const recovering = f.state.recover({ revision: 1, draft: retained }); await settle(); f.state.detach();
  lookup.resolve(ok({ status: 'unknown', reason: 'unavailable' })); assert.equal((await recovering).ok, false);
  assert.equal(f.state.getSnapshot().status, 'detached'); assert.equal(f.saves.length, 0);
  assert.equal((await f.state.start()).ok, false); f.state.dispose(); assert.equal((await f.state.start()).ok, false);
});

test('preserve detaches synchronously even if checkpoint fails later', async () => {
  const write = deferred(); const f = fixture({ write: () => write.promise }); await f.start(); f.state.edit('keep');
  const closing = f.state.close({ pending: 'preserve' }); assert.equal(f.state.getSnapshot().status, 'detached'); assert.equal(f.subscriptions.size, 0);
  await f.clock.advance(100); assert.equal(f.saves.length, 0); write.resolve(failure()); assert.equal((await closing).ok, false);
  assert.equal(f.state.getSnapshot().status, 'detached'); assert.equal(f.state.getSnapshot().draft.desired, 'keep');
});

test('flush waits for the existing flight and the pending value present at invocation', async () => {
  const f = fixture(); await f.start(); f.state.edit('A'); await f.clock.advance(10); await settle(); f.state.edit('B');
  let complete = false; const flush = f.state.flush().then(result => { complete = true; return result; }); await settle(); assert.equal(complete, false);
  f.saves[0].next.resolve(ok({ status: 'saved', envelope: envelope('A', 1), operationId: f.saves[0].mutation.operationId })); await settle();
  assert.equal(f.saves.length, 2); assert.equal(f.saves[1].mutation.value, 'B'); assert.equal(complete, false);
  f.saves[1].next.resolve(ok({ status: 'saved', envelope: envelope('B', 2), operationId: f.saves[1].mutation.operationId })); assert.equal((await flush).ok, true);
  assert.equal(f.state.getSnapshot().desired, 'B'); f.state.dispose();
});

test('null defaults initialize and an existing initialization winner is adopted', async () => {
  const nullCodec = { encode: value => value, decode: value => value === null || typeof value === 'string' ? ok(value) : failure('invalid-input') };
  const f = fixture({ nullInitial: true, codec: nullCodec }); await f.start(); await f.clock.advance(10); await settle();
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].mutation.value, null); assert.equal(f.saves[0].mutation.kind, 'initialize');
  f.saves[0].next.resolve(ok({ status: 'already-initialized', current: { status: 'present', envelope: envelope('winner', 1) }, operationId: f.saves[0].mutation.operationId })); await settle(); await f.clock.advance(100); await settle();
  assert.equal(f.state.getSnapshot().desired, 'winner'); assert.equal(f.saves.length, 1); f.state.dispose();
});

test('duplicate and older invalidations do not reload; changes during a load coalesce', async () => {
  const f = fixture(); await f.start({ status: 'present', envelope: envelope('base', 3) }); const notify = [...f.subscriptions][0];
  for (let i = 0; i < 10; i++) notify({ address, version: version(3), operationId: null }); assert.equal(f.loads.length, 0);
  notify({ address, version: version(4), operationId: null }); const first = f.loads.shift();
  for (let i = 0; i < 10; i++) notify({ address, version: version(5), operationId: null }); assert.equal(f.loads.length, 0);
  first.resolve(ok({ status: 'present', envelope: envelope('four', 4) })); await settle(); assert.equal(f.loads.length, 1);
  f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('five', 5) })); await settle(); assert.equal(f.loads.length, 0); f.state.dispose();
});

test('a changed actor fences save completion and zero retry budget prevents resubmission', async () => {
  const f = fixture({ retryLimit: 0, reconcile: async () => ok({ status: 'absent-final', retry: 'same-operation-only' }) }); await f.start(); f.state.edit('original');
  const saving = f.state.flush(); await settle(); const mutation = f.saves[0].mutation;
  f.setSession({ status: 'unavailable', instanceId: 'instance-1', error: failure().error });
  f.saves[0].next.resolve(ok({ status: 'saved', envelope: envelope('original', 1), operationId: mutation.operationId })); assert.equal((await saving).ok, false);
  assert.equal(f.state.getSnapshot().status, 'blocked'); assert.equal(f.state.getSnapshot().draft.inFlight.operationId, mutation.operationId); f.state.dispose();
  const noRetry = fixture({ retryLimit: 0, reconcile: async () => ok({ status: 'absent-final', retry: 'same-operation-only' }) }); await noRetry.start(); noRetry.state.edit('A');
  const first = noRetry.state.flush(); await settle(); noRetry.saves[0].next.resolve(failure()); await first;
  assert.equal((await noRetry.state.flush()).ok, false); assert.equal(noRetry.saves.length, 1); noRetry.state.dispose();
});

test('close flush has a finite bound and retains an unresolved mutation', async () => {
  const f = fixture(); await f.start(); f.state.edit('slow'); const closing = f.state.close({ pending: 'flush' }); await settle();
  const mutation = f.saves[0].mutation; await f.clock.advance(30_000); assert.equal((await closing).ok, false);
  assert.equal(f.state.getSnapshot().status, 'detached'); assert.equal(f.state.getSnapshot().draft.inFlight.operationId, mutation.operationId);
  f.saves[0].next.resolve(ok({ status: 'saved', envelope: envelope('slow', 1), operationId: mutation.operationId })); await settle(); assert.equal(f.state.getSnapshot().status, 'detached');
});

test('new invalidation revokes an old conflict decision while the authoritative refresh is held', async () => {
  const f = fixture(); await f.start({ status: 'present', envelope: envelope('base', 1) }); f.state.edit('local');
  const first = f.state.reconnect(); f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('remote-r2', 2) })); await first;
  const token = f.state.getSnapshot().conflict.token;
  const notify = [...f.subscriptions][0]; notify({ address, version: version(3), operationId: null }); const held = f.loads.shift();
  const stale = await f.state.resolveConflict(token, { kind: 'accept-remote' });
  assert.equal(stale.ok, false); assert.equal(f.state.getSnapshot().draft.desired, 'local'); assert.equal(f.saves.length, 0);
  notify({ address, version: version(4), operationId: null }); held.resolve(ok({ status: 'present', envelope: envelope('remote-r3', 3) })); await settle();
  assert.equal(f.state.getSnapshot().conflict, null); assert.equal(f.loads.length, 1);
  f.loads.shift().resolve(ok({ status: 'present', envelope: envelope('remote-r4', 4) })); await settle();
  const reviewed = f.state.getSnapshot().conflict; assert.notEqual(reviewed.token, token); assert.equal(reviewed.remote.envelope.value, 'remote-r4');
  assert.equal((await f.state.resolveConflict(reviewed.token, { kind: 'accept-remote' })).ok, true); assert.equal(f.state.getSnapshot().desired, 'remote-r4'); f.state.dispose();
});
