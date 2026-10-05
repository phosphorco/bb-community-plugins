import { expect, test } from 'bun:test';
import { createNativeIdentityConnection, nativeIdentityRealtimeChannel } from '../bb-client-connection-runtime.ts';
import { identityRoutes } from '../rpc-routes-runtime.ts';

function session(actor = 'local:native', stamp = 'native-session') {
  return { status: 'ready', instanceId: 'native', mode: 'single-user', stamp,
    actor: { identity: { kind: 'default-user', key: actor, instanceId: 'native' }, presentation: { displayName: 'Native', handle: null, avatarUrl: null }, evidence: 'local-user' },
    capabilities: { requestIdentity: 'host-resolved', acceptance: 'transactional-check', forwarding: 'host-bound', directory: { search: false, lookup: false }, participants: false, externalSend: 'structured', toolProvenance: 'causal', operationLookup: true },
  };
}
function fakeRpc() {
  const calls = []; let bootstrap = { ok: true, value: session() }; const pending = [];
  return {
    calls, pending,
    setBootstrap(value) { bootstrap = value; },
    rpc: { async call(method, input) { calls.push({ method, input }); if (method === 'bb-identity.v1.bootstrap') return bootstrap; if (method === 'hold') return await new Promise(resolve => pending.push(resolve)); if (method.includes('.state.')) return { ok: true, value: {} }; return { ok: true, value: {} }; } },
  };
}

test('native adapter directly bootstraps once, preserves unchanged authority, and synchronously invalidates actor changes', async () => {
  const source = fakeRpc(); const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const events = []; adapter.connection.subscribe(event => events.push(event));
  expect(nativeIdentityRealtimeChannel).toBe('bb-identity/v1');
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  const firstGeneration = adapter.connection.getHealth().generation;
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  expect(adapter.connection.getHealth().generation).toBe(firstGeneration);
  expect(events).toEqual([]);
  source.setBootstrap({ ok: true, value: session('local:next', 'next-session') });
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  expect(events).toEqual([{ kind: 'session' }]);
  expect(source.calls.filter(call => call.method === 'bb-identity.v1.bootstrap')).toHaveLength(3);
  adapter.dispose();
});

test('concurrent native revalidation shares one bootstrap and an unavailable result suspends authority before it settles', async () => {
  const source = fakeRpc(); let resolve; let calls = 0;
  source.rpc.call = async method => { calls++; return method === 'bb-identity.v1.bootstrap' ? await new Promise(next => { resolve = next; }) : { ok: true, value: {} }; };
  const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const events = []; adapter.connection.subscribe(event => events.push(event));
  const first = adapter.connection.revalidate(); const second = adapter.connection.revalidate();
  expect(calls).toBe(1);
  await Promise.resolve(); resolve({ ok: false, error: { code: 'unauthenticated', message: 'sign in', retry: 'after-refresh' } });
  const result = await first; expect(result.ok).toBe(false);
  expect(adapter.connection.getHealth().identity.status).toBe('unavailable');
  // A connected native link was suspended synchronously; no session replacement is fabricated.
  expect(events).toEqual([{ kind: 'disconnected' }]); adapter.dispose();
});

test('two roots keep realtime callbacks independent; state failure recovers only after reconnect and a real state request', async () => {
  const one = fakeRpc(); const two = fakeRpc();
  const left = createNativeIdentityConnection({ rpc: one.rpc, realtimeState: 'connected' });
  const right = createNativeIdentityConnection({ rpc: two.rpc, realtimeState: 'connected' });
  const leftEvents = []; const rightEvents = []; left.connection.subscribe(event => leftEvents.push(event)); right.connection.subscribe(event => rightEvents.push(event));
  left.acceptRealtime({ kind: 'directory', keys: [], revision: null });
  expect(leftEvents).toHaveLength(1); expect(rightEvents).toHaveLength(0);
  one.rpc.call = async () => { throw Error('state route down'); };
  await expect(left.connection.request('bb-identity/v1/state/save', {})).rejects.toThrow('state route down');
  expect(left.connection.getHealth().identity.status).toBe('healthy');
  expect(left.connection.getHealth().state.status).toBe('unavailable');
  one.rpc.call = async method => method.includes('.state.') ? { ok: true, value: {} } : { ok: true, value: session() };
  left.setRealtimeState('reconnecting'); left.setRealtimeState('connected');
  expect(left.connection.getHealth().state.status).toBe('reconnecting');
  await left.connection.request('bb-identity/v1/state/load', {});
  expect(left.connection.getHealth().state.status).toBe('healthy');
  expect(leftEvents).toContainEqual({ kind: 'reconnected' });
  left.dispose(); left.acceptRealtime({ kind: 'session' });
  expect(leftEvents.filter(event => event.kind === 'session')).toHaveLength(0);
  right.dispose();
});

test('a disposed adapter fences a held bootstrap completion', async () => {
  const source = fakeRpc(); let resolve;
  source.rpc.call = async method => method === 'bb-identity.v1.bootstrap' ? await new Promise(next => { resolve = next; }) : { ok: true, value: {} };
  const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const pending = adapter.connection.revalidate(); await Promise.resolve(); adapter.dispose(); resolve({ ok: true, value: session() });
  const outcome = await pending; expect(outcome.ok).toBe(false); if (!outcome.ok) expect(outcome.error.code).toBe('disposed');
});

test('realtime authority changes fence held bootstrap and request completions; cancelled waiters do not cancel another caller', async () => {
  const source = fakeRpc(); let bootstrapResolve; let saveResolve;
  source.rpc.call = async method => {
    if (method === 'bb-identity.v1.bootstrap') return await new Promise(next => { bootstrapResolve = next; });
    if (method === 'bb-identity.v1.state.save') return await new Promise(next => { saveResolve = next; });
    return { ok: true, value: {} };
  };
  const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  const first = adapter.connection.revalidate(); const controller = new AbortController(); const cancelled = adapter.connection.revalidate({ signal: controller.signal });
  controller.abort(); expect((await cancelled).ok).toBe(false);
  adapter.setRealtimeState('reconnecting'); bootstrapResolve({ ok: true, value: session() });
  const stale = await first; expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe('stale-context');
  adapter.setRealtimeState('connected');
  // Re-establish authority, then ensure a late state completion cannot recover health after an actor invalidation.
  const next = adapter.connection.revalidate(); await Promise.resolve(); bootstrapResolve({ ok: true, value: session() }); expect((await next).ok).toBe(true);
  const pendingSave = adapter.connection.request('bb-identity/v1/state/save', {}); await Promise.resolve();
  adapter.acceptRealtime({ kind: 'session' }); saveResolve({ ok: true, value: {} });
  await expect(pendingSave).rejects.toThrow('stale');
  expect(adapter.connection.getHealth().identity.status).toBe('connecting');
  adapter.dispose();
});

test('an unchanged bootstrap does not retire a held state request', async () => {
  const source = fakeRpc(); let saveResolve;
  source.rpc.call = async method => {
    if (method === 'bb-identity.v1.bootstrap') return { ok: true, value: session() };
    if (method === 'bb-identity.v1.state.save') return await new Promise(next => { saveResolve = next; });
    return { ok: true, value: {} };
  };
  const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  const pending = adapter.connection.request('bb-identity/v1/state/save', {}); await Promise.resolve();
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  saveResolve({ ok: true, value: {} }); await expect(pending).resolves.toEqual({ ok: true, value: {} });
  adapter.dispose();
});

test('a reentrant session listener cannot let a changed bootstrap restore healthy authority', async () => {
  const source = fakeRpc(); const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  expect((await adapter.connection.revalidate()).ok).toBe(true);
  adapter.connection.subscribe(event => { if (event.kind === 'session') adapter.setRealtimeState('reconnecting'); });
  source.setBootstrap({ ok: true, value: session('local:changed', 'changed-session') });
  const result = await adapter.connection.revalidate(); expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('stale-context');
  expect(adapter.connection.getHealth().identity.status).toBe('reconnecting');
  adapter.dispose();
});

test('unmapped inherited route names are rejected before RPC dispatch', async () => {
  const source = fakeRpc(); const adapter = createNativeIdentityConnection({ rpc: source.rpc, realtimeState: 'connected' });
  await expect(adapter.connection.request('toString', {})).rejects.toThrow('Unsupported identity route');
  expect(source.calls).toHaveLength(0); adapter.dispose();
});
