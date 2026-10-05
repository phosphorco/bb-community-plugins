import { expect, test } from 'bun:test';
import { bindIdentityState } from '../client-state-binding-runtime.ts';
import { createIdentityView } from '../client-view-runtime.ts';
import { createDraftRetirementOwner } from '../draft-retirement-runtime.ts';

const ok = value => ({ ok: true, value });
const failure = (code = 'unavailable') => ({ ok: false, error: { code, message: code, retry: 'after-refresh' } });
const deferred = () => { let resolve; const promise = new Promise(next => { resolve = next; }); return { promise, resolve }; };
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };
const person = { kind: 'person', key: 'issuer:a', issuer: 'issuer', subject: 'a' };
const session = { status: 'ready', instanceId: 'remount-instance', mode: 'multi-user', stamp: 'a1',
  actor: { identity: person, presentation: { displayName: 'A', handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true },
};
const codec = { decode: value => typeof value === 'string' ? ok(value) : { ok: false, error: { code: 'invalid-input', message: 'string required', retry: 'never' } }, encode: value => value };
const resource = { pluginId: 'feature', definition: { collection: 'preferences', schemaVersion: 1, codec, initialValue: () => '', equal: (left, right) => left === right } };

function sharedFixture() {
  const events = new Set(); const listeners = new Set(); const checkpoints = new Map();
  let pausedWrite = null;
  const connection = {
    getHealth: () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } }),
    subscribeHealth: () => () => {}, subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    async revalidate() { return ok(undefined); }, dispose() { throw new Error('borrowed connection'); },
    async request(method, input) {
      if (method.endsWith('/load')) return ok({ status: 'empty', address: input.address, version: { epoch: 'remount', sequence: 0 } });
      if (method.endsWith('/reconcile')) return ok({ status: 'absent-final', retry: 'same-operation-only' });
      throw new Error(`unexpected request ${method}`);
    },
  };
  const client = {
    connection, getSnapshot: () => session, currentSession: () => ok(session),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { throw new Error('borrowed client'); },
    directory: { async getMany({ keys }) { return ok(keys.map(key => ({ key, status: 'missing' }))); } },
  };
  const drafts = {
    async write(draft) {
      if (pausedWrite) { const gate = pausedWrite; pausedWrite = null; gate.entered.resolve(); await gate.release.promise; if (gate.fail) return failure(); }
      const key = JSON.stringify(draft.key); const checkpoint = { revision: (checkpoints.get(key)?.revision ?? 0) + 1, draft: structuredClone(draft) };
      checkpoints.set(key, checkpoint); return ok(checkpoint);
    },
    async find(address, actor) {
      return ok([...checkpoints.values()].filter(checkpoint => JSON.stringify(checkpoint.draft.key.address) === JSON.stringify(address) && checkpoint.draft.key.actor === actor));
    },
    async remove() { return ok(undefined); },
  };
  return {
    client, drafts,
    pauseNextDraftWrite(options = {}) { pausedWrite = { entered: deferred(), release: deferred(), fail: options.fail === true }; return pausedWrite; },
  };
}

function mount(shared, retirementOwner, onUnpersistedDraft = () => {}) {
  const view = createIdentityView({ client: shared.client });
  const binding = bindIdentityState({ client: shared.client, view, target: 'actor', editPolicy: 'actor-only', resource, recordId: 'appearance', drafts: shared.drafts,
    onConflict: () => ({ kind: 'needs-review', reason: 'remount' }), onUnpersistedDraft, initializeEmpty: false }, retirementOwner);
  return { binding, view, close() { binding.dispose(); view.dispose(); } };
}

test('shared retirement owner makes replacement recovery await an unmounted binding write', async () => {
  const shared = sharedFixture(); const owner = createDraftRetirementOwner(); const a = mount(shared, owner); await settle();
  try {
    expect(a.binding.edit('preserve-a').ok).toBe(true);
    const gate = shared.pauseNextDraftWrite();
    a.binding.dispose();
    await gate.entered.promise;

    const b = mount(shared, owner); await settle();
    try {
      const ownerB = b.binding.currentOwnerSession();
      let settled = false;
      const recovery = b.binding.recoveryCandidates(ownerB).then(result => { settled = true; return result; });
      await settle(); expect(settled).toBe(false);

      gate.release.resolve(); await settle();
      const result = await recovery;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.map(candidate => candidate.draft.desired)).toEqual(['preserve-a']);
    } finally { b.close(); }
  } finally { a.view.dispose(); owner.dispose(); }
});

test('recovery caller cancellation does not cancel the shared preservation write', async () => {
  const shared = sharedFixture(); const owner = createDraftRetirementOwner(); const a = mount(shared, owner); await settle();
  try {
    expect(a.binding.edit('preserve-after-cancel').ok).toBe(true);
    const gate = shared.pauseNextDraftWrite(); a.binding.dispose(); await gate.entered.promise;
    const b = mount(shared, owner); await settle();
    try {
      const caller = new AbortController();
      const recovery = b.binding.recoveryCandidates(b.binding.currentOwnerSession(), { signal: caller.signal });
      await settle(); caller.abort();
      const cancelled = await recovery;
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok) expect(cancelled.error.code).toBe('cancelled');

      gate.release.resolve(); await settle();
      const retained = await b.binding.recoveryCandidates(b.binding.currentOwnerSession());
      expect(retained.ok).toBe(true);
      if (retained.ok) expect(retained.value.map(candidate => candidate.draft.desired)).toEqual(['preserve-after-cancel']);
    } finally { b.close(); }
  } finally { a.view.dispose(); owner.dispose(); }
});

test('a separate root owner stays independent of another root preservation wait', async () => {
  const shared = sharedFixture(); const rootA = createDraftRetirementOwner(); const rootB = createDraftRetirementOwner();
  const a = mount(shared, rootA); await settle();
  try {
    expect(a.binding.edit('other-root').ok).toBe(true);
    const gate = shared.pauseNextDraftWrite(); a.binding.dispose(); await gate.entered.promise;
    const b = mount(shared, rootB); await settle();
    try {
      const immediate = await b.binding.recoveryCandidates(b.binding.currentOwnerSession());
      expect(immediate.ok).toBe(true);
      if (immediate.ok) expect(immediate.value).toEqual([]);
      gate.release.resolve(); await settle();
      const persisted = await b.binding.recoveryCandidates(b.binding.currentOwnerSession());
      expect(persisted.ok).toBe(true);
      if (persisted.ok) expect(persisted.value.map(candidate => candidate.draft.desired)).toEqual(['other-root']);
    } finally { b.close(); }
  } finally { a.view.dispose(); rootA.dispose(); rootB.dispose(); }
});

test('failed newer preservation does not hide an older durable recovery candidate', async () => {
  const shared = sharedFixture(); const owner = createDraftRetirementOwner(); const failures = [];
  const older = mount(shared, owner); await settle();
  const newer = mount(shared, owner, (draft, error) => failures.push({ draft, error }));
  try {
    expect(older.binding.edit('older-durable').ok).toBe(true);
    expect((await older.binding.checkpoint(older.binding.currentOwnerSession())).ok).toBe(true);
    expect(newer.binding.edit('newer-fails').ok).toBe(true);
    const gate = shared.pauseNextDraftWrite({ fail: true }); newer.binding.dispose(); await gate.entered.promise;

    const replacement = mount(shared, owner); await settle();
    try {
      const waiting = replacement.binding.recoveryCandidates(replacement.binding.currentOwnerSession());
      await settle(); gate.release.resolve();
      const result = await waiting;
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.map(candidate => candidate.draft.desired)).toEqual(['older-durable']);
      await settle(); expect(failures).toHaveLength(1); expect(failures[0].draft.desired).toBe('newer-fails');
    } finally { replacement.close(); }
  } finally { older.close(); newer.view.dispose(); owner.dispose(); }
});

test('owner disposal terminates a waiting replacement recovery', async () => {
  const shared = sharedFixture(); const owner = createDraftRetirementOwner(); const a = mount(shared, owner); await settle();
  try {
    expect(a.binding.edit('owner-disposed').ok).toBe(true);
    const gate = shared.pauseNextDraftWrite(); a.binding.dispose(); await gate.entered.promise;
    const replacement = mount(shared, owner); await settle();
    try {
      const waiting = replacement.binding.recoveryCandidates(replacement.binding.currentOwnerSession());
      await settle(); owner.dispose();
      const result = await waiting;
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('disposed');
      gate.release.resolve();
    } finally { replacement.close(); }
  } finally { a.view.dispose(); owner.dispose(); }
});
