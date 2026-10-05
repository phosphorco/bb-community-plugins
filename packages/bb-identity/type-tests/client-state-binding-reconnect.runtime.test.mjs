import assert from 'node:assert/strict';
import test from 'node:test';
import { bindIdentityState } from '../client-state-binding-runtime.ts';
import { createIdentityView } from '../client-view-runtime.ts';

const ok = (value) => ({ ok: true, value });
const unavailable = () => ({ ok: false, error: { code: 'unavailable', message: 'offline', retry: 'after-refresh' } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
const person = (subject) => ({ kind: 'person', key: `issuer:${subject}`, issuer: 'issuer', subject });
const session = (subject, stamp) => ({
  status: 'ready', instanceId: 'host', mode: 'multi-user', stamp,
  actor: { identity: person(subject), presentation: { displayName: subject, handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: true, lookup: true }, participants: false, externalSend: 'structured', toolProvenance: 'unknown', operationLookup: true },
});

function fixture() {
  let current = session('a', 'a1');
  const clientListeners = new Set();
  const healthListeners = new Set();
  const state = { generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } };
  let revalidationGate = null;
  let revalidations = 0;
  const controllers = [];
  const connection = {
    getHealth: () => state,
    subscribeHealth(listener) { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    subscribe() { return () => {}; },
    async revalidate() {
      revalidations += 1;
      if (revalidationGate !== null) {
        const gate = revalidationGate; revalidationGate = null; gate.entered.resolve();
        return gate.release.promise;
      }
      return ok(undefined);
    },
    dispose() { throw new Error('borrowed connection'); },
  };
  const client = {
    connection,
    getSnapshot: () => current,
    currentSession: () => ok(current),
    subscribe(listener) { clientListeners.add(listener); return () => clientListeners.delete(listener); },
    dispose() { throw new Error('borrowed client'); },
    directory: { getMany: async () => ok([]) },
  };
  const view = createIdentityView({ client });
  const binding = bindIdentityState({
    client, view, target: 'viewed-subject', editPolicy: 'actor-only', onUnpersistedDraft() {},
    create({ subject, ownerSession }) {
      const listeners = new Set();
      const snapshot = {
        status: 'ready',
        address: { instanceId: 'host', pluginId: 'feature', collection: 'sections', recordId: 'sidebar', owner: subject.key },
        ownerSession, acknowledged: { status: 'empty', address: { instanceId: 'host', pluginId: 'feature', collection: 'sections', recordId: 'sidebar', owner: subject.key }, version: { epoch: 'e', sequence: 0 } },
        desired: 'draft-a', dirty: true, saving: false, localGeneration: 1, remotePending: false,
      };
      const controller = {
        reconnectCalls: 0, nextReconnect: ok(undefined), snapshot,
        getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        start: async () => ok(undefined), edit: () => ok(undefined), suspendAutomaticDispatch: () => () => {}, flush: async () => ok(undefined),
        async reconnect() { controller.reconnectCalls += 1; return controller.nextReconnect; },
        resolveConflict: async () => ok(undefined), recover: async () => ok(undefined), discardRecovery: async () => ok(undefined), recoveryCandidates: async () => ok([]), checkpoint: async () => ok(null),
        detach: () => null, close: async () => ok(undefined), dispose() {},
      };
      controllers.push(controller);
      return controller;
    },
  });
  return {
    binding, view, controllers,
    pauseRevalidation() { revalidationGate = { entered: deferred(), release: deferred() }; return revalidationGate; },
    revalidations: () => revalidations,
    replaceSession(next) { current = next; for (const listener of [...clientListeners]) listener(); },
    close() { binding.dispose(); view.dispose(); },
  };
}

/** This path uses bindIdentityState's resource branch and the real state
 * controller/transport. The small fixture only controls durable route timing. */
function realFixture() {
  let current = session('a', 'a1');
  const clientListeners = new Set();
  const healthListeners = new Set();
  const events = new Set();
  const health = { generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } };
  const records = new Map(); const receipts = new Map(); const saves = []; const reconciles = [];
  const checkpoints = new Map(); let failDraftWrites = false; let saveMode = 'saved'; let lookup = { status: 'final' };
  let loadGate = null; let lookupGate = null; let revalidations = 0; let clock = 0; const timers = new Set();
  const scheduler = { now: () => clock, schedule(delay, callback) { const timer = { at: clock + delay, callback }; timers.add(timer); return () => timers.delete(timer); } };
  const addressKey = (address) => JSON.stringify(address);
  const empty = (address) => ({ status: 'empty', address, version: { epoch: 'epoch', sequence: 0 } });
  const read = (address) => records.get(addressKey(address)) ?? empty(address);
  const connection = {
    getHealth: () => health,
    subscribeHealth(listener) { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    async revalidate() { revalidations += 1; return ok(undefined); },
    async request(method, input) {
      if (method.endsWith('/load')) {
        if (loadGate !== null) { const gate = loadGate; loadGate = null; gate.entered.resolve(); await gate.release.promise; }
        return ok(structuredClone(read(input.address)));
      }
      if (method.endsWith('/reconcile')) {
        reconciles.push(structuredClone(input));
        if (lookupGate !== null) { const gate = lookupGate; lookupGate = null; gate.entered.resolve(); await gate.release.promise; }
        if (lookup.status !== 'final') return ok(lookup);
        return ok(receipts.get(input.operationId) ? { status: 'final', outcome: receipts.get(input.operationId) } : { status: 'absent-final', retry: 'same-operation-only' });
      }
      if (!method.endsWith('/save')) throw new Error(`Unknown state route ${method}`);
      saves.push(structuredClone(input));
      const before = read(input.address); const version = before.status === 'present' ? before.envelope.version : before.version;
      if (JSON.stringify(version) !== JSON.stringify(input.expectedVersion)) return ok({ status: 'conflict', current: before, operationId: input.operationId });
      const envelope = { address: input.address, version: { epoch: 'epoch', sequence: version.sequence + 1 }, schemaVersion: 1, value: input.value, lastEditedBy: current.actor };
      const outcome = { status: 'saved', envelope, operationId: input.operationId };
      records.set(addressKey(input.address), { status: 'present', envelope }); receipts.set(input.operationId, outcome);
      return saveMode === 'lost-accepted' ? unavailable() : ok(outcome);
    },
    dispose() { throw new Error('borrowed connection'); },
  };
  const client = {
    connection, getSnapshot: () => current, currentSession: () => ok(current),
    subscribe(listener) { clientListeners.add(listener); return () => clientListeners.delete(listener); },
    dispose() { throw new Error('borrowed client'); }, directory: { getMany: async () => ok([]) },
  };
  const drafts = {
    async write(draft) {
      if (failDraftWrites) return unavailable();
      const key = JSON.stringify(draft.key); const checkpoint = { revision: (checkpoints.get(key)?.revision ?? 0) + 1, draft: structuredClone(draft) };
      checkpoints.set(key, checkpoint); return ok(checkpoint);
    },
    async find(address, actor) { return ok([...checkpoints.values()].filter((entry) => addressKey(entry.draft.key.address) === addressKey(address) && entry.draft.key.actor === actor)); },
    async remove(key, revision) { const entry = checkpoints.get(JSON.stringify(key)); if (entry?.revision === revision) checkpoints.delete(JSON.stringify(key)); return ok(undefined); },
  };
  const view = createIdentityView({ client });
  const binding = bindIdentityState({
    client, view, target: 'viewed-subject', editPolicy: 'actor-only', onUnpersistedDraft() {},
    resource: { pluginId: 'feature', definition: { collection: 'sections', schemaVersion: 1, codec: { decode: (value) => typeof value === 'string' ? ok(value) : { ok: false, error: { code: 'invalid-input', message: 'string', retry: 'never' } }, encode: (value) => value }, initialValue: () => '', equal: (left, right) => left === right } },
    recordId: 'sidebar', drafts, onConflict: () => ({ kind: 'needs-review', reason: 'review' }), initializeEmpty: false, scheduler,
  });
  return {
    binding, view, saves, reconciles, checkpoints,
    owner: () => binding.currentOwnerSession(),
    revalidations: () => revalidations,
    setFailDraftWrites(value) { failDraftWrites = value; },
    setSaveMode(value) { saveMode = value; },
    setLookup(value) { lookup = value; },
    holdNextLoad() { loadGate = { entered: deferred(), release: deferred() }; return loadGate; },
    holdNextLookup() { lookupGate = { entered: deferred(), release: deferred() }; return lookupGate; },
    replaceSession(next) { current = next; for (const listener of [...clientListeners]) listener(); },
    async advance(milliseconds) { clock += milliseconds; for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.callback(); } await settle(); },
    close() { binding.dispose(); view.dispose(); },
  };
}

test('binding reconnect coalesces the full verification and recovery sequence for one owner', async () => {
  const f = fixture(); await settle();
  const owner = f.binding.currentOwnerSession();
  const gate = f.pauseRevalidation();
  const first = f.binding.reconnect(owner);
  const second = f.binding.reconnect(owner);
  await gate.entered.promise;
  assert.equal(f.revalidations(), 1);
  assert.equal(f.controllers[0].reconnectCalls, 0);
  gate.release.resolve(ok(undefined));
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(f.controllers[0].reconnectCalls, 1);
  f.close();
});

test('a replacement owner fences a held revalidation before controller recovery', async () => {
  const f = fixture(); await settle();
  const oldOwner = f.binding.currentOwnerSession();
  const oldController = f.controllers[0];
  const gate = f.pauseRevalidation();
  const reconnecting = f.binding.reconnect(oldOwner);
  await gate.entered.promise;
  f.replaceSession(session('b', 'b1')); await settle();
  gate.release.resolve(ok(undefined));
  const result = await reconnecting;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'stale-context');
  assert.equal(oldController.reconnectCalls, 0);
  assert.notEqual(f.binding.currentOwnerSession(), oldOwner);
  f.close();
});

test('a transient reconciliation failure retains the same desired draft for an explicit retry', async () => {
  const f = fixture(); await settle();
  const owner = f.binding.currentOwnerSession();
  const controller = f.controllers[0];
  controller.nextReconnect = unavailable();
  const failed = await f.binding.reconnect(owner);
  assert.equal(failed.ok, false);
  assert.equal(f.binding.getSnapshot().desired, 'draft-a');
  controller.nextReconnect = ok(undefined);
  const recovered = await f.binding.reconnect(owner);
  assert.equal(recovered.ok, true);
  assert.equal(controller.reconnectCalls, 2);
  assert.equal(f.binding.getSnapshot().desired, 'draft-a');
  f.close();
});

test('real resource reconnect waits through a held reload and coalesces a caller arriving after verification', async () => {
  const f = realFixture(); await settle();
  const owner = f.owner(); const gate = f.holdNextLoad();
  const first = f.binding.reconnect(owner); await gate.entered.promise;
  const second = f.binding.reconnect(owner);
  assert.equal(f.revalidations(), 1);
  gate.release.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(f.revalidations(), 1);
  f.close();
});

test('real resource retry after transient draft persistence failure retains desired intent and sends one save', async () => {
  const f = realFixture(); await settle();
  const owner = f.owner(); f.setFailDraftWrites(true);
  assert.equal(f.binding.edit('preserve-me').ok, true);
  assert.equal((await f.binding.flush()).ok, false);
  const blocked = f.binding.getSnapshot();
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.draft.desired, 'preserve-me'); assert.equal(f.saves.length, 0);
  f.setFailDraftWrites(false);
  assert.equal((await f.binding.reconnect(owner)).ok, true);
  await f.advance(300);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].value, 'preserve-me');
  assert.equal(f.binding.getSnapshot().status, 'ready');
  assert.equal(f.binding.getSnapshot().desired, 'preserve-me');
  f.close();
});

test('real resource reconciles a lost accepted response by exact receipt without a duplicate save', async () => {
  const f = realFixture(); await settle();
  const owner = f.owner(); f.setSaveMode('lost-accepted');
  assert.equal(f.binding.edit('accepted').ok, true);
  assert.equal((await f.binding.flush()).ok, false);
  assert.equal(f.saves.length, 1);
  const operationId = f.saves[0].operationId;
  f.setSaveMode('saved');
  assert.equal((await f.binding.reconnect(owner)).ok, true);
  assert.equal(f.reconciles.length, 1);
  assert.equal(f.reconciles[0].operationId, operationId);
  assert.equal(f.saves.length, 1);
  assert.equal(f.binding.getSnapshot().desired, 'accepted');
  f.close();
});

test('real resource keeps pending, unknown, and absent-final receipts blocked without replacement saves', async () => {
  for (const unresolved of [
    { status: 'pending' },
    { status: 'unknown', reason: 'unavailable' },
    { status: 'absent-final', retry: 'same-operation-only' },
  ]) {
    const f = realFixture(); await settle();
    const owner = f.owner(); f.setSaveMode('lost-accepted'); f.setLookup(unresolved);
    assert.equal(f.binding.edit('unknown').ok, true);
    assert.equal((await f.binding.flush()).ok, false);
    assert.equal((await f.binding.reconnect(owner)).ok, false);
    assert.equal(f.saves.length, 1, unresolved.status);
    f.close();
  }
});

test('real resource fences a held receipt lookup when the actor changes before it settles', async () => {
  const f = realFixture(); await settle();
  const owner = f.owner(); f.setSaveMode('lost-accepted');
  assert.equal(f.binding.edit('a-only').ok, true);
  assert.equal((await f.binding.flush()).ok, false);
  const gate = f.holdNextLookup();
  const reconnecting = f.binding.reconnect(owner); await gate.entered.promise;
  f.replaceSession(session('b', 'b1')); await settle(); gate.release.resolve();
  const result = await reconnecting;
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'stale-context');
  assert.equal(f.saves.length, 1);
  assert.notEqual(f.owner(), owner);
  f.close();
});

test('real resource fences a held authoritative reload when the actor changes', async () => {
  const f = realFixture(); await settle();
  const owner = f.owner(); const gate = f.holdNextLoad();
  const reconnecting = f.binding.reconnect(owner); await gate.entered.promise;
  f.replaceSession(session('b', 'b1')); await settle(); gate.release.resolve();
  const result = await reconnecting;
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'stale-context');
  assert.notEqual(f.owner(), owner);
  f.close();
});
