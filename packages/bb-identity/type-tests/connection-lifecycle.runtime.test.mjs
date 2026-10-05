import { expect, test } from 'bun:test';
import { createIdentityConnection } from '../client-connection-runtime.ts';

function fixture(synchronous = null) {
  const callbacks = {}; const starts = { event: 0, health: 0 }; const stops = { event: 0, health: 0 };
  let disposed = 0;
  const attach = (kind, listener) => {
    starts[kind]++; callbacks[kind] = listener;
    if (synchronous === kind) listener({ kind: 'session' });
    return () => { stops[kind]++; };
  };
  const connection = createIdentityConnection({
    request: async () => ({}), revalidate: async () => ({ ok: true, value: undefined }),
    getHealth: () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } }),
    subscribe: listener => attach('event', listener), subscribeHealth: listener => attach('health', listener),
    dispose: () => { disposed++; },
  });
  return { connection, callbacks, starts, stops, get disposed() { return disposed; } };
}

for (const kind of ['event', 'health']) test(`synchronous ${kind} subscription disposal retains exact cleanup`, () => {
  const f = fixture(kind); let observed = 0;
  const subscribe = kind === 'event' ? f.connection.subscribe : f.connection.subscribeHealth;
  const stop = subscribe(() => { observed++; f.connection.dispose(); });
  expect(observed).toBe(1); expect(f.stops[kind]).toBe(1); expect(f.disposed).toBe(1);
  f.callbacks[kind]({ kind: 'session' }); stop(); stop(); f.connection.dispose();
  expect(observed).toBe(1); expect(f.stops[kind]).toBe(1); expect(f.disposed).toBe(1);
});

test('one observer cannot suppress another and subscriptions retain independent cleanup', () => {
  const f = fixture(); let events = 0; let health = 0;
  const eventObserver = () => { events++; };
  const stopFault = f.connection.subscribe(() => { throw Error('consumer callback'); });
  const first = f.connection.subscribe(eventObserver); const second = f.connection.subscribe(eventObserver);
  const stopHealthFault = f.connection.subscribeHealth(() => { throw Error('consumer health callback'); });
  const stopHealth = f.connection.subscribeHealth(() => { health++; });
  f.callbacks.event({ kind: 'session' }); f.callbacks.health();
  expect(events).toBe(2); expect(health).toBe(1); expect(f.starts).toEqual({ event: 1, health: 1 });
  first(); first(); f.callbacks.event({ kind: 'session' }); expect(events).toBe(3);
  second(); expect(f.stops.event).toBe(0); stopFault(); expect(f.stops.event).toBe(1);
  stopHealthFault(); stopHealth(); expect(f.stops.health).toBe(1);
  const third = f.connection.subscribe(eventObserver); expect(f.starts.event).toBe(2);
  f.callbacks.event({ kind: 'session' }); expect(events).toBe(4);
  third(); f.connection.dispose(); expect(f.stops.event).toBe(2);
});

test('generic connection revalidation cannot succeed after cancellation or disposal', async () => {
  for (const terminal of ['cancelled', 'disposed']) {
    let resolve;
    const connection = createIdentityConnection({
      request: async () => ({}), revalidate: () => new Promise(done => { resolve = done; }),
      getHealth: () => ({ generation: 0, identity: { status: 'healthy' }, state: { status: 'healthy' } }),
      subscribe: () => () => {}, subscribeHealth: () => () => {},
    });
    const controller = new AbortController(); const pending = connection.revalidate({ signal: controller.signal });
    if (terminal === 'disposed') connection.dispose(); else controller.abort();
    resolve({ ok: true, value: undefined });
    expect(await pending).toMatchObject({ ok: false, error: { code: terminal } });
    connection.dispose();
  }
});
