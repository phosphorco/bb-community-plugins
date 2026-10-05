import { expect, test } from 'bun:test';
import { createIdentityConnection } from '../client-connection-runtime.ts';
import { createIdentityClient } from '../client-runtime.ts';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const session = {
  status: 'ready', instanceId: 'instance', mode: 'multi-user', stamp: 'session-A',
  actor: {
    identity: { kind: 'person', key: 'issuer:alice', issuer: 'issuer', subject: 'alice' },
    presentation: { displayName: 'Alice', handle: null, avatarUrl: null }, evidence: 'provider-verified',
  },
  capabilities: {
    requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound',
    directory: { search: true, lookup: true }, participants: false, externalSend: 'structured',
    toolProvenance: 'unknown', operationLookup: true,
  },
};
const profileResult = name => ({ ok: true, value: [{
  key: 'issuer:alice', status: 'found', profile: {
    identity: session.actor.identity,
    presentation: { displayName: name, handle: null, avatarUrl: null },
    revision: name, status: 'current',
  },
}] });
function fixture(request) {
  let health = { generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } };
  const events = new Set(); const healthEvents = new Set();
  const connection = createIdentityConnection({
    request,
    subscribe(listener) { events.add(listener); return () => events.delete(listener); },
    subscribeHealth(listener) { healthEvents.add(listener); return () => healthEvents.delete(listener); },
    getHealth: () => health,
    revalidate: async () => ({ ok: true, value: undefined }),
  });
  return {
    connection,
    emit(event) { for (const listener of events) listener(event); },
    failState() {
      health = { ...health, generation: health.generation + 1, state: {
        status: 'unavailable', error: { code: 'unavailable', message: 'state feed failed', retry: 'after-reconnect' },
      } };
      for (const listener of healthEvents) listener();
    },
  };
}
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };

test('state-only connection failure preserves live identity without a bootstrap loop', async () => {
  let calls = 0;
  const host = fixture(async () => { calls++; return { ok: true, value: session }; });
  const client = createIdentityClient({ connection: host.connection });
  try {
    expect((await client.start()).ok).toBe(true);
    const before = client.getSnapshot();
    host.failState();
    await tick();
    expect(client.currentSession()).toEqual({ ok: true, value: session });
    expect(client.getSnapshot()).toBe(before);
    expect(calls).toBe(1);
    expect(host.connection.getHealth().state.status).toBe('unavailable');
  } finally { client.dispose(); host.connection.dispose(); }
});

test('old invalidated profile waiter cannot cancel a synchronous same-key replacement', async () => {
  const reads = [];
  const host = fixture(async () => { const gate = deferred(); reads.push(gate); return gate.promise; });
  const client = createIdentityClient({ connection: host.connection });
  try {
    const old = client.directory.getMany({ keys: ['issuer:alice'] });
    await tick();
    expect(reads).toHaveLength(1);
    host.emit({ kind: 'directory', keys: [], revision: null });
    const next = client.directory.getMany({ keys: ['issuer:alice'] });
    await tick();
    expect((await old).ok).toBe(false);
    expect(reads).toHaveLength(2);
    reads[0].resolve(profileResult('old'));
    await tick();
    let settled = false;
    void next.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    reads[1].resolve(profileResult('new'));
    const result = await next;
    expect(result.ok).toBe(true);
    expect(result.value[0].profile.presentation.displayName).toBe('new');
    const cached = await client.directory.getMany({ keys: ['issuer:alice'] });
    expect(cached.value[0].profile.presentation.displayName).toBe('new');
  } finally { client.dispose(); host.connection.dispose(); }
});
