import { describe, expect, test } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { MembershipCallError, classifyMembershipError, createThreadMembershipClient, registerThreadMembershipSupplier } from '../src/bb.ts';
import { runThreadMembershipSupplierConformance } from '../src/testing.ts';
import { LIMITS, PROTOCOL, type PageOutputV1 } from '../src/index.ts';

/** A reference source: scope `{set}` selects a fixed list; revision is the list's content. */
const SETS: Record<string, string[]> = { five: ['t1', 't2', 't3', 't4', 't5'], none: [] };
function referenceSupplier(bb: Parameters<typeof registerThreadMembershipSupplier>[0], callers: unknown[] = []) {
  registerThreadMembershipSupplier(bb, {
    page(input, context) {
      callers.push(context.caller);
      const set = (input.scope as { set?: string } | null)?.set;
      const ids = set === undefined ? undefined : SETS[set];
      if (!ids) return { state: 'not-found', reason: 'source-missing', message: 'No such set.' };
      const start = input.cursor === null ? 0 : Number(input.cursor);
      const members = ids.slice(start, start + input.limit).map(threadId => ({ threadId, relation: 'direct' as const }));
      const next = start + input.limit < ids.length ? String(start + input.limit) : null;
      return { state: 'ready', revision: `rev:${ids.join(',')}`, members, nextCursor: next, coverage: { state: 'complete' } };
    },
  });
}

function hostedClient(register: (bb: never) => void) {
  const host = createFakePluginHost({ pluginId: 'source' });
  register(host.bb as never);
  const targets: string[] = [];
  const sdk = { plugins: { async callRpc(args: { pluginId: string; method: string; input?: unknown }) {
    targets.push(args.pluginId);
    return host.harness.behavior.callRpc(args.method, args.input ?? null, { experimental_caller: { kind: 'plugin', pluginId: 'consumer' } });
  } } };
  return { client: createThreadMembershipClient(sdk as never, 'source'), targets };
}

describe('client', () => {
  test('describe negotiates v1 and pages are owner-bound', async () => {
    const callers: unknown[] = [];
    const { client, targets } = hostedClient(bb => referenceSupplier(bb, callers));
    expect(await client.describe()).toEqual({ version: 1 });
    const page = await client.page({ scope: { set: 'five' }, cursor: null, limit: 2 });
    expect(page.state === 'ready' && page.members.map(m => m.threadId)).toEqual(['t1', 't2']);
    expect(new Set(targets)).toEqual(new Set(['source']));
    expect(callers[0]).toEqual({ kind: 'plugin', pluginId: 'consumer' });
  });

  test('closed failures are data, not errors', async () => {
    const { client } = hostedClient(bb => referenceSupplier(bb));
    expect((await client.page({ scope: { set: 'missing' }, cursor: null, limit: 2 })).state).toBe('not-found');
  });

  test('malformed or over-limit pages are incompatible', async () => {
    const bad = (output: unknown) => hostedClient(bb => (bb as { rpc: { register: Function } }).rpc.register(
      { threadMembershipV1Page: { input: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } }, output: { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } } } },
      { threadMembershipV1Page: () => output })).client;
    const tooMany = { state: 'ready', revision: 'r', members: [{ threadId: 'a', relation: 'direct' }, { threadId: 'b', relation: 'direct' }, { threadId: 'c', relation: 'direct' }], nextCursor: null, coverage: { state: 'complete' } };
    for (const output of [{ state: 'ready' }, tooMany, { ...tooMany, members: [{ threadId: 'a', relation: 'direct' }, { threadId: 'a', relation: 'direct' }] }]) {
      const error = await bad(output).page({ scope: null, cursor: null, limit: 2 }).catch(e => e);
      expect(error).toBeInstanceOf(MembershipCallError);
      expect((error as MembershipCallError).kind).toBe('incompatible');
    }
  });

  test('cancellation is classified', async () => {
    const sdk = { plugins: { callRpc: (args: { signal?: AbortSignal }) => new Promise((_, reject) => args.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) } };
    const controller = new AbortController();
    const pending = createThreadMembershipClient(sdk as never, 'source').page({ scope: null, cursor: null, limit: 1 }, controller.signal);
    controller.abort();
    expect(((await pending.catch(e => e)) as MembershipCallError).kind).toBe('cancelled');
  });
});

test.each([
  [{ status: 404, body: { error: { code: 'unknown_method' } } }, 'absent'],
  [{ status: 404, body: 'Unknown plugin source' }, 'vanished'],
  [{ status: 404, body: {} }, 'host-incompatible'],
  [{ status: 503, body: 'not running (status: disabled)' }, 'unavailable'],
  [{ status: 403 }, 'unauthorized'],
  [{ status: 400, body: { error: { code: 'invalid_input' } } }, 'incompatible'],
  [{ status: 500, body: { error: { code: 'invalid_output' } } }, 'incompatible'],
  [{ status: 500, body: {} }, 'error'],
  [{ name: 'TimeoutError' }, 'transient'],
  [new Error('network'), 'transient'],
])('classifies %j as %s', (error, kind) => expect(classifyMembershipError(error)).toBe(kind as never));

describe('conformance kit', () => {
  test('passes a correct supplier, including more-than-page and empty sets', async () => {
    const report = await runThreadMembershipSupplierConformance({
      pluginId: 'source',
      register: bb => referenceSupplier(bb as never),
      cases: [
        { name: 'five over pages of 2', scope: { set: 'five' }, expect: { state: 'ready', members: SETS.five!, coverage: 'complete' } },
        { name: 'empty', scope: { set: 'none' }, expect: { state: 'ready', members: [] } },
        { name: 'missing', scope: { set: 'missing' }, expect: { state: 'not-found' } },
      ],
    });
    expect(report.checks.filter(c => c.state === 'failed')).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.proof).toBe('source-conformance');
  });

  test('fails a supplier that repeats members across pages or drifts revision', async () => {
    let calls = 0;
    const report = await runThreadMembershipSupplierConformance({
      pluginId: 'source',
      register: bb => registerThreadMembershipSupplier(bb as never, {
        page: (input): PageOutputV1 => ({ state: 'ready', revision: `r${calls++}`, members: [{ threadId: 'same', relation: 'direct' }], nextCursor: input.cursor === null ? 'c' : null, coverage: { state: 'complete' } }),
      }),
      cases: [{ name: 'drift', scope: null, expect: { state: 'ready' } }],
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find(c => c.name === 'case:drift')?.detail).toMatch(/Revision changed|repeated/);
  });

  test('fails a supplier whose registration throws, and skips without witnesses', async () => {
    const broken = await runThreadMembershipSupplierConformance({ pluginId: 'source', register: () => { throw new Error('boom'); }, cases: [] });
    expect(broken.passed).toBe(false);
    const unwitnessed = await runThreadMembershipSupplierConformance({ pluginId: 'source', register: bb => referenceSupplier(bb as never), cases: [] });
    expect(unwitnessed.checks.find(c => c.name === 'cases')?.state).toBe('skipped');
  });
});

describe('local deadline and cancellation (transport ignores abort)', () => {
  /** A transport that never observes its signal and settles when told to. */
  function stubborn() {
    const calls: { settle: (outcome: { value?: unknown; error?: unknown }) => void }[] = [];
    const sdk = { plugins: { callRpc: () => new Promise((resolve, reject) => {
      calls.push({ settle: ({ value, error }) => error === undefined ? resolve(value) : reject(error) });
    }) } };
    return { calls, client: createThreadMembershipClient(sdk as never, 'source') };
  }
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

  test('deadline rejects locally on time; a late result is discarded and a late rejection is consumed', async () => {
    process.on('unhandledRejection', onUnhandled);
    try {
      const { calls, client } = stubborn();
      const started = performance.now();
      const first = await client.describe().catch(e => e);
      const elapsed = performance.now() - started;
      expect((first as MembershipCallError).kind).toBe('transient');
      expect(elapsed).toBeLessThan(LIMITS.describeMs + 150);
      calls[0]!.settle({ value: { protocol: PROTOCOL, versions: [1] } });
      await new Promise(resolve => setTimeout(resolve, 0)); // the raw call settled: its slot is released
      const second = client.describe().catch(e => e);
      await new Promise(resolve => setTimeout(resolve, LIMITS.describeMs + 50));
      calls[1]!.settle({ error: Object.assign(new Error('late failure'), { status: 500 }) });
      expect(((await second) as MembershipCallError).kind).toBe('transient');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(calls.length).toBe(2);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 10_000);

  test('a stalled raw call keeps its slot after the local deadline; repeated calls never stack', async () => {
    const { calls, client } = stubborn();
    const first = await client.describe().catch(e => e);
    expect((first as MembershipCallError).kind).toBe('transient');
    const started = performance.now();
    for (let i = 0; i < 5; i++) {
      const again = await client.page({ scope: null, cursor: null, limit: 1 }).catch(e => e);
      expect((again as MembershipCallError).kind).toBe('transient');
    }
    expect(performance.now() - started).toBeLessThan(50);
    expect(calls.length).toBe(1);
    const controller = new AbortController();
    controller.abort();
    expect(((await client.describe(controller.signal).catch(e => e)) as MembershipCallError).kind).toBe('cancelled');
    calls[0]!.settle({ error: Object.assign(new Error('finally failed'), { status: 500 }) });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls.length).toBe(1);
    const next = client.describe().catch(e => e);
    await Promise.resolve();
    expect(calls.length).toBe(2);
    calls[1]!.settle({ value: { protocol: PROTOCOL, versions: [1] } });
    expect(await next).toEqual({ version: 1 });
  }, 10_000);

  test('separate clients do not share a slot', async () => {
    const { calls, client } = stubborn();
    void client.page({ scope: null, cursor: null, limit: 1 }).catch(() => {});
    const other = createThreadMembershipClient({ plugins: { callRpc: async () => ({ protocol: PROTOCOL, versions: [1] }) } } as never, 'source');
    expect(await other.describe()).toEqual({ version: 1 });
    expect(calls.length).toBe(1);
    calls[0]!.settle({ value: null });
  });

  test('an outer signal aborted before start never reaches the transport', async () => {
    const { calls, client } = stubborn();
    const controller = new AbortController();
    controller.abort();
    expect(((await client.page({ scope: null, cursor: null, limit: 1 }, controller.signal).catch(e => e)) as MembershipCallError).kind).toBe('cancelled');
    expect(calls.length).toBe(0);
  });

  test('outer abort in flight rejects at once; the late result is ignored', async () => {
    const { calls, client } = stubborn();
    const controller = new AbortController();
    const pending = client.page({ scope: null, cursor: null, limit: 1 }, controller.signal).catch(e => e);
    await Promise.resolve();
    controller.abort();
    const started = performance.now();
    expect(((await pending) as MembershipCallError).kind).toBe('cancelled');
    expect(performance.now() - started).toBeLessThan(50);
    calls[0]!.settle({ value: { state: 'ready', revision: 'r', members: [], nextCursor: null, coverage: { state: 'complete' } } });
  });

  test('abort listeners are removed after every outcome', async () => {
    const controller = new AbortController();
    let added = 0, removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, ...rest: unknown[]) => { if (type === 'abort') added++; return (add as Function)(type, ...rest); }) as never;
    controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => { if (type === 'abort') removed++; return (remove as Function)(type, ...rest); }) as never;
    const ok = { plugins: { callRpc: async () => ({ protocol: PROTOCOL, versions: [1] }) } };
    const failing = { plugins: { callRpc: async () => { throw Object.assign(new Error('gone'), { status: 404, body: { error: { code: 'unknown_method' } } }); } } };
    expect(await createThreadMembershipClient(ok as never, 'source').describe(controller.signal)).toEqual({ version: 1 });
    expect(((await createThreadMembershipClient(failing as never, 'source').describe(controller.signal).catch(e => e)) as MembershipCallError).kind).toBe('absent');
    expect(added).toBe(2);
    expect(removed).toBe(2);
  });
});

describe('review findings 2–4 on the client', () => {
  const okPage = { state: 'ready', revision: 'r', members: [], nextCursor: null, coverage: { state: 'complete' } };
  test('the transmitted scope is the validated snapshot, not the caller object', async () => {
    let sent: any;
    const client = createThreadMembershipClient({ plugins: { callRpc: async (args: any) => { sent = args.input; return okPage; } } } as never, 'source');
    const scope = { map: 'expected', list: [1] };
    const pending = client.page({ scope, cursor: null, limit: 1 });
    scope.map = 'other-scope'; scope.list.push(2);
    await pending;
    expect(sent.scope).toEqual({ map: 'expected', list: [1] });
    expect(sent.scope).not.toBe(scope);
    expect(JSON.parse(JSON.stringify(sent))).toEqual({ scope: { map: 'expected', list: [1] }, cursor: null, limit: 1 });
  });
  test('a hidden toJSON scope never reaches the transport', async () => {
    let calls = 0;
    const client = createThreadMembershipClient({ plugins: { callRpc: async () => { calls++; return okPage; } } } as never, 'source');
    const scope = { map: 'expected' };
    Object.defineProperty(scope, 'toJSON', { value: () => ({ map: 'other-scope' }), enumerable: false });
    await expect(client.page({ scope, cursor: null, limit: 1 })).rejects.toThrow();
    expect(calls).toBe(0);
  });
  test('a transport that blocks synchronously past the deadline is transient; its settled slot is released', async () => {
    let calls = 0;
    const client = createThreadMembershipClient({ plugins: { callRpc() {
      calls++;
      if (calls === 1) { const until = performance.now() + LIMITS.describeMs + 100; while (performance.now() < until) {} }
      return Promise.resolve({ protocol: PROTOCOL, versions: [1] });
    } } } as never, 'source');
    expect(((await client.describe().catch(e => e)) as MembershipCallError).kind).toBe('transient');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await client.describe()).toEqual({ version: 1 });
    expect(calls).toBe(2);
  }, 10_000);
  test.each([
    [{ status: 404, body: { ok: false, error: 'unknown plugin "source"' } }, 'vanished'],
    [{ status: 404, body: { ok: false, error: { code: 'unknown_method', message: 'x' } } }, 'absent'],
    [{ status: 404, body: { ok: false, error: 'route not found' } }, 'host-incompatible'],
    [{ status: 404, body: { ok: false, error: 'plugin "unknown plugin" missing' } }, 'host-incompatible'],
    [{ status: 404, body: 'Unknown plugin source' }, 'vanished'],
    [{ status: 404, body: null }, 'host-incompatible'],
    [{ status: 404, body: 404 }, 'host-incompatible'],
    [{ status: 404, body: { ok: false, error: 5 } }, 'host-incompatible'],
    [{ status: 404, body: { ok: false, error: { message: 'unknown plugin "source"' } } }, 'host-incompatible'],
  ])('classifies the actual host body %j as %s', (error, kind) => expect(classifyMembershipError(error)).toBe(kind as never));
});

describe('review finding 5: raw admission is reserved before SDK code runs', () => {
  test('a synchronous re-entry from inside callRpc cannot start a second raw call', async () => {
    let raw = 0, inner: unknown = 'not-called';
    let settle!: (value: unknown) => void;
    const sdk = { plugins: { callRpc() {
      raw++;
      if (raw === 1) inner = client.describe().then(() => 'resolved', (e: MembershipCallError) => e.kind);
      return new Promise((resolve) => { settle = resolve; });
    } } };
    const client = createThreadMembershipClient(sdk as never, 'source');
    const outer = client.describe();
    expect(await inner).toBe('transient');
    expect(raw).toBe(1);
    settle({ protocol: PROTOCOL, versions: [1] });
    expect(await outer).toEqual({ version: 1 });
  });
  test('a synchronous throw from callRpc releases the slot', async () => {
    let raw = 0;
    const client = createThreadMembershipClient({ plugins: { callRpc() {
      raw++;
      if (raw === 1) throw Object.assign(new Error('sync'), { status: 500 });
      return Promise.resolve({ protocol: PROTOCOL, versions: [1] });
    } } } as never, 'source');
    expect(((await client.describe().catch(e => e)) as MembershipCallError).kind).toBe('error');
    expect(await client.describe()).toEqual({ version: 1 });
    expect(raw).toBe(2);
  });
});

describe('R5: response checks are bounded and classified incompatible', () => {
  const nest = (levels: number): unknown => { let v: unknown = 'leaf'; for (let i = 0; i < levels; i++) v = { d: v }; return v; };
  const respond = (value: unknown) => createThreadMembershipClient({ plugins: { callRpc: async () => JSON.parse(JSON.stringify(value)) } } as never, 'source');
  test('the reviewer case: a 70-level unknown field is accepted and ignored', async () => {
    const page = { state: 'ready', revision: 'r', members: [{ threadId: 't', relation: 'direct' }], nextCursor: null, coverage: { state: 'complete' }, future: nest(70) };
    const result = await respond(page).page({ scope: null, cursor: null, limit: 1 });
    expect(result).toEqual({ state: 'ready', revision: 'r', members: [{ threadId: 't', relation: 'direct' }], nextCursor: null, coverage: { state: 'complete' } });
  });
  test('over-byte and non-JSON responses are incompatible, never transient', async () => {
    const big = { state: 'ready', revision: 'r', members: [], nextCursor: null, coverage: { state: 'complete' }, future: 'x'.repeat(LIMITS.responseBytes) };
    expect(((await respond(big).page({ scope: null, cursor: null, limit: 1 }).catch(e => e)) as MembershipCallError).kind).toBe('incompatible');
    const nan = createThreadMembershipClient({ plugins: { callRpc: async () => ({ protocol: PROTOCOL, versions: [Number.NaN] }) } } as never, 'source');
    expect(((await nan.describe().catch(e => e)) as MembershipCallError).kind).toBe('incompatible');
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const deepClient = createThreadMembershipClient({ plugins: { callRpc: async () => ({ protocol: PROTOCOL, versions: [1], future: deep }) } } as never, 'source');
    expect(((await deepClient.describe().catch(e => e)) as MembershipCallError).kind).toBe('incompatible');
  });
});

test('a cyclic response is incompatible, a shared-child response is accepted', async () => {
  const cyclic: Record<string, unknown> = { protocol: PROTOCOL, versions: [1] };
  cyclic.future = { back: cyclic };
  const c1 = createThreadMembershipClient({ plugins: { callRpc: async () => cyclic } } as never, 'source');
  expect(((await c1.describe().catch(e => e)) as MembershipCallError).kind).toBe('incompatible');
  const shared = { x: 1 };
  const c2 = createThreadMembershipClient({ plugins: { callRpc: async () => ({ protocol: PROTOCOL, versions: [1], a: shared, b: shared }) } } as never, 'source');
  expect(await c2.describe()).toEqual({ version: 1 });
});
