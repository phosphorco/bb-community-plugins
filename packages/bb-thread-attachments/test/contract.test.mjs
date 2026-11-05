import { test, expect } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import {
 PROTOCOL, METHODS, LIMITS, ThreadIdSchema, ReadInputV1Schema, ReadOutputV1Schema,
 FamilyOutputV1Schema, AttachInputV1Schema, AttachmentRecordV1Schema, AssessInputV1Schema, AssessOutputV1Schema, ObserveInputV1Schema, assessViolation,
 negotiateVersion, canonicalJsonWithin, readViolation,
} from '../dist/index.js';
import {
 createThreadAttachmentsClient, registerThreadAttachmentsSupplier, createThreadAttachmentsSupplierHandlers,
 classifyAttachmentError, reconcileUnknownWrite, discoverThreadAttachmentsSuppliers, createThreadAttachmentsDiscovery,
} from '../dist/bb.js';
import { runThreadAttachmentsSupplierConformance } from '../dist/testing.js';

const A = 'thr_23456789ab', B = 'thr_zyxwvutsrq', C = 'thr_abcdefghij';
const read = { version: 1, threadIds: [A] };
const attach = { version: 1, threadId: A, leadId: B, operationId: 'op-1', expectedRevision: 'r1' };
const detached = { threadId: A, state: 'detached', leadId: null, sourceId: null, provenance: 'manual', operationId: 'op-1' };
const record = threadId => ({ threadId, state: 'none', leadId: null, sourceId: null, provenance: null, operationId: null });
const output = input => ({ version: 1, revision: 'r1', records: input.threadIds.map(record) });
const adapter = (overrides = {}) => ({
 observe: async input => output({ threadIds: [input.threadId] }),
 assess: async input => ({ version: 1, state: 'queued', threadIds: input.threadIds }),
 read: async input => output(input),
 family: async input => ({ version: 1, revision: 'r1', leadId: input.threadId, threadIds: [input.threadId], coverage: 'complete' }),
 attach: async input => ({ version: 1, state: 'applied', revision: 'r2', operationId: input.operationId }),
 detach: async input => ({ version: 1, state: 'applied', revision: 'r2', operationId: input.operationId }), ...overrides,
});
const sdk = fn => ({ plugins: { callRpc: fn } });
const hostClient = handlers => {
 const host = createFakePluginHost({ pluginId: 'authority' });
 registerThreadAttachmentsSupplier(host.bb, handlers);
 const client = createThreadAttachmentsClient(sdk(({ pluginId, method, input }) => {
  expect(pluginId).toBe('authority');
  return host.harness.behavior.callRpc(method, input);
 }), 'authority');
 return { host, client };
};
const failure = async promise => { try { await promise; } catch (error) { return error; } throw new Error('Expected rejection'); };

test('exact native thread ID grammar, strict operation inputs and cardinality', () => {
 for (const bad of [A + 'x', A + '\n', 'x' + A, 'thr_0123456789', 'thr_abcdefghil', 'THR_23456789ab', 'thr_abc', 1]) expect(ThreadIdSchema.safeParse(bad).success).toBe(false);
 expect(ThreadIdSchema.parse(A)).toBe(A);
 for (const bad of [{ ...read, actor: 'forged' }, { ...read, version: 2 }, { ...read, threadIds: [] }, { ...read, threadIds: [A, A] }, { ...read, threadIds: Array(201).fill(A) }]) expect(ReadInputV1Schema.safeParse(bad).success).toBe(false);
 expect(AttachInputV1Schema.safeParse({ ...attach, leadId: A }).success).toBe(false);
 expect(AttachInputV1Schema.safeParse({ ...attach, operationId: '\n' }).success).toBe(false);
});

test('additive nested outputs retain unknown fields; meaningful states remain closed', () => {
 const value = { ...output(read), future: true, records: [{ ...record(A), newField: { keep: true } }] };
 expect(ReadOutputV1Schema.parse(value)).toEqual(value);
 expect(AttachmentRecordV1Schema.safeParse({ ...record(A), state: 'future' }).success).toBe(false);
 expect(AttachmentRecordV1Schema.safeParse({ ...record(A), state: 'attached' }).success).toBe(false);
 expect(AttachmentRecordV1Schema.safeParse(detached).success).toBe(true);
 expect(FamilyOutputV1Schema.safeParse({ version: 1, revision: 'r1', leadId: B, threadIds: [A], coverage: 'complete' }).success).toBe(false);
 expect(FamilyOutputV1Schema.safeParse({ version: 1, revision: 'r1', leadId: B, threadIds: [], coverage: 'unavailable' }).success).toBe(true);
});

test('describe negotiation tolerates additions and never assumes unsupported versions', () => {
 for (const versions of [[1], [1, 2]]) expect(negotiateVersion({ protocol: PROTOCOL, versions, future: { unknown: true } })).toEqual({ version: 1 });
 for (const value of [null, {}, { protocol: 'other', versions: [1] }, { protocol: PROTOCOL, versions: [] }, { protocol: PROTOCOL, versions: [2] }, { protocol: PROTOCOL, versions: ['1'] }]) expect(negotiateVersion(value)).toBeNull();
});

test('UTF8 canonical JSON budgets include unknown fields and do not execute getters', () => {
 expect(canonicalJsonWithin({ b: 'é', a: 1 }, 16)).toBe('{"a":1,"b":"é"}');
 expect(canonicalJsonWithin({ b: 'é', a: 1 }, 15)).toBeNull();
 let getter = false;
 expect(() => canonicalJsonWithin({ get evil() { getter = true; return 1; } }, 100)).toThrow();
 expect(getter).toBe(false);
 const cyclic = {}; cyclic.self = cyclic;
 expect(() => canonicalJsonWithin(cyclic, 100)).toThrow();
});

test('client validates echoed IDs, family completeness, operation receipts and raw size before decode', async () => {
 expect(readViolation(read, output({ threadIds: [B] }))).toBeTruthy();
 const values = [output({ threadIds: [B] }), { ...output(read), records: [] }, { ...output(read), records: [record(A), record(A)] }, { ...output(read), padding: 'x'.repeat(LIMITS.responseBytes) }, { ...output(read), padding: () => 1 }];
 for (const value of values) {
  const client = createThreadAttachmentsClient(sdk(async ({ outputSchema }) => {
   const result = await outputSchema['~standard'].validate(value); expect(result.value).toBe(value); return value;
  }), 'authority');
  expect((await failure(client.read(read))).kind).toBe('incompatible');
 }
 const f = createThreadAttachmentsClient(sdk(async () => ({ version: 1, revision: 'r1', leadId: B, threadIds: [B], coverage: 'complete' })), 'authority');
 expect((await failure(f.family({ version: 1, threadId: A }))).kind).toBe('incompatible');
 const w = createThreadAttachmentsClient(sdk(async () => ({ version: 1, revision: 'r2', state: 'applied', operationId: 'other' })), 'authority');
 const error = await failure(w.attach(attach)); expect(error.kind).toBe('incompatible'); expect(error.outcome).toBe('unknown');
});

test('input rejection and already aborted requests never dispatch', async () => {
 let calls = 0; const client = createThreadAttachmentsClient(sdk(async () => { calls++; return null; }), 'authority');
 expect((await failure(client.read({ ...read, actor: 'forged' }))).kind).toBe('invalid-input');
 const controller = new AbortController(); controller.abort();
 expect((await failure(client.attach(attach, controller.signal))).outcome).toBe('not-dispatched');
 expect(calls).toBe(0);
});

test('ignored abort holds raw admission until settlement; unknown write is never replayed', async () => {
 let finish, calls = 0;
 const client = createThreadAttachmentsClient(sdk(() => { calls++; return new Promise(resolve => { finish = resolve; }); }), 'authority');
 const controller = new AbortController(); const pending = client.attach(attach, controller.signal); controller.abort();
 const error = await failure(pending); expect(error.kind).toBe('cancelled'); expect(error.outcome).toBe('unknown');
 expect((await failure(client.read(read))).kind).toBe('busy');
 expect(await reconcileUnknownWrite(client, attach)).toEqual({ state: 'unknown', fresh: null });
 expect(calls).toBe(1);
 finish({ version: 1, state: 'applied', revision: 'r2', operationId: 'op-1' });
 await Promise.resolve();
 expect(calls).toBe(1);
});

test('write deadline fences late output, reports unknown and never replays', async () => {
 let finish, calls = 0; const client = createThreadAttachmentsClient(sdk(() => { calls++; return new Promise(resolve => { finish = resolve; }); }), 'authority');
 const started = performance.now(); const error = await failure(client.attach(attach));
 expect(error.outcome).toBe('unknown'); expect(calls).toBe(1);
 expect(error.kind).toBe('transient'); expect(performance.now() - started).toBeLessThan(4900);
 expect((await failure(client.read(read))).kind).toBe('busy');
 finish(output(read)); await Promise.resolve();
}, 7000);

test('supplier validates independently, preserves invocation, bounds admission, and fences work with own deadline', async () => {
 const contexts = []; let finish;
 const handlers = createThreadAttachmentsSupplierHandlers(adapter({ read: async (_input, ctx) => { contexts.push(ctx); return new Promise(resolve => { finish = resolve; }); } }));
 const invocation = { actualActor: 'server-bound' };
 const p1 = handlers[METHODS.read](read, invocation); const p2 = handlers[METHODS.read](read, invocation);
 await Promise.resolve();
 expect((await failure(handlers[METHODS.read](read, invocation))).kind).toBe('busy');
 expect(contexts[0].rpcContext).toBe(invocation);
 expect(contexts[0].signal.aborted).toBe(false);
 const errors = await Promise.all([failure(p1), failure(p2)]);
 expect(errors.every(e => e.name === 'TimeoutError')).toBe(true);
 expect(contexts[0].signal.aborted).toBe(true);
 expect((await failure(handlers[METHODS.read](read, invocation))).kind).toBe('busy');
 finish(output(read));
}, 6000);

test('supplier adapter validates raw direct input/output without relying on SDK schemas', async () => {
 const handlers = createThreadAttachmentsSupplierHandlers(adapter({ read: async () => output({ threadIds: [B] }) }));
 expect(await failure(handlers[METHODS.read]({ ...read, extra: true }, null))).toBeInstanceOf(Error);
 expect((await failure(handlers[METHODS.read](read, null))).kind).toBe('incompatible');
 const { host } = hostClient(adapter());
 expect(await host.harness.behavior.callRpc(METHODS.describe, { future: true })).toEqual({ protocol: PROTOCOL, versions: [1] });
});

test('SDK error fixture shapes classify status plus string/structured code and legacy body', () => {
 for (const body of [{ error: { code: 'unknown_method' } }, { error: 'unknown_method' }, 'unknown_method']) expect(classifyAttachmentError({ status: 404, body })).toBe('absent');
 for (const body of [{ error: 'unknown plugin "gone"' }, 'unknown plugin "gone"']) expect(classifyAttachmentError({ status: 404, body })).toBe('vanished');
 for (const [status, body, kind] of [[404, { error: { code: 'not_found' } }, 'host-incompatible'], [503, { error: 'not running (status: disabled)' }, 'unavailable'], [401, {}, 'unauthorized'], [403, {}, 'unauthorized'], [400, { error: 'invalid_input' }, 'incompatible'], [500, { error: { code: 'invalid_output' } }, 'incompatible'], [500, {}, 'error']]) expect(classifyAttachmentError({ status, body })).toBe(kind);
 expect(classifyAttachmentError(new DOMException('abort', 'AbortError'))).toBe('cancelled');
 expect(classifyAttachmentError(new Error('network'))).toBe('transient');
});

test('unknown write reconciliation reads once, checks immutable operation and never infers non-execution', async () => {
 for (const [r, expected] of [[{ ...detached, state: 'attached', leadId: B, sourceId: B }, 'observed'], [{ ...record(A), operationId: null }, 'unknown'], [{ ...detached, operationId: 'newer', state: 'attached', leadId: B, sourceId: B }, 'unknown']]) {
  let reads = 0;
  const client = createThreadAttachmentsClient(sdk(async () => { reads++; return { version: 1, revision: 'r2', records: [r] }; }), 'authority');
  expect((await reconcileUnknownWrite(client, attach)).state).toBe(expected); expect(reads).toBe(1);
 }
});

test('listed discovery isolates malformed/absent supplier and retains all owners without implicit arbitration', async () => {
 let lists = 0;
 const sdk = { plugins: {
  list: async () => { lists++; return { plugins: ['ok', 'bad', 'absent', 'also'].map(id => ({ id, status: 'running' })) }; },
  callRpc: async ({ pluginId }) => { if (pluginId === 'absent') throw { status: 404, body: { error: 'unknown_method' } }; return pluginId === 'bad' ? {} : { protocol: PROTOCOL, versions: [1] }; },
 } };
 const rows = await discoverThreadAttachmentsSuppliers(sdk);
 expect(lists).toBe(1); expect(rows.filter(r => r.state === 'ready').map(r => r.pluginId)).toEqual(['also', 'ok']);
 expect(rows.find(r => r.pluginId === 'bad').state).toBe('incompatible');
 expect(rows.find(r => r.pluginId === 'absent').state).toBe('absent');
});

test('independent consumer conformance witnesses read/family/attach/detach against real registered handlers', async () => {
 let saved = null, revision = 'r1';
 const report = await runThreadAttachmentsSupplierConformance({ pluginId: 'actual-authority-fixture', register: bb => registerThreadAttachmentsSupplier(bb, adapter({
  read: async input => ({ version: 1, revision, records: input.threadIds.map(id => saved && id === A ? saved : record(id)) }),
  attach: async input => {
   if (input.expectedRevision !== revision) return { version: 1, state: 'conflict', revision, operationId: input.operationId };
   saved = { threadId: A, state: 'attached', leadId: B, sourceId: B, provenance: 'manual', operationId: input.operationId }; revision = 'r2';
   return { version: 1, state: 'applied', revision, operationId: input.operationId };
  },
  family: async () => ({ version: 1, revision, leadId: B, threadIds: [B, A, C], coverage: 'complete' }),
  detach: async input => { saved = { ...detached, operationId: input.operationId }; revision = 'r3'; return { version: 1, state: 'applied', revision, operationId: input.operationId }; },
 })), cases: [{ name: 'independent-family-operations', run: async client => {
  const first = await client.read(read); expect(first.records[0].state).toBe('none');
  expect((await client.attach({ ...attach, expectedRevision: first.revision })).state).toBe('applied');
  expect((await client.read(read)).records[0].leadId).toBe(B);
  expect((await client.family({ version: 1, threadId: A })).threadIds).toEqual([B, A, C]);
  expect((await client.attach(attach)).state).toBe('conflict');
  await client.detach({ version: 1, threadId: A, operationId: 'detach-1', expectedRevision: 'r2' });
  expect((await client.read(read)).records[0].state).toBe('detached');
 } }] });
 expect(report).toMatchObject({ passed: true, proof: 'source-conformance' });
 const skipped = await runThreadAttachmentsSupplierConformance({ pluginId: 'empty', register: bb => registerThreadAttachmentsSupplier(bb, adapter()), cases: [] });
 expect(skipped.passed).toBe(false);
});

test('retained discovery bounds raw probes across aborted passes and admits recovery after actual settlement', async () => {
 let calls = 0, hang = true; const finishes = [];
 const discovery = createThreadAttachmentsDiscovery({ plugins: {
  list: async () => ({ plugins: Array.from({ length: 12 }, (_, i) => ({ id: `owner-${i}`, status: 'running' })) }),
  callRpc: async () => { calls++; if (hang) return new Promise(resolve => finishes.push(resolve)); return { protocol: PROTOCOL, versions: [1] }; },
 } });
 const controller = new AbortController(); const first = discovery.discover(controller.signal);
 for (let ticks = 0; calls < LIMITS.discoveryConcurrency && ticks < 20; ticks++) await Promise.resolve();
 expect(calls).toBe(4); controller.abort(); await first;
 const exhausted = await discovery.discover();
 expect(exhausted.length).toBe(12); expect(exhausted.every(r => r.state === 'unavailable')).toBe(true); expect(calls).toBe(4);
 hang = false; for (const finish of finishes) finish({ protocol: PROTOCOL, versions: [1] });
 for (let i = 0; i < 10; i++) await Promise.resolve();
 const healthy = await discovery.discover(); expect(healthy.filter(r => r.state === 'ready').length).toBe(12); expect(calls).toBe(16);
});

test('raw plugin list admission survives local abort until list settles', async () => {
 let finish, calls = 0;
 const discovery = createThreadAttachmentsDiscovery({ plugins: {
  list: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, callRpc: async () => null,
 } });
 const controller = new AbortController(); const first = discovery.discover(controller.signal); controller.abort();
 expect((await failure(first)).name).toBe('AbortError');
 expect((await failure(discovery.discover())).kind).toBe('busy'); expect(calls).toBe(1);
 finish({ plugins: [] });
});

test('supplier write admission is independent of reads and retained until raw write settles', async () => {
 let finish;
 const handlers = createThreadAttachmentsSupplierHandlers(adapter({ attach: () => new Promise(resolve => { finish = resolve; }) }));
 const pending = handlers[METHODS.attach](attach, null);
 await Promise.resolve();
 expect((await failure(handlers[METHODS.detach]({ version: 1, threadId: A, operationId: 'detach-x', expectedRevision: 'r1' }, null))).kind).toBe('busy');
 expect((await handlers[METHODS.read](read, null)).records[0].threadId).toBe(A);
 finish({ version: 1, state: 'applied', revision: 'r2', operationId: attach.operationId });
 expect((await pending).state).toBe('applied');
});

test('exact bounds accept 200 unique read IDs and 500 family members, reject overflow', () => {
 const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
 const id = n => { let suffix = ''; for (let i = 0; i < 10; i++) { suffix = alphabet[n % alphabet.length] + suffix; n = Math.floor(n / alphabet.length); } return `thr_${suffix}`; };
 const ids = Array.from({ length: 501 }, (_, n) => id(n));
 expect(ReadInputV1Schema.safeParse({ version: 1, threadIds: ids.slice(0, 200) }).success).toBe(true);
 const family = { version: 1, revision: 'r1', leadId: ids[0], threadIds: ids.slice(0, 500), coverage: 'complete' };
 expect(FamilyOutputV1Schema.safeParse(family).success).toBe(true);
 expect(FamilyOutputV1Schema.safeParse({ ...family, threadIds: ids }).success).toBe(false);
});

test('describe enforces input/output byte budgets while accepting additive probes', async () => {
 const handlers = createThreadAttachmentsSupplierHandlers(adapter());
 expect(() => handlers[METHODS.describe]({ padding: 'x'.repeat(LIMITS.inputBytes) }, null)).toThrow();
 const client = createThreadAttachmentsClient(sdk(async () => ({ protocol: PROTOCOL, versions: [1], padding: 'x'.repeat(LIMITS.describeBytes) })), 'authority');
 expect((await failure(client.describe())).kind).toBe('incompatible');
});

test('synchronous transport reentrancy cannot bypass client admission', async () => {
 let nested, client;
 client = createThreadAttachmentsClient(sdk(() => { nested = failure(client.read(read)); return Promise.resolve(output(read)); }), 'authority');
 expect((await client.read(read)).records[0].threadId).toBe(A);
 expect((await nested).kind).toBe('busy');
});

test('priority assessment accepts one to four unique native IDs, strict inputs and additive queued output', () => {
 const request = { version: 1, threadIds: [A, B] };
 expect(AssessInputV1Schema.parse(request)).toEqual(request);
 expect(AssessInputV1Schema.safeParse({ version: 1, threadIds: [A, B, C, 'thr_2222222222'] }).success).toBe(true);
 for (const invalid of [
  { ...request, threadIds: [] }, { ...request, threadIds: [A, A] },
  { ...request, threadIds: [A, B, C, 'thr_2222222222', 'thr_3333333333'] },
  { ...request, threadIds: ['thr_0123456789'] }, { ...request, operationId: 'forbidden' },
  { ...request, actor: 'forged' }, { ...request, version: 2 },
 ]) expect(AssessInputV1Schema.safeParse(invalid).success).toBe(false);
 const acknowledgement = { version: 1, state: 'queued', threadIds: [A, B], future: true };
 expect(AssessOutputV1Schema.parse(acknowledgement)).toEqual(acknowledgement);
 expect(AssessOutputV1Schema.safeParse({ ...acknowledgement, state: 'completed' }).success).toBe(false);
 expect(AssessOutputV1Schema.safeParse({ ...acknowledgement, threadIds: [A, A] }).success).toBe(false);
 expect(assessViolation(request, acknowledgement)).toBeNull();
 for (const threadIds of [[B, A], [A], [A, C]]) expect(assessViolation(request, { ...acknowledgement, threadIds })).toBeTruthy();
});

test('assessment is separate from read/family, deduplicates explicit wakes and does not overwrite fixture facts', async () => {
 const pending = new Set(), facts = output({ threadIds: [A, B] });
 let assessments = 0;
 const { client } = hostClient(adapter({
  read: async () => structuredClone(facts),
  assess: async input => { assessments++; for (const id of input.threadIds) pending.add(id); return { version: 1, state: 'queued', threadIds: input.threadIds }; },
 }));
 expect(await client.read({ version: 1, threadIds: [A, B] })).toEqual(facts);
 await client.family({ version: 1, threadId: A });
 expect(assessments).toBe(0); expect(pending.size).toBe(0);
 const request = { version: 1, threadIds: [A, B] };
 expect(await client.assess(request)).toEqual({ ...request, state: 'queued' });
 await client.assess(request); // independent explicit wake; never client replay
 expect(assessments).toBe(2); expect([...pending]).toEqual([A, B]);
 expect(await client.read({ version: 1, threadIds: [A, B] })).toEqual(facts);
});

test('both supplier and client reject assessment echoes that reorder, omit or substitute IDs', async () => {
 const request = { version: 1, threadIds: [A, B] };
 for (const threadIds of [[B, A], [A], [A, C], [A, A]]) {
  const result = { version: 1, state: 'queued', threadIds };
  const client = createThreadAttachmentsClient(sdk(async () => result), 'authority');
  const error = await failure(client.assess(request));
  expect(error.kind).toBe('incompatible'); expect(error.outcome).toBe('unknown');
  const handlers = createThreadAttachmentsSupplierHandlers(adapter({ assess: async () => result }));
  expect(await failure(handlers[METHODS.assess](request, null))).toBeInstanceOf(Error);
 }
});

test('assessment loss/abort remains unknown, holds raw admission and never automatically repeats enqueue', async () => {
 let finish, calls = 0;
 const request = { version: 1, threadIds: [A] };
 const client = createThreadAttachmentsClient(sdk(({ method }) => { expect(method).toBe(METHODS.assess); calls++; return new Promise(resolve => { finish = resolve; }); }), 'authority');
 const controller = new AbortController(); const pending = client.assess(request, controller.signal); controller.abort();
 expect(await failure(pending)).toMatchObject({ kind: 'cancelled', outcome: 'unknown' });
 expect(await failure(client.assess(request))).toMatchObject({ kind: 'busy', outcome: 'not-dispatched' });
 expect(calls).toBe(1);
 finish({ version: 1, state: 'queued', threadIds: [A] }); await Promise.resolve();
 expect(calls).toBe(1);
 let lostCalls = 0;
 const lost = createThreadAttachmentsClient(sdk(async () => { lostCalls++; throw new Error('Response lost after durable queue write'); }), 'authority');
 expect(await failure(lost.assess(request))).toMatchObject({ kind: 'transient', outcome: 'unknown' }); expect(lostCalls).toBe(1);
 const aborted = new AbortController(); aborted.abort();
 expect(await failure(lost.assess(request, aborted.signal))).toMatchObject({ kind: 'cancelled', outcome: 'not-dispatched' }); expect(lostCalls).toBe(1);
});

test('assessment supplier preserves actual invocation and shares write admission while reads remain available', async () => {
 const request = { version: 1, threadIds: [A] }, invocation = { actor: 'bound' };
 let finish, seen;
 const handlers = createThreadAttachmentsSupplierHandlers(adapter({ assess: async (input, context) => { seen = context; return new Promise(resolve => { finish = resolve; }); } }));
 const pending = handlers[METHODS.assess](request, invocation); await Promise.resolve();
 expect(seen.rpcContext).toBe(invocation); expect(seen.signal.aborted).toBe(false);
 expect(await failure(handlers[METHODS.attach](attach, invocation))).toMatchObject({ kind: 'busy' });
 expect((await handlers[METHODS.read](read, invocation)).records[0].threadId).toBe(A);
 finish({ version: 1, state: 'queued', threadIds: [A] }); expect((await pending).state).toBe('queued');
});

test('whenIdle is immediate without transport/timer work and rejects already-aborted callers', async () => {
 let calls = 0;
 const client = createThreadAttachmentsClient(sdk(async () => { calls++; return output(read); }), 'authority');
 const originalSetTimeout = globalThis.setTimeout;
 let timers = 0;
 globalThis.setTimeout = (...args) => { timers++; return originalSetTimeout(...args); };
 let idle;
 try { idle = client.whenIdle(); } finally { globalThis.setTimeout = originalSetTimeout; }
 expect(await idle).toBeUndefined(); expect(calls).toBe(0); expect(timers).toBe(0);
 const controller = new AbortController(); controller.abort();
 expect(await failure(client.whenIdle(controller.signal))).toMatchObject({ kind: 'cancelled' });
 expect(calls).toBe(0);
});

test('whenIdle holds latest undispatched assessment until timed-out raw A settles, never replays A', async () => {
 const first = { version: 1, threadIds: [A] }, latest = { version: 1, threadIds: [B] };
 let finish; const requests = [];
 const client = createThreadAttachmentsClient(sdk(({ input }) => {
  requests.push(input);
  if (requests.length === 1) return new Promise(resolve => { finish = resolve; });
  return Promise.resolve({ version: 1, state: 'queued', threadIds: input.threadIds });
 }), 'authority');
 const failedA = await failure(client.assess(first));
 expect(failedA).toMatchObject({ kind: 'transient', outcome: 'unknown' });
 expect(await failure(client.assess(latest))).toMatchObject({ kind: 'busy', outcome: 'not-dispatched' });
 let ready = false; const idle = client.whenIdle().then(() => { ready = true; });
 await Promise.resolve(); expect(ready).toBe(false); expect(requests).toEqual([first]);
 finish({ version: 1, state: 'queued', threadIds: [A] });
 await idle; expect(ready).toBe(true);
 expect(await client.assess(latest)).toEqual({ version: 1, state: 'queued', threadIds: [B] });
 expect(requests).toEqual([first, latest]);
}, 7000);

test('whenIdle abort removes its waiter/listener while other waiters survive and raw rejection releases them', async () => {
 let rejectRaw;
 const client = createThreadAttachmentsClient(sdk(() => new Promise((_resolve, reject) => { rejectRaw = reject; })), 'authority');
 const requestController = new AbortController();
 const active = client.assess({ version: 1, threadIds: [A] }, requestController.signal); requestController.abort();
 expect(await failure(active)).toMatchObject({ outcome: 'unknown' });
 const waiterController = new AbortController(), listeners = new Set();
 const add = waiterController.signal.addEventListener.bind(waiterController.signal), remove = waiterController.signal.removeEventListener.bind(waiterController.signal);
 waiterController.signal.addEventListener = (type, fn, opts) => { if (type === 'abort') listeners.add(fn); add(type, fn, opts); };
 waiterController.signal.removeEventListener = (type, fn, opts) => { if (type === 'abort') listeners.delete(fn); remove(type, fn, opts); };
 const cancelled = client.whenIdle(waiterController.signal);
 let survivingResolved = false; const surviving = client.whenIdle().then(() => { survivingResolved = true; });
 expect(listeners.size).toBe(1); waiterController.abort();
 expect(await failure(cancelled)).toMatchObject({ kind: 'cancelled' }); expect(listeners.size).toBe(0);
 await Promise.resolve(); expect(survivingResolved).toBe(false);
 rejectRaw(new Error('Raw transport finally rejected'));
 await surviving; expect(survivingResolved).toBe(true);
 await client.whenIdle();
});

test('whenIdle cleans successful waiters atomically before next raw call and handles synchronous transport throws', async () => {
 let client, idleFromTransport;
 client = createThreadAttachmentsClient(sdk(() => { idleFromTransport = client.whenIdle(); throw new Error('Synchronous transport failure'); }), 'authority');
 expect(await failure(client.assess({ version: 1, threadIds: [A] }))).toMatchObject({ outcome: 'unknown' });
 await idleFromTransport; await client.whenIdle();
 let finish;
 const held = createThreadAttachmentsClient(sdk(() => new Promise(resolve => { finish = resolve; })), 'authority');
 const active = held.read(read);
 const controller = new AbortController(), listeners = new Set();
 const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
 controller.signal.addEventListener = (type, fn, opts) => { if (type === 'abort') listeners.add(fn); add(type, fn, opts); };
 controller.signal.removeEventListener = (type, fn, opts) => { if (type === 'abort') listeners.delete(fn); remove(type, fn, opts); };
 const one = held.whenIdle(controller.signal), two = held.whenIdle(controller.signal);
 expect(listeners.size).toBe(2); finish(output(read));
 await Promise.all([one, two, active]); expect(listeners.size).toBe(0);
 controller.abort();
});

test('observation has strict one-thread input and read-only exact one-record replies', async () => {
 const request = { version: 1, threadId: A };
 expect(ObserveInputV1Schema.parse(request)).toEqual(request);
 for (const invalid of [{ ...request, actor: 'forged' }, { ...request, threadIds: [A] }, { ...request, version: 2 }, { ...request, threadId: A + '\n' }, { version: 1 }]) expect(ObserveInputV1Schema.safeParse(invalid).success).toBe(false);
 for (const ids of [[B], [A, B], []]) {
  const client = createThreadAttachmentsClient(sdk(async () => output({ threadIds: ids })), 'authority');
  expect(await failure(client.observe(request))).toMatchObject({ kind: 'incompatible', outcome: 'not-dispatched' });
  const handlers = createThreadAttachmentsSupplierHandlers(adapter({ observe: async () => output({ threadIds: ids }) }));
  expect(await failure(handlers[METHODS.observe](request, null))).toBeInstanceOf(Error);
 }
 const client = createThreadAttachmentsClient(sdk(async () => ({ ...output({ threadIds: [A] }), future: true })), 'authority');
 expect((await client.observe(request)).future).toBe(true);
});

test('two raw observation permits are independent from ordinary read and write admission', async () => {
 const observations = [], reads = [], invocation = { boundActor: true };
 const started = performance.now();
 const handlers = createThreadAttachmentsSupplierHandlers(adapter({
  observe: (input, context) => new Promise(resolve => observations.push({ resolve, input, context })),
  read: (input, context) => new Promise(resolve => reads.push({ resolve, input, context })),
 }));
 const o1 = handlers[METHODS.observe]({ version: 1, threadId: A }, invocation), o2 = handlers[METHODS.observe]({ version: 1, threadId: B }, invocation);
 const r1 = handlers[METHODS.read](read, invocation), r2 = handlers[METHODS.read](read, invocation);
 await Promise.resolve();
 expect(observations.length).toBe(LIMITS.supplierObservations); expect(reads.length).toBe(LIMITS.supplierReads);
 expect(await failure(handlers[METHODS.observe]({ version: 1, threadId: C }, invocation))).toMatchObject({ kind: 'busy' });
 expect(await failure(handlers[METHODS.read](read, invocation))).toMatchObject({ kind: 'busy' });
 expect((await handlers[METHODS.assess]({ version: 1, threadIds: [A] }, invocation)).state).toBe('queued');
 expect(observations[0].context.rpcContext).toBe(invocation);
 expect(observations[0].context.deadlineAt - started).toBeLessThanOrEqual(LIMITS.observationMs + 5);
 expect(reads[0].context.deadlineAt - started).toBeGreaterThan(LIMITS.observationMs);
 for (const item of observations) item.resolve(output({ threadIds: [item.input.threadId] }));
 for (const item of reads) item.resolve(output(item.input));
 await Promise.all([o1, o2, r1, r2]);
});

test('queued assessment acknowledgement is distinct from event-backed observation completion without polling', async () => {
 let facts = { ...record(A), state: 'unassessed' }, publish;
 let observeCalls = 0, assessCalls = 0;
 const { host } = hostClient(adapter({
  assess: async input => { assessCalls++; return { version: 1, state: 'queued', threadIds: input.threadIds }; },
  read: async () => ({ version: 1, revision: 'r1', records: [facts] }),
  observe: async input => { observeCalls++; return new Promise(resolve => { publish = () => resolve({ version: 1, revision: 'r2', records: [{ ...facts, threadId: input.threadId }] }); }); },
 }));
 const transport = sdk(({ method, input }) => host.harness.behavior.callRpc(method, input));
 const scheduling = createThreadAttachmentsClient(transport, 'authority'), observing = createThreadAttachmentsClient(transport, 'authority');
 expect((await scheduling.assess({ version: 1, threadIds: [A] })).state).toBe('queued');
 expect((await scheduling.read(read)).records[0].state).toBe('unassessed');
 let completed = false; const result = observing.observe({ version: 1, threadId: A }).then(value => { completed = true; return value; });
 for (let i = 0; i < 10 && !publish; i++) await Promise.resolve();
 expect(completed).toBe(false); expect(observeCalls).toBe(1); expect(assessCalls).toBe(1);
 facts = { threadId: A, state: 'attached', leadId: B, sourceId: B, provenance: 'automatic', operationId: null };
 publish(); expect((await result).records[0].state).toBe('attached');
 expect(observeCalls).toBe(1); expect(assessCalls).toBe(1);
});

test('ordinary observation expiry returns current unknown snapshot within 2500ms wait budget and outer guard', async () => {
 let callbackBudget;
 const { client } = hostClient(adapter({ observe: async (input, context) => {
  callbackBudget = context.deadlineAt - performance.now();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, callbackBudget)));
  return { version: 1, revision: 'r1', records: [{ ...record(input.threadId), state: 'unassessed' }] };
 } }));
 const started = performance.now(); const result = await client.observe({ version: 1, threadId: A });
 expect(callbackBudget).toBeLessThanOrEqual(LIMITS.observationMs);
 expect(callbackBudget).toBeGreaterThan(2400);
 expect(performance.now() - started).toBeLessThan(LIMITS.supplierMs);
 expect(result.records[0].state).toBe('unassessed');
}, 5000);

test('aborted observation retains one client raw slot, releases at settlement and never schedules another call', async () => {
 let finish, calls = 0;
 const client = createThreadAttachmentsClient(sdk(() => { calls++; return new Promise(resolve => { finish = resolve; }); }), 'authority');
 const controller = new AbortController(); const pending = client.observe({ version: 1, threadId: A }, controller.signal); controller.abort();
 expect(await failure(pending)).toMatchObject({ kind: 'cancelled', outcome: 'not-dispatched' });
 expect(await failure(client.read(read))).toMatchObject({ kind: 'busy' });
 const idle = client.whenIdle(); finish(output(read)); await idle;
 expect(calls).toBe(1);
});
