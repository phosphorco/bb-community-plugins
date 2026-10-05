import { expect, test } from 'bun:test';
import { bindIdentityState } from '../client-state-binding-runtime.ts';
import { createIdentityView } from '../client-view-runtime.ts';

const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: code, retry: 'never' } });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const person = subject => ({ kind: 'person', key: `issuer:${subject}`, issuer: 'issuer', subject });
const session = (subject, stamp) => ({ status: 'ready', instanceId: 'host', mode: 'multi-user', stamp,
  actor: { identity: person(subject), presentation: { displayName: subject, handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: true, lookup: true }, participants: false, externalSend: 'structured', toolProvenance: 'unknown', operationLookup: true } });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fixture(target = 'viewed-subject') {
  let current = session('a', 'a1'); const subscribers = new Set(); const events = new Set(); const healthSubscribers = new Set();
  const records = new Map(); const receipts = new Map(); const checkpoints = new Map(); const lost = []; const saves = [];
  let saveGate = null; let draftGate = null; let lookupGate = null; let failDrafts = false; let failRemoval = false; let draftWrites = 0;
  let clock = 0; const timers = new Set();
  const scheduler = { now: () => clock, schedule(delay, callback) { const timer = { at: clock + delay, callback }; timers.add(timer); return () => timers.delete(timer); } };
  const health = { generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } };
  const addressKey = a => JSON.stringify(a);
  const read = address => records.get(addressKey(address)) ?? { status: 'empty', address, version: { epoch: 'e', sequence: 0 } };
  const connection = {
    getHealth: () => health, subscribeHealth: fn => { healthSubscribers.add(fn); return () => healthSubscribers.delete(fn); },
    subscribe: fn => { events.add(fn); return () => events.delete(fn); }, revalidate: async () => ok(undefined), dispose() { throw Error('borrowed connection'); },
    async request(method, input) {
      if (method.endsWith('/load')) return ok(structuredClone(read(input.address)));
      if (method.endsWith('/reconcile')) return ok(receipts.get(input.operationId) ? { status: 'final', outcome: receipts.get(input.operationId) } : { status: 'absent-final', retry: 'same-operation-only' });
      if (!method.endsWith('/save')) throw Error('unknown route');
      saves.push(structuredClone(input));
      const before = read(input.address); const version = before.status === 'present' ? before.envelope.version : before.version;
      if (JSON.stringify(version) !== JSON.stringify(input.expectedVersion)) return ok({ status: 'conflict', current: before, operationId: input.operationId });
      const envelope = { address: input.address, version: { epoch: 'e', sequence: version.sequence + 1 }, schemaVersion: 1, value: input.value, lastEditedBy: current.actor };
      const outcome = { status: 'saved', envelope, operationId: input.operationId }; records.set(addressKey(input.address), { status: 'present', envelope }); receipts.set(input.operationId, outcome);
      if (saveGate) { const gate = saveGate; saveGate = null; gate.entered.resolve(); await gate.release.promise; }
      return ok(outcome);
    },
  };
  const client = {
    connection, getSnapshot: () => current, currentSession: () => ok(current),
    subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn); }, dispose() { throw Error('borrowed client'); },
    directory: { async getMany({ keys }) { return ok(keys.map(key => ({ key, status: 'found', profile: { identity: person(key.split(':')[1]), presentation: { displayName: key, handle: null, avatarUrl: null }, status: 'current', revision: 'r' } }))); } },
  };
  const drafts = {
    async write(draft) {
      draftWrites++;
      if (draftGate) { const gate = draftGate; draftGate = null; gate.entered.resolve(); await gate.release.promise; }
      if (failDrafts) return failure('unavailable');
      const key = JSON.stringify(draft.key); const checkpoint = { revision: (checkpoints.get(key)?.revision ?? 0) + 1, draft: structuredClone(draft) };
      checkpoints.set(key, checkpoint); return ok(checkpoint);
    },
    async find(address, actor) {
      if (lookupGate) { const gate = lookupGate; lookupGate = null; gate.entered.resolve(); await gate.release.promise; }
      return ok([...checkpoints.values()].filter(c => addressKey(c.draft.key.address) === addressKey(address) && c.draft.key.actor === actor));
    },
    async remove(key, revision) { if (failRemoval) return failure('unavailable'); const k = JSON.stringify(key); if (checkpoints.get(k)?.revision === revision) checkpoints.delete(k); return ok(undefined); },
  };
  const view = createIdentityView({ client });
  const binding = bindIdentityState({ client, view, target, editPolicy: 'actor-only', onUnpersistedDraft: (draft, error) => lost.push({ draft, error }),
    resource: { pluginId: 'feature', definition: { collection: 'sections', schemaVersion: 1, codec: { decode: x => typeof x === 'string' ? ok(x) : failure('invalid-input'), encode: x => x }, initialValue: () => '', equal: (a,b) => a === b } },
    recordId: 'thread-sections', drafts, onConflict: () => ({ kind: 'needs-review', reason: 'review' }), initializeEmpty: false,
    scheduler,
  });
  return { binding, view, client, lost, saves, checkpoints, get draftWrites() { return draftWrites; },
    setSession(next) { current = next; for (const fn of [...subscribers]) fn(); },
    pauseSave() { saveGate = { entered: deferred(), release: deferred() }; return saveGate; },
    pauseDraft() { draftGate = { entered: deferred(), release: deferred() }; return draftGate; },
    pauseLookup() { lookupGate = { entered: deferred(), release: deferred() }; return lookupGate; },
    failDrafts() { failDrafts = true; },
    failRemoval() { failRemoval = true; },
    async advance(ms) { clock += ms; for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.callback(); } await settle(); },
    close() { binding.dispose(); view.dispose(); },
  };
}

test('resource binding writes self, preserves on view change and makes viewed state read-only', async () => {
  const f = fixture(); await settle(); const old = f.binding.currentOwnerSession();
  expect(f.binding.getSnapshot().status).toBe('ready'); expect(f.binding.edit('saved').ok).toBe(true); expect((await f.binding.flush()).ok).toBe(true);
  expect(f.saves[0].address.owner).toBe('issuer:a');
  f.binding.edit('pending'); expect((await f.view.select({ kind: 'person', key: 'issuer:b' })).ok).toBe(false);
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'preserve' })).ok).toBe(true); await settle();
  expect(f.binding.getSnapshot().address.owner).toBe('issuer:b'); expect(f.binding.edit('foreign').ok).toBe(false); expect(f.saves).toHaveLength(1);
  expect([...f.checkpoints.values()].some(c => c.draft.desired === 'pending' && c.draft.key.actor === 'issuer:a')).toBe(true);
  expect((await f.view.reset()).ok).toBe(true); await settle(); expect(f.binding.currentOwnerSession()).not.toBe(old);
  expect(f.binding.getSnapshot().desired).toBe('saved'); expect((await f.binding.checkpoint(old)).ok).toBe(false);
  const owner = f.binding.currentOwnerSession(); const candidates = await f.binding.recoveryCandidates(owner);
  expect(candidates.ok).toBe(true); const pending = candidates.value.find(c => c.draft.desired === 'pending'); expect(pending).toBeDefined();
  expect((await f.binding.recover(owner, pending)).ok).toBe(true); expect(f.binding.getSnapshot().desired).toBe('pending');
  expect((await f.binding.flush()).ok).toBe(true); expect(f.saves[1].ownerSession).toBe(owner); expect(f.saves[1].expected.actor).toBe('issuer:a'); f.close();
});

test('actor change detaches a held accepted save and fences its late acknowledgment', async () => {
  const f = fixture(); await settle(); const old = f.binding.currentOwnerSession(); const gate = f.pauseSave();
  f.binding.edit('a-value'); const flushing = f.binding.flush(); await gate.entered.promise;
  f.setSession(session('b', 'b1')); await settle(); expect(f.binding.currentOwnerSession()).not.toBe(old); expect(f.binding.getSnapshot().address.owner).toBe('issuer:b');
  gate.release.resolve(); expect((await flushing).ok).toBe(false); await settle(); expect(f.binding.getSnapshot().desired).toBe('');
  expect(f.saves).toHaveLength(1); expect([...f.checkpoints.values()].some(c => c.draft.key.actor === 'issuer:a' && c.draft.inFlight?.value === 'a-value')).toBe(true); f.close();
});

test('guard rejection does not checkpoint or discard and cancelled preservation keeps ownership', async () => {
  const f = fixture(); await settle(); f.binding.edit('a-draft'); const owner = f.binding.currentOwnerSession();
  const reject = f.view.registerGuard({ inspect: () => failure('conflict'), invalidate() {} });
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'preserve' })).ok).toBe(false); expect(f.draftWrites).toBe(0); reject();
  const gate = f.pauseDraft(); const changing = f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'preserve' }); await gate.entered.promise;
  expect(f.binding.edit('during-transition').ok).toBe(false); expect((await f.view.reset()).ok).toBe(true); expect((await changing).ok).toBe(false);
  gate.release.resolve(); await settle(); expect(f.binding.currentOwnerSession()).toBe(owner); expect(f.binding.edit('newer').ok).toBe(true); f.close();
});

test('mandatory identity loss preserves synchronously detached draft and reports failed persistence', async () => {
  const f = fixture(); await settle(); f.binding.edit('keep-me'); f.failDrafts();
  f.setSession({ status: 'unavailable', instanceId: 'host', error: { code: 'unavailable', message: 'offline', retry: 'after-refresh' } });
  expect(f.binding.getSnapshot().status).toBe('detached'); expect(f.binding.edit('forbidden').ok).toBe(false);
  await settle(); expect(f.lost).toHaveLength(1); expect(f.lost[0].draft.desired).toBe('keep-me'); expect(f.saves).toHaveLength(0); f.close();
});

test('actor-target binding survives voluntary view changes and fences old recovery results', async () => {
  const f = fixture('actor'); await settle(); const owner = f.binding.currentOwnerSession(); f.binding.edit('personal');
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' })).ok).toBe(true); expect(f.binding.currentOwnerSession()).toBe(owner);
  const gate = f.pauseLookup(); const candidates = f.binding.recoveryCandidates(owner); await gate.entered.promise;
  f.setSession(session('b', 'b1')); gate.release.resolve(); expect((await candidates).ok).toBe(false); await settle();
  expect(f.binding.getSnapshot().address.owner).toBe('issuer:b'); f.close();
});

test('disposed borrowed view cannot revive a state controller on a later client session', async () => {
  const f = fixture(); await settle(); f.binding.edit('retained'); f.view.dispose();
  expect(f.binding.getSnapshot().status).toBe('detached'); expect(f.binding.currentOwnerSession()).toBe(null);
  f.setSession(session('b', 'b2')); await settle(); expect(f.binding.currentOwnerSession()).toBe(null);
  expect(f.binding.edit('late').ok).toBe(false); expect(f.saves).toHaveLength(0); f.binding.dispose();
});

test('reentrant session change during detach cannot install a stale replacement controller', async () => {
  const f = fixture(); await settle(); let changed = false;
  const stop = f.binding.subscribe(() => {
    if (!changed && f.binding.getSnapshot().status === 'detached') { changed = true; f.setSession(session('c', 'c1')); }
  });
  f.setSession(session('b', 'b1')); await settle();
  expect(f.binding.getSnapshot().address.owner).toBe('issuer:c'); expect(f.binding.edit('c-value').ok).toBe(true);
  expect((await f.binding.flush()).ok).toBe(true); expect(f.saves[0].expected.actor).toBe('issuer:c'); stop(); f.close();
});

test('reset requested by a detach subscriber commits a coherent view and controller', async () => {
  const f = fixture(); await settle(); f.binding.edit('keep-a'); let reset = null;
  const stop = f.binding.subscribe(() => { if (!reset && f.binding.getSnapshot().status === 'detached') reset = f.view.reset(); });
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'preserve' })).ok).toBe(true);
  expect((await reset).ok).toBe(true); await settle(); expect(f.view.getSnapshot().subject.key).toBe('issuer:a');
  expect(f.binding.getSnapshot().address.owner).toBe('issuer:a'); expect(f.binding.edit('new-a').ok).toBe(true);
  const candidates = await f.binding.recoveryCandidates(f.binding.currentOwnerSession()); expect(candidates.value.some(c => c.draft.desired === 'keep-a')).toBe(true); stop(); f.close();
});

test('held discard preparation pauses debounce and cancellation resumes retained edits', async () => {
  const f = fixture(); await settle(); f.binding.edit('not-yet'); const gate = deferred(); const entered = deferred();
  const stop = f.view.registerGuard({ inspect: () => ok({ prepare() { entered.resolve(); return gate.promise; }, commit() {}, cancel() {} }), invalidate() {} });
  const changing = f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'discard' }); await entered.promise;
  await f.advance(500); expect(f.saves).toHaveLength(0); expect((await f.view.reset()).ok).toBe(true); expect((await changing).ok).toBe(false);
  gate.resolve(ok(undefined)); await f.advance(300); expect(f.saves).toHaveLength(1); expect(f.saves[0].value).toBe('not-yet'); stop(); f.close();
});

test('discard removes an older checkpoint even after edits revert to acknowledged value', async () => {
  const f = fixture(); await settle(); f.binding.edit('old-x'); await f.binding.checkpoint(f.binding.currentOwnerSession()); f.binding.edit('');
  expect(f.binding.getSnapshot().dirty).toBe(false);
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'discard' })).ok).toBe(true);
  expect((await f.view.reset()).ok).toBe(true); await settle();
  expect((await f.binding.recoveryCandidates(f.binding.currentOwnerSession())).value).toEqual([]); f.close();
});

test('recovery waits for unfinished preservation across actor ABA under a new session', async () => {
  const f = fixture(); await settle(); f.binding.edit('late-a'); const gate = f.pauseDraft();
  f.setSession(session('b', 'b1')); await gate.entered.promise; f.setSession(session('a', 'a2')); await settle();
  let finished = false; const reading = f.binding.recoveryCandidates(f.binding.currentOwnerSession()).then(value => { finished = true; return value; });
  await settle(); expect(finished).toBe(false); gate.release.resolve(); const result = await reading;
  expect(result.ok).toBe(true); expect(result.value.some(c => c.draft.desired === 'late-a')).toBe(true); f.close();
});

test('an automatic save still awaiting its checkpoint cannot dispatch during preparation', async () => {
  const f = fixture(); await settle(); const checkpoint = f.pauseDraft(); f.binding.edit('auto-pending'); await f.advance(300); await checkpoint.entered.promise;
  const gate = deferred(); const entered = deferred();
  const stop = f.view.registerGuard({ inspect: () => ok({ prepare() { entered.resolve(); return gate.promise; }, commit() {}, cancel() {} }), invalidate() {} });
  const changing = f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'discard' }); await entered.promise;
  checkpoint.release.resolve(); await settle(); expect(f.saves).toHaveLength(0);
  gate.resolve(ok(undefined)); expect((await changing).ok).toBe(true); await f.advance(1000); expect(f.saves).toHaveLength(0); stop(); f.close();
});

test('discard preserves a concurrently newer checkpoint and reports conditional removal failures', async () => {
  const f = fixture(); await settle(); f.binding.edit('old');
  expect((await f.binding.checkpoint(f.binding.currentOwnerSession())).ok).toBe(true);
  const [key, checkpoint] = [...f.checkpoints.entries()][0];
  f.checkpoints.set(key, { ...checkpoint, revision: checkpoint.revision + 1,
    draft: { ...checkpoint.draft, desired: 'newer-other-writer' } });
  f.binding.edit('');
  expect((await f.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'discard' })).ok).toBe(true);
  await settle(); expect(f.checkpoints.get(key).draft.desired).toBe('newer-other-writer'); f.close();

  const g = fixture(); await settle(); g.binding.edit('cannot-remove');
  expect((await g.binding.checkpoint(g.binding.currentOwnerSession())).ok).toBe(true);
  g.failRemoval();
  expect((await g.view.select({ kind: 'person', key: 'issuer:b' }, { pendingEdits: 'discard' })).ok).toBe(true);
  await settle(); expect(g.lost).toHaveLength(1); expect(g.lost[0].error.code).toBe('unavailable');
  expect([...g.checkpoints.values()][0].draft.desired).toBe('cannot-remove'); g.close();
});
