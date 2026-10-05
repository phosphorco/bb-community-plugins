import { describe, expect, test } from 'bun:test';
import { createIdentityConnection, clientInvalidationCodec } from '../client-connection-runtime.ts';
import { createIdentityClient, createIdentityClientTransport, createIdentityFetchConnection } from '../client-runtime.ts';

const actor = {
  identity: { kind: 'person', key: 'issuer:alice', issuer: 'issuer', subject: 'alice' },
  presentation: { displayName: 'Alice', handle: 'alice', avatarUrl: null }, evidence: 'provider-verified',
};
const session = (stamp, currentActor = actor) => ({ status: 'ready', instanceId: 'fixture-instance', mode: 'multi-user', actor: currentActor, stamp, capabilities: {
  requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
  directory: { search: true, lookup: true }, participants: true, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true,
} });
const profile = (key = 'issuer:alice') => ({ identity: { kind: 'person', key, issuer: 'issuer', subject: key.split(':')[1] }, presentation: { displayName: key, handle: null, avatarUrl: null }, revision: `revision-${key}`, status: 'current' });
const health = () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixtureConnection(request) {
  const events = new Set(); const healthListeners = new Set(); let currentHealth = health();
  const connection = createIdentityConnection({
    request,
    subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    getHealth: () => currentHealth,
    subscribeHealth(listener) { healthListeners.add(listener); return () => healthListeners.delete(listener); },
    revalidate: async () => ({ ok: true, value: undefined }),
  });
  return { connection, emit: (event) => { for (const listener of events) listener(event); }, setHealth(value) { currentHealth = value; for (const listener of healthListeners) listener(); } };
}

describe('identity connection and client runtime', () => {
  test('strictly decodes invalidations and keeps state health independent', async () => {
    expect(clientInvalidationCodec.decode({ kind: 'directory', keys: [], revision: null }).ok).toBe(true);
    expect(clientInvalidationCodec.decode({ kind: 'directory', keys: [''] }).ok).toBe(false);
    expect(clientInvalidationCodec.decode({ kind: 'session', actor: 'forged' }).ok).toBe(true);
    const harness = fixtureConnection(async () => ({ ok: true, value: session('s1') }));
    const seen = []; const stop = harness.connection.subscribe((event) => seen.push(event));
    harness.emit({ kind: 'state', event: { address: { instanceId: 'fixture-instance', pluginId: 'fixture-plugin', collection: 'prefs', recordId: 'one', owner: 'issuer:alice' }, version: { epoch: 'e', sequence: 0 }, operationId: null } });
    harness.emit({ kind: 'directory', keys: [''], revision: null });
    expect(seen).toHaveLength(1);
    harness.setHealth({ generation: 1, identity: { status: 'healthy' }, state: { status: 'unavailable', error: { code: 'unavailable', message: 'state only', retry: 'after-reconnect' } } });
    expect(harness.connection.getHealth().identity.status).toBe('healthy');
    expect(harness.connection.getHealth().state.status).toBe('unavailable');
    stop();
  });

  test('transport rejects malformed success and directory cache clears on whole-directory invalidation', async () => {
    let profiles = 0;
    const harness = fixtureConnection(async (method) => {
      if (method === 'bb-identity/v1/bootstrap') return { ok: true, value: session('s1') };
      if (method === 'bb-identity/v1/profiles') { profiles++; return { ok: true, value: [{ key: 'issuer:alice', status: 'found', profile: profile() }] }; }
      if (method === 'bb-identity/v1/selfProfile') return { ok: true, value: { forged: true } };
      return { ok: true, value: [] };
    });
    const transport = createIdentityClientTransport(harness.connection);
    expect((await transport.selfProfile()).ok).toBe(false);
    const client = createIdentityClient({ connection: harness.connection });
    await client.directory.getMany({ keys: ['issuer:alice'] });
    await client.directory.getMany({ keys: ['issuer:alice'] });
    expect(profiles).toBe(1);
    harness.emit({ kind: 'directory', keys: [], revision: null });
    await client.directory.getMany({ keys: ['issuer:alice'] });
    expect(profiles).toBe(2);
    client.dispose();
  });

  test('A→B→A refresh fencing and independently cancellable shared profile reads preserve the latest authority', async () => {
    const bootstraps = [];
    const profileRead = deferred(); let profileCalls = 0;
    const harness = fixtureConnection(async (method) => {
      if (method === 'bb-identity/v1/bootstrap') { const next = deferred(); bootstraps.push(next); return next.promise; }
      if (method === 'bb-identity/v1/profiles') { profileCalls++; return profileRead.promise; }
      return { ok: true, value: [] };
    });
    const client = createIdentityClient({ connection: harness.connection });
    const a = client.refresh(); const b = client.refresh(); const aAgain = client.refresh();
    await Promise.resolve(); await Promise.resolve();
    expect(bootstraps).toHaveLength(3);
    const bob = { ...actor, identity: { kind: 'person', key: 'issuer:bob', issuer: 'issuer', subject: 'bob' }, presentation: { ...actor.presentation, displayName: 'Bob' } };
    bootstraps[1].resolve({ ok: true, value: session('B', bob) });
    bootstraps[0].resolve({ ok: true, value: session('A-old') });
    bootstraps[2].resolve({ ok: true, value: session('A-new') });
    await Promise.all([a, b, aAgain]);
    expect(client.currentSession().value.stamp).toBe('A-new');
    expect(client.currentSession().value.actor.identity.key).toBe('issuer:alice');

    const abort = new AbortController();
    const cancelled = client.directory.getMany({ keys: ['issuer:alice'] }, { signal: abort.signal });
    const retained = client.directory.getMany({ keys: ['issuer:alice'] });
    await Promise.resolve(); abort.abort();
    profileRead.resolve({ ok: true, value: [{ key: 'issuer:alice', status: 'found', profile: profile() }] });
    expect((await cancelled).ok).toBe(false);
    expect((await retained).ok).toBe(true);
    expect(profileCalls).toBe(1);
    client.dispose();
  });

  test('suspends authority during refresh and fences paused profile reads across invalidation/dispose', async () => {
    const bootstrap = []; const pausedProfiles = deferred();
    const harness = fixtureConnection(async (method) => {
      if (method === 'bb-identity/v1/bootstrap') { const next = deferred(); bootstrap.push(next); return next.promise; }
      if (method === 'bb-identity/v1/profiles') return pausedProfiles.promise;
      return { ok: true, value: [] };
    });
    const client = createIdentityClient({ connection: harness.connection });
    const first = client.start(); await Promise.resolve(); await Promise.resolve(); bootstrap.shift().resolve({ ok: true, value: session('A') }); await first;
    const refresh = client.refresh();
    expect(client.currentSession().ok).toBe(false);
    await Promise.resolve(); await Promise.resolve(); bootstrap.shift().resolve({ ok: true, value: session('A2') }); await refresh;
    const read = client.directory.getMany({ keys: ['issuer:alice'] }); await Promise.resolve();
    harness.emit({ kind: 'directory', keys: [], revision: null });
    pausedProfiles.resolve({ ok: true, value: [{ key: 'issuer:alice', status: 'found', profile: profile() }] });
    expect((await read).ok).toBe(false);
    const afterDispose = client.directory.getMany({ keys: ['issuer:alice'] }); client.dispose();
    expect((await afterDispose).ok).toBe(false);
  });


  test('provider notification refreshes actor without suspending captured session', async () => {
    const bootstraps = [];
    const harness = fixtureConnection(async (method) => {
      if (method === 'bb-identity/v1/bootstrap') { const next = deferred(); bootstraps.push(next); return next.promise; }
      return { ok: true, value: [] };
    });
    const client = createIdentityClient({ connection: harness.connection });
    const started = client.start();
    await Promise.resolve(); await Promise.resolve();
    bootstraps.shift().resolve({ ok: true, value: session('person-session') });
    await started;
    const machine = {
      identity: { kind: 'machine', key: 'p6r-machine:v1:fixture-instance:server', instanceId: 'fixture-instance', hostId: null },
      presentation: { displayName: 'BB machine', handle: null, avatarUrl: null }, evidence: 'machine',
    };
    harness.emit({ kind: 'session', reason: 'provider' });
    await Promise.resolve(); await Promise.resolve();
    expect(bootstraps).toHaveLength(1);
    const during = client.currentSession();
    expect(during.ok).toBe(true); if (!during.ok) return;
    expect(during.value.actor.identity.kind).toBe('person');
    bootstraps[0].resolve({ ok: true, value: session('machine-session', machine) });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    const after = client.currentSession();
    expect(after.ok).toBe(true); if (!after.ok) return;
    expect(after.value.actor.identity.kind).toBe('machine');
    client.dispose();
  });
  test('provider refresh ordering keeps the newest actor when responses complete in reverse order', async () => {
    const bootstraps = [];
    const harness = fixtureConnection(async (method) => {
      if (method === 'bb-identity/v1/bootstrap') { const next = deferred(); bootstraps.push(next); return next.promise; }
      return { ok: true, value: [] };
    });
    const client = createIdentityClient({ connection: harness.connection });
    const started = client.start();
    await Promise.resolve(); await Promise.resolve();
    bootstraps.shift().resolve({ ok: true, value: session('person-session') });
    await started;

    const oldProviderActor = {
      ...actor,
      identity: { kind: 'person', key: 'issuer:old-provider', issuer: 'issuer', subject: 'old-provider' },
      presentation: { ...actor.presentation, displayName: 'Old provider' },
    };
    const newProviderActor = {
      identity: { kind: 'machine', key: 'p6r-machine:v1:fixture-instance:server', instanceId: 'fixture-instance', hostId: null },
      presentation: { displayName: 'BB machine', handle: null, avatarUrl: null }, evidence: 'machine',
    };
    harness.emit({ kind: 'session', reason: 'provider' });
    harness.emit({ kind: 'session', reason: 'provider' });
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(bootstraps).toHaveLength(2);
    const during = client.currentSession();
    expect(during.ok).toBe(true); if (!during.ok) return;
    expect(during.value.actor.identity.kind).toBe('person');

    bootstraps[1].resolve({ ok: true, value: session('new-provider', newProviderActor) });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    const newest = client.currentSession();
    expect(newest.ok).toBe(true); if (!newest.ok) return;
    expect(newest.value.stamp).toBe('new-provider');
    expect(newest.value.actor.identity.kind).toBe('machine');

    bootstraps[0].resolve({ ok: true, value: session('old-provider', oldProviderActor) });
    for (let index = 0; index < 8; index++) await Promise.resolve();
    const afterStale = client.currentSession();
    expect(afterStale.ok).toBe(true); if (!afterStale.ok) return;
    expect(afterStale.value.stamp).toBe('new-provider');
    expect(afterStale.value.actor.identity.kind).toBe('machine');
    client.dispose();
  });
  test('explicit fetch roots use only supplied endpoint/fetch and retain no feed', async () => {

    const root = new AbortController(); const calls = [];
    const connection = createIdentityFetchConnection({ endpoint: new URL('https://bb.example/http/'), signal: root.signal, fetch: async (url, init) => {
      calls.push([String(url), init.method]); return new Response(JSON.stringify({ ok: true, value: session('fetch') }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const client = createIdentityClient({ connection });
    expect((await client.start()).ok).toBe(true);
    expect(calls).toEqual([
      ['https://bb.example/http/bb-identity/v1/bootstrap', 'POST'],
      ['https://bb.example/http/bb-identity/v1/bootstrap', 'POST'],
    ]);
    client.dispose(); connection.dispose();
  });

  test('starts the first search and bounds five independent searches to four active requests', async () => {
    const gates = []; let active = 0; let peak = 0; let calls = 0;
    const harness = fixtureConnection(async (method) => {
      if (method !== 'bb-identity/v1/search') return { ok: true, value: [] };
      calls++; active++; peak = Math.max(peak, active); const gate = deferred(); gates.push(gate);
      return gate.promise.finally(() => { active--; });
    });
    const client = createIdentityClient({ connection: harness.connection });
    const reads = [0, 1, 2, 3, 4].map((index) => client.directory.search({ query: `q${index}`, kinds: ['person'], history: 'current', limit: 10 }));
    await Promise.resolve();
    expect(calls).toBe(4); expect(peak).toBe(4);
    for (const gate of [...gates]) gate.resolve({ ok: true, value: { items: [], nextCursor: null, revision: 'r' } });
    await Promise.all(reads.slice(0, 4));
    expect(calls).toBe(5);
    gates[4].resolve({ ok: true, value: { items: [], nextCursor: null, revision: 'r' } });
    expect((await Promise.all(reads)).every((result) => result.ok)).toBe(true);
    client.dispose();
  });
});
