import { expect, test } from 'bun:test';
import { createIdentityEndpoint } from '../server-runtime.ts';
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('endpoint normalizes host invalidations and unsubscribes on disposal', async () => {
  let listener; let stopped = 0; const published = [];
  const server = { subscribe(next) { listener = next; return () => { stopped++; }; }, session: async () => ({ status: 'unavailable', instanceId: 'i', error: { code: 'unavailable', message: 'x', retry: 'after-reconnect' } }), selfProfile: async () => ({ ok: false, error: { code: 'unsupported', message: 'x', retry: 'never' } }), directory: { search: async () => ({ ok: false }), getMany: async () => ({ ok: false }) }, participants: { list: async () => ({ ok: false }), previews: async () => ({ ok: false }) } };
  const endpoint = createIdentityEndpoint({ server, publish: (event) => published.push(event) });
  const keys = ['issuer:a']; listener({ kind: 'directory', keys }); keys[0] = 'mutated'; listener({ kind: 'directory', keys: [''] }); listener({ kind: 'participants', threadIds: ['thread-1'] }); listener({ kind: 'session', reason: 'provider' }); listener({ kind: 'reconnected' }); listener({ kind: 'disconnected' }); listener({ kind: 'disposed' });
  expect(published).toEqual([{ kind: 'directory', keys: ['issuer:a'], revision: null }, { kind: 'directory', keys: [], revision: null }, { kind: 'participants', threadIds: ['thread-1'] }, { kind: 'session', reason: 'provider' }, { kind: 'reconnected' }, { kind: 'disconnected' }, { kind: 'disconnected' }]);
  listener({ kind: 'reconnected' }); expect((await endpoint.bootstrap({})).error.code).toBe('disposed'); endpoint.dispose(); endpoint.dispose(); listener({ kind: 'disconnected' }); expect(stopped).toBe(1); expect(published).toHaveLength(7);
});
test('endpoint fences bootstrap/profile/directory completions after disposal', async () => {
  const bootstrap = deferred(); const profile = deferred(); const search = deferred();
  const server = { subscribe: () => () => {}, session: () => bootstrap.promise, selfProfile: () => profile.promise,
    directory: { search: () => search.promise, getMany: async () => ({ ok: true, value: [] }) }, participants: { list: async () => ({ ok: true, value: {} }), previews: async () => ({ ok: true, value: [] }) } };
  const endpoint = createIdentityEndpoint({ server, publish() {} });
  const pending = [endpoint.bootstrap({}), endpoint.selfProfile({}), endpoint.search({}, { query: '', kinds: [], history: 'current', limit: 1 })];
  endpoint.dispose(); bootstrap.resolve({ status: 'unavailable', instanceId: 'i', error: { code: 'unavailable', message: 'x', retry: 'never' } }); profile.resolve({ ok: true, value: {} }); search.resolve({ ok: true, value: { items: [], nextCursor: null, revision: 'r' } });
  for (const result of await Promise.all(pending)) { expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('disposed'); }
});

test('publisher failure cannot escape into host mutation and disposal remains terminal', () => {
  let listener; let stopped = 0; let attempted = 0;
  const server = { subscribe(next) { listener = next; return () => stopped++; } };
  const endpoint = createIdentityEndpoint({ server, publish() { attempted++; throw new Error('publisher offline'); } });
  expect(() => listener({ kind: 'session', reason: 'actor' })).not.toThrow();
  expect(() => listener({ kind: 'disposed' })).not.toThrow();
  listener({ kind: 'reconnected' }); endpoint.dispose(); expect(attempted).toBe(2); expect(stopped).toBe(1);
});
test('synchronous host disposal during subscription still cleans its returned handle', async () => {
  let stopped = 0; const published = [];
  const endpoint = createIdentityEndpoint({ server: { subscribe(next) { next({ kind: 'disposed' }); return () => stopped++; } }, publish: event => published.push(event) });
  expect(stopped).toBe(1); expect(published).toEqual([{ kind: 'disconnected' }]);
  expect((await endpoint.bootstrap({})).error.code).toBe('disposed'); endpoint.dispose(); expect(stopped).toBe(1);
});
