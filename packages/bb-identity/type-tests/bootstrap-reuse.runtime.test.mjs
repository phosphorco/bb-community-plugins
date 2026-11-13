import { expect, test } from 'bun:test';
import { createNativeIdentityConnection } from '../bb-client-connection-runtime.ts';
import { createIdentityClient, createIdentityFetchConnection } from '../client-runtime.ts';
import { createIdentityConnection } from '../client-connection-runtime.ts';

const ok = value => ({ ok: true, value });
const denied = { ok: false, error: { code: 'unauthenticated', message: 'denied', retry: 'after-refresh' } };
const session = (actor = 'a', stamp = `${actor}1`, instanceId = 'instance') => ({
  status: 'ready', instanceId, mode: 'multi-user', stamp,
  actor: { identity: { kind: 'person', key: `issuer:${actor}`, issuer: 'issuer', subject: actor },
    presentation: { displayName: actor, handle: null, avatarUrl: null }, evidence: 'provider-verified' },
  capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true },
});
const settle = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function fixture(kind) {
  let response = ok(session()); let gate = null;
  const calls = [];
  const read = async (method, input) => {
    calls.push({ method, input });
    if (gate) { const held = gate; gate = null; return held.promise; }
    if (response instanceof Error) throw response;
    return response;
  };
  const root = new AbortController();
  const native = kind === 'native' ? createNativeIdentityConnection({ realtimeState: 'connected', rpc: { call: read } }) : null;
  const connection = native?.connection ?? createIdentityFetchConnection({ endpoint: new URL('https://fixture.invalid/http/'), signal: root.signal,
    fetch: async (url, init) => new Response(JSON.stringify(await read(new URL(url).pathname, JSON.parse(init.body))), { status: 200 }) });
  const client = createIdentityClient({ connection });
  return { connection, client, native, calls,
    respond(value) { response = value; }, hold() { gate = deferred(); return gate; },
    close() { client.dispose(); connection.dispose(); root.abort(); } };
}
for (const kind of ['native', 'fetch']) {
  test(`${kind}: start and explicit refresh each use one fresh bootstrap, with no response cache`, async () => {
    const f = fixture(kind);
    try {
      expect((await f.client.start()).ok).toBe(true);
      expect(f.calls).toHaveLength(1);
      expect(f.client.currentSession().value.stamp).toBe('a1');
      f.respond(ok(session('a', 'a2')));
      await f.client.refresh(); await settle();
      expect(f.client.currentSession().value.stamp).toBe('a2');
      // Stamp changes can trigger an authority notification and another refresh;
      // an unchanged explicit refresh must still perform one fresh physical read.
      const count = f.calls.length;
      await f.client.refresh();
      expect(f.calls.length - count).toBe(1);
    } finally { f.close(); }
  });
  test(`${kind}: denial retires prior authority and recovery cannot reuse the old response`, async () => {
    const f = fixture(kind);
    try {
      await f.client.start(); f.respond(denied);
      expect((await f.client.refresh()).ok).toBe(false);
      expect(f.client.currentSession().ok).toBe(false);
      f.respond(ok(session('b'))); await f.client.refresh(); await settle();
      expect(f.client.currentSession().value.actor.identity.key).toBe('issuer:b');
      f.respond(ok(session('a', 'a-return'))); await f.client.refresh(); await settle();
      expect(f.client.currentSession().value.stamp).toBe('a-return');
    } finally { f.close(); }
  });
  test(`${kind}: disposal and cancelled observer reject a held verified response`, async () => {
    const f = fixture(kind);
    try {
      const gate = f.hold(); const abort = new AbortController();
      const pending = f.client.refresh({ signal: abort.signal });
      abort.abort(); gate.resolve(ok(session()));
      expect((await pending).ok).toBe(false); expect(f.client.currentSession().ok).toBe(false);
      const held = f.hold(); const after = f.client.refresh();
      f.connection.dispose(); held.resolve(ok(session('b')));
      expect((await after).ok).toBe(false); expect(f.client.currentSession().ok).toBe(false);
    } finally { f.close(); }
  });
}

test('native: reconnect and interleaved actor/instance invalidation cannot restore the retired response', async () => {
  const f = fixture('native');
  try {
    await f.client.start(); const old = f.hold(); const refresh = f.client.refresh();
    f.native.setRealtimeState('reconnecting');
    expect(f.client.currentSession().ok).toBe(false);
    f.respond(ok(session('b', 'b2', 'other-instance')));
    f.native.setRealtimeState('connected'); await settle();
    old.resolve(ok(session('a', 'old'))); await refresh; await settle();
    expect(f.client.currentSession().value).toMatchObject({ instanceId: 'other-instance', stamp: 'b2', actor: { identity: { key: 'issuer:b' } } });
    const before = f.calls.length;
    f.native.setRealtimeState('reconnecting'); f.native.setRealtimeState('connected'); await settle();
    expect(f.calls.length - before).toBe(1);
  } finally { f.close(); }
});

for (const wrapped of [false, true]) test(`custom legacy connection (${wrapped ? 'wrapped' : 'direct'}) retains revalidate then independent bootstrap`, async () => {
  const calls = [];
  const inputs = {
    getHealth: () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } }),
    subscribe: () => () => {}, subscribeHealth: () => () => {},
    revalidate: async () => { calls.push('revalidate'); return ok(undefined); },
    request: async method => { calls.push(method); return ok(session()); },
    dispose() {},
  };
  const connection = wrapped ? createIdentityConnection(inputs) : inputs;
  expect(connection.revalidateSession).toBeUndefined();
  const client = createIdentityClient({ connection });
  try {
    expect((await client.start()).ok).toBe(true);
    expect(calls).toEqual(['revalidate', 'bb-identity/v1/bootstrap']);
  } finally { client.dispose(); connection.dispose(); }
});

for (const kind of ['native', 'fetch']) {
  test(`${kind}: concurrent revalidation shares one flight and cancellation leaves another waiter live`, async () => {
    const f = fixture(kind);
    try {
      const gate = f.hold(); const abort = new AbortController();
      const cancelled = f.connection.revalidateSession({ signal: abort.signal });
      const retained = f.connection.revalidateSession();
      abort.abort(); expect((await cancelled).ok).toBe(false);
      gate.resolve(ok(session()));
      const result = await retained;
      expect(result.ok).toBe(true); expect(f.calls).toHaveLength(1);
      expect(result.value.generation).toBe(f.connection.getHealth().generation);
    } finally { f.close(); }
  });
  test(`${kind}: nonready and malformed bootstrap cannot become usable authority`, async () => {
    const f = fixture(kind);
    try {
      await f.client.start();
      f.respond(ok({ status: 'unauthenticated', error: denied.error }));
      expect((await f.client.refresh()).ok).toBe(false); expect(f.client.currentSession().ok).toBe(false);
      f.respond(ok({ ...session(), actor: {} }));
      expect((await f.client.refresh()).ok).toBe(false); expect(f.client.currentSession().ok).toBe(false);
    } finally { f.close(); }
  });
  test(`${kind}: complete capability/access changes are read even with the same actor/stamp`, async () => {
    const f = fixture(kind);
    try {
      await f.client.start();
      const updated = session(); updated.capabilities.directory.lookup = true;
      f.respond(ok(updated)); await f.client.refresh();
      expect(f.client.currentSession().value.capabilities.directory.lookup).toBe(true);
      expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
  });
}

test('native: reentrant health notification cannot restore authority after socket loss', async () => {
  const f = fixture('native');
  try {
    f.native.setRealtimeState('reconnecting');
    let armed = true;
    f.connection.subscribeHealth(() => {
      if (armed && f.connection.getHealth().identity.status === 'healthy') { armed = false; f.native.setRealtimeState('reconnecting'); }
    });
    f.native.setRealtimeState('connected'); await settle();
    expect(f.client.currentSession().ok).toBe(false);
    expect(f.connection.getHealth().identity.status).toBe('reconnecting');
  } finally { f.close(); }
});

test('verified response generation is fenced at both connection and client await boundaries', async () => {
  let generation = 1;
  const health = () => ({ generation, identity: { status: 'healthy' }, state: { status: 'healthy' } });
  const inputs = { getHealth: health, subscribe: () => () => {}, subscribeHealth: () => () => {},
    request: async () => { throw Error('must not fall back after verification failed'); },
    revalidate: async () => ok(undefined), revalidateSession: async () => ok({ session: session(), generation: 0 }) };
  const wrapped = createIdentityConnection(inputs);
  expect((await wrapped.revalidateSession()).ok).toBe(false);
  const direct = { ...inputs, dispose() {} };
  const client = createIdentityClient({ connection: direct });
  try { expect((await client.start()).ok).toBe(false); expect(client.currentSession().ok).toBe(false); }
  finally { client.dispose(); wrapped.dispose(); }
});

for (const kind of ['native', 'fetch']) {
  test(`${kind}: a route failure retires a held verification and a later response cannot restore it`, async () => {
    const f = fixture(kind);
    try {
      await f.client.start();
      const gate = f.hold(); const pending = f.connection.revalidateSession();
      f.respond(new Error('identity route failed'));
      await expect(f.connection.request('bb-identity/v1/selfProfile', {})).rejects.toThrow('identity route failed');
      expect(f.client.currentSession().ok).toBe(false);
      f.respond(ok(session('b')));
      await f.client.refresh(); await settle();
      gate.resolve(ok(session('a', 'retired')));
      expect((await pending).ok).toBe(false); await settle();
      expect(f.client.currentSession().value.actor.identity.key).toBe('issuer:b');
    } finally { f.close(); }
  });
  test(`${kind}: legacy revalidate still returns void and direct bootstrap always reads afresh`, async () => {
    const f = fixture(kind);
    try {
      expect(await f.connection.revalidate()).toEqual(ok(undefined));
      expect(f.calls).toHaveLength(1);
      const { createIdentityClientTransport } = await import('../client-runtime.ts');
      expect((await createIdentityClientTransport(f.connection).bootstrap()).ok).toBe(true);
      expect(f.calls).toHaveLength(2);
    } finally { f.close(); }
  });
}

for (const kind of ['native', 'fetch']) test(`${kind}: actor and instance changes invalidate even when a host repeats its stamp`, async () => {
  const f = fixture(kind); const events = [];
  f.connection.subscribe(event => { if (event.kind === 'session') events.push(event); });
  try {
    await f.client.start();
    f.respond(ok(session('b', 'a1'))); await f.client.refresh(); await settle();
    expect(f.client.currentSession().value.actor.identity.key).toBe('issuer:b');
    f.respond(ok(session('b', 'a1', 'replacement-instance'))); await f.client.refresh(); await settle();
    expect(f.client.currentSession().value.instanceId).toBe('replacement-instance');
    expect(events).toHaveLength(2);
  } finally { f.close(); }
});
