import { describe, expect, test } from 'bun:test';
import { createDirectorySearch, createIdentityView } from '../client-view-runtime.ts';

const session = (mode = 'multi-user') => ({ status: 'ready', instanceId: 'i', mode, stamp: 's', actor: { identity: { kind: 'person', key: 'issuer:a', issuer: 'issuer', subject: 'a' }, presentation: { displayName: 'A', handle: null, avatarUrl: null }, evidence: 'provider-verified' }, capabilities: { requestIdentity: mode === 'single-user' ? 'singleton' : 'host-resolved' } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
 function client(mode = 'multi-user') { let current = session(mode); const listeners = new Set(); const directoryListeners = new Set(); let disposed = 0; return { value: { currentSession: () => ({ ok: true, value: current }), getSnapshot: () => current, subscribe: (f) => { listeners.add(f); return () => listeners.delete(f); }, directory: { subscribe: (_k, f) => { directoryListeners.add(f); return () => directoryListeners.delete(f); }, getMany: async ({ keys }) => ({ ok: true, value: keys.map((key) => ({ key, status: 'found', profile: { identity: { kind: 'person', key, issuer: 'issuer', subject: key.split(':')[1] }, presentation: { displayName: key, handle: null, avatarUrl: null }, revision: 'r', status: 'current' } })) }), search: async (q) => ({ ok: true, value: { items: [], nextCursor: q.cursor ? null : 'n', revision: 'r' } }) }, dispose: () => disposed++ }, set(next) { current = next; for (const f of listeners) f(); }, emit() { for (const f of listeners) f(); }, directoryListeners, get disposed() { return disposed; } }; }

describe('identity view and directory search', () => {
  test('inspects all guards before prepare, retains selection on rejection, and cancels superseded work', async () => {
    const fake = client(); const view = createIdentityView({ client: fake.value }); const calls = []; const gate = deferred();
    view.registerGuard({ inspect() { calls.push('inspect-a'); return { ok: true, value: { prepare: () => gate.promise, commit: () => calls.push('commit-a'), cancel: () => calls.push('cancel-a') } }; }, invalidate() {} });
    view.registerGuard({ inspect() { calls.push('inspect-b'); return { ok: true, value: { prepare: async () => ({ ok: true }), commit: () => calls.push('commit-b'), cancel: () => calls.push('cancel-b') } }; }, invalidate() {} });
    const first = view.select({ kind: 'person', key: 'issuer:b' }); const second = view.select({ kind: 'person', key: 'issuer:c' }); gate.resolve({ ok: true });
    expect((await first).ok).toBe(false); expect((await second).ok).toBe(true); expect(view.getSnapshot().status).toBe('ready'); expect(calls.slice(0, 2)).toEqual(['inspect-a', 'inspect-b']);
  });
  test('mandatory invalidation and singleton controls preserve borrowed client', async () => {
    const fake = client('single-user'); const view = createIdentityView({ client: fake.value }); const invalidated = [];
    view.registerGuard({ inspect: () => ({ ok: true, value: { prepare: async () => ({ ok: true }), commit() {}, cancel() {} } }), invalidate: (reason) => invalidated.push(reason) });
    expect((await view.select({ kind: 'person', key: 'issuer:b' })).ok).toBe(false); expect((await view.reset()).ok).toBe(true);
    fake.emit(); view.dispose(); expect(invalidated).toContain('disposed'); expect(fake.disposed).toBe(0);
  });
  test('search handles continuation and ignores late disposal', async () => {
    const fake = client(); const search = createDirectorySearch(fake.value); expect((await search.search({ query: 'a', kinds: ['person'], history: 'current', limit: 1 })).ok).toBe(true); expect((await search.next()).ok).toBe(true); search.dispose(); expect((await search.search({ query: 'b', kinds: ['person'], history: 'current', limit: 1 })).ok).toBe(false);
  });
  test('reversed and disposed searches cannot publish stale pages or cursors', async () => {
    const a = deferred(); const b = deferred(); let calls = 0; const fake = client();
    fake.value.directory.search = async () => (++calls === 1 ? a.promise : b.promise);
    const search = createDirectorySearch(fake.value); const q1 = search.search({ query: 'q1', kinds: ['person'], history: 'current', limit: 1 }); const q2 = search.search({ query: 'q2', kinds: ['person'], history: 'current', limit: 1 });
    b.resolve({ ok: true, value: { items: [], nextCursor: 'q2c', revision: 'r2' } }); expect((await q2).ok).toBe(true);
    a.resolve({ ok: true, value: { items: [], nextCursor: 'q1c', revision: 'r1' } }); expect((await q1).ok).toBe(false); expect(search.getSnapshot().page?.nextCursor).toBe('q2c');
    const late = deferred(); fake.value.directory.search = async () => late.promise; const pending = search.search({ query: 'q3', kinds: ['person'], history: 'current', limit: 1 }); search.dispose(); late.resolve({ ok: true, value: { items: [], nextCursor: null, revision: 'r3' } }); expect((await pending).ok).toBe(false);
  });
});

const personSession = (subject, stamp) => { const value = session(); return { ...value, stamp, actor: { ...value.actor, identity: { ...value.actor.identity, key: `issuer:${subject}`, subject } } }; };
for (const change of ['actor', 'outage']) test(`paused view preparation is synchronously invalidated by ${change}`, async () => {
  const fake = client(); const view = createIdentityView({ client: fake.value }); const gate = deferred(); const entered = deferred(); const calls = [];
  view.registerGuard({ inspect: () => ({ ok: true, value: { prepare() { entered.resolve(); return gate.promise; }, commit() { calls.push('commit'); }, cancel() { calls.push('cancel'); } } }), invalidate(reason) { calls.push(reason); } });
  const pending = view.select({ kind: 'person', key: 'issuer:b' }); await entered.promise;
  fake.set(change === 'actor' ? personSession('c', 's-c') : { status: 'unavailable', error: { code: 'unavailable', message: 'offline', retry: 'after-refresh' } });
  expect(calls).toContain(change === 'actor' ? 'actor' : 'disconnected');
  expect((await pending).ok).toBe(false); expect(calls).not.toContain('commit'); expect(calls.filter(x => x === 'cancel')).toHaveLength(1);
  if (change === 'actor') expect(view.getSnapshot().subject.key).toBe('issuer:c'); else expect(view.getSnapshot().status).toBe('blocked');
  gate.resolve({ ok: true }); await Promise.resolve(); expect(calls).not.toContain('commit'); view.dispose();
});
test('reset supersedes paused selection and actor ABA cannot revive it', async () => {
  const fake = client(); const view = createIdentityView({ client: fake.value }); const gate = deferred(); const entered = deferred(); let commits = 0;
  const stop = view.registerGuard({ inspect: () => ({ ok: true, value: { prepare() { entered.resolve(); return gate.promise; }, commit() { commits++; }, cancel() {} } }), invalidate() {} });
  const pending = view.select({ kind: 'person', key: 'issuer:b' }); await entered.promise;
  expect((await view.reset()).ok).toBe(true); expect((await pending).ok).toBe(false);
  fake.set(personSession('b', 's-b')); fake.set(personSession('a', 's-a2')); gate.resolve({ ok: true }); await Promise.resolve(); expect(commits).toBe(0);
  stop(); expect((await view.select({ kind: 'person', key: 'issuer:b' })).ok).toBe(true);
  expect((await view.reset()).ok).toBe(true); expect(view.getSnapshot().subject.key).toBe('issuer:a'); expect(view.getSnapshot().overriding).toBe(false); view.dispose();
});
test('guard rejection cancels prior inspection without any preparation', async () => {
  const fake = client(); const view = createIdentityView({ client: fake.value }); const calls = [];
  view.registerGuard({ inspect: () => ({ ok: true, value: { prepare: async () => { calls.push('prepare'); return { ok: true }; }, commit() {}, cancel() { calls.push('cancel'); } } }), invalidate() {} });
  view.registerGuard({ inspect() { throw new Error('broken guard'); }, invalidate() {} });
  expect((await view.select({ kind: 'person', key: 'issuer:b' })).ok).toBe(false); expect(calls).toEqual(['cancel']); expect(view.getSnapshot().subject.key).toBe('issuer:a'); view.dispose();
});
test('directory continuation rejects a changed snapshot and invalidation drops the cursor', async () => {
  const fake = client(); const search = createDirectorySearch(fake.value);
  const query = { query: 'a', kinds: ['person'], history: 'current', limit: 1 };
  expect((await search.search(query)).ok).toBe(true);
  fake.value.directory.search = async () => ({ ok: true, value: { items: [], nextCursor: 'other', revision: 'r2' } });
  expect((await search.next()).ok).toBe(false); expect(search.getSnapshot().status).toBe('error');
  expect((await search.search(query)).ok).toBe(true);
  for (const callback of fake.directoryListeners) callback();
  expect((await search.next()).ok).toBe(false); search.dispose();
});
