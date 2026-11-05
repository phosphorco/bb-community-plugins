/** Injected BB adapters. SDK imports are types only. */
import type { BbPluginApi, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { z, type ZodType } from 'zod';
import {
 LIMITS, METHODS, PROTOCOL, WIRE_VERSIONS, DescribeV1Schema,
 ReadInputV1Schema, ReadOutputV1Schema, FamilyInputV1Schema, FamilyOutputV1Schema,
 AttachInputV1Schema, DetachInputV1Schema, WriteOutputV1Schema, AssessInputV1Schema, AssessOutputV1Schema, ObserveInputV1Schema,
 canonicalJsonWithin, plainJsonSnapshot, negotiateVersion, readViolation, familyViolation, writeViolation, assessViolation, reconcileWrite,
 type ReadInputV1, type ReadOutputV1, type FamilyInputV1, type FamilyOutputV1,
 type AttachInputV1, type DetachInputV1, type WriteOutputV1, type AssessInputV1, type AssessOutputV1, type ObserveInputV1,
} from './index.js';

export type AttachmentErrorKind = 'absent' | 'vanished' | 'host-incompatible' | 'unavailable' | 'incompatible' | 'error' | 'unauthorized' | 'cancelled' | 'transient' | 'busy' | 'invalid-input';
export class AttachmentCallError extends Error {
 constructor(readonly kind: AttachmentErrorKind, readonly cause?: unknown, readonly outcome: 'not-dispatched' | 'unknown' = 'not-dispatched') {
  super(`Thread attachments call failed: ${kind}`); this.name = 'AttachmentCallError';
 }
}
export function classifyAttachmentError(error: unknown): AttachmentErrorKind {
  if (error instanceof AttachmentCallError) return error.kind;
  const e = error as { name?: string; status?: number; body?: unknown } | null;
  if (e?.name === 'AbortError') return 'cancelled';
  if (e?.name === 'TimeoutError') return 'transient';
  if (e?.name === 'ZodError') return 'incompatible';
  const body = e?.body;
  const bodyError = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const code = typeof bodyError === 'string' ? bodyError : bodyError && typeof bodyError === 'object' ? (bodyError as { code?: unknown }).code : typeof body === 'string' ? body : undefined;
  // The host answers an unknown plugin with `{ok:false, error:'unknown plugin "<id>"'}` (a string),
  // and older hosts with a bare string body; both mean the source plugin is gone.
  const message = typeof bodyError === 'string' ? bodyError : typeof body === 'string' ? body : '';
  if (e?.status === 404) {
    if (code === 'unknown_method') return 'absent';
    if (/^unknown plugin\b/i.test(message)) return 'vanished';
    return 'host-incompatible';
  }
  if (e?.status === 503) return 'unavailable';
  if (e?.status === 401 || e?.status === 403) return 'unauthorized';
  if ((e?.status === 400 && code === 'invalid_input') || (e?.status === 500 && code === 'invalid_output')) return 'incompatible';
  if (e?.status === 500) return 'error';
  return 'transient';
}

/** Zod → the SDK's Standard Schema shape (same adapter as the sibling contract packages). */
function sdkSchema<T>(schema: ZodType<T>): StandardSchemaV1<T> {
  return { '~standard': {
    version: 1,
    vendor: 'bb-thread-attachments',
    jsonSchema: {
      input: () => schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      output: () => schema.toJSONSchema({ io: 'output', unrepresentable: 'any' }),
    },
    validate(value) {
      const result = schema.safeParse(value);
      return result.success ? { value: result.data } : { issues: result.error.issues.map(issue => ({ message: issue.message, path: issue.path.map(key => typeof key === 'symbol' ? String(key) : key) })) };
    },
  } } as StandardSchemaV1<T>;
}

function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, deadlineAt: number, outer?: AbortSignal): Promise<T> {
  if (outer?.aborted) return Promise.reject(new DOMException('Aborted before start', 'AbortError'));
  if (performance.now() >= deadlineAt) return Promise.reject(new DOMException('Deadline passed before start', 'TimeoutError'));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
      settle();
    };
    const timer = setTimeout(() => {
      const error = new DOMException('Timed out', 'TimeoutError');
      controller.abort(error);
      finish(() => reject(error));
    }, Math.max(0, deadlineAt - performance.now()));
    const onAbort = () => {
      controller.abort(outer?.reason);
      finish(() => reject(new DOMException('Aborted', 'AbortError')));
    };
    outer?.addEventListener('abort', onAbort, { once: true });
    let flight: Promise<T>;
    try { flight = run(controller.signal); }
    catch (error) { finish(() => reject(error)); return; }
    // Both handlers stay attached, so a late settlement is consumed, never unhandled.
    // A transport can block synchronously past the deadline and still fulfil before the
    // overdue timer runs; the absolute monotonic deadline is checked on fulfilment too.
    flight.then(
      value => finish(() => performance.now() > deadlineAt ? reject(new DOMException('Timed out', 'TimeoutError')) : resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

/** Describe accepts unknown input for forward-compatible probes; clients send null. */
export const threadAttachmentsRpcContract = {
 [METHODS.describe]: { input: sdkSchema(z.unknown()), output: sdkSchema(DescribeV1Schema) },
 [METHODS.read]: { input: sdkSchema(ReadInputV1Schema), output: sdkSchema(ReadOutputV1Schema) },
 [METHODS.observe]: { input: sdkSchema(ObserveInputV1Schema), output: sdkSchema(ReadOutputV1Schema) },
 [METHODS.assess]: { input: sdkSchema(AssessInputV1Schema), output: sdkSchema(AssessOutputV1Schema) },
 [METHODS.family]: { input: sdkSchema(FamilyInputV1Schema), output: sdkSchema(FamilyOutputV1Schema) },
 [METHODS.attach]: { input: sdkSchema(AttachInputV1Schema), output: sdkSchema(WriteOutputV1Schema) },
 [METHODS.detach]: { input: sdkSchema(DetachInputV1Schema), output: sdkSchema(WriteOutputV1Schema) },
};
export interface AttachmentSupplierContext<Context = unknown> {
 readonly signal: AbortSignal;
 /** Absolute monotonic performance.now deadline; commit policy stays with authority. */
 readonly deadlineAt: number;
 /** Exact original request context (e.g. actual BbInvocation); never reconstructed. */
 readonly rpcContext: Context;
}
export interface ThreadAttachmentsSupplierHandlers<Context = unknown> {
 /** Event-backed wait up to context.deadlineAt, then current snapshot. No history I/O or writes. */
 observe(input: ObserveInputV1, context: AttachmentSupplierContext<Context>): ReadOutputV1 | Promise<ReadOutputV1>;
 /** Durably prioritize eligible unknown candidates only; never overwrite facts or perform history I/O here. */
 assess(input: AssessInputV1, context: AttachmentSupplierContext<Context>): AssessOutputV1 | Promise<AssessOutputV1>;
 read(input: ReadInputV1, context: AttachmentSupplierContext<Context>): ReadOutputV1 | Promise<ReadOutputV1>;
 family(input: FamilyInputV1, context: AttachmentSupplierContext<Context>): FamilyOutputV1 | Promise<FamilyOutputV1>;
 attach(input: AttachInputV1, context: AttachmentSupplierContext<Context>): WriteOutputV1 | Promise<WriteOutputV1>;
 detach(input: DetachInputV1, context: AttachmentSupplierContext<Context>): WriteOutputV1 | Promise<WriteOutputV1>;
}
/** Use this factory with identity.server.registerRpc to preserve actual actor binding. */
export function createThreadAttachmentsSupplierHandlers<Context = unknown>(adapter: ThreadAttachmentsSupplierHandlers<Context>) {
 const active = { read: 0, write: 0, observe: 0 };
 const capacity = { read: LIMITS.supplierReads, write: LIMITS.supplierWrites, observe: LIMITS.supplierObservations };
 function wrap<I, O>(inputSchema: ZodType<I>, outputSchema: ZodType<O>, lane: 'read' | 'write' | 'observe',
   run: (input: I, context: AttachmentSupplierContext<Context>) => O | Promise<O>, violation: (input: I, output: O) => string | null) {
  return async (input: I, rpcContext: Context): Promise<O> => {
   if (canonicalJsonWithin(input, LIMITS.inputBytes) === null) throw new AttachmentCallError('invalid-input');
   const parsed = inputSchema.parse(plainJsonSnapshot(input));
   if (active[lane] >= capacity[lane]) throw new AttachmentCallError('busy');
   const startedAt = performance.now();
   const deadlineAt = startedAt + LIMITS.supplierMs;
   const workDeadlineAt = lane === 'observe' ? startedAt + LIMITS.observationMs : deadlineAt;
   return withDeadline(signal => {
    active[lane]++;
    // Permits remain held until raw work settles, including after the local deadline.
    const raw = Promise.resolve().then(() => run(parsed, { signal, deadlineAt: workDeadlineAt, rpcContext }));
    const release = () => { active[lane]--; };
    raw.then(release, release);
    return raw;
   }, deadlineAt).then(output => {
    if (canonicalJsonWithin(output, LIMITS.responseBytes) === null) throw new AttachmentCallError('incompatible');
    const decoded = outputSchema.parse(output);
    const reason = violation(parsed, decoded);
    if (reason) throw new AttachmentCallError('incompatible', new Error(reason));
    if (performance.now() > deadlineAt) throw new DOMException('Supplier deadline passed', 'TimeoutError');
    return decoded;
   });
  };
 }
 return {
  [METHODS.describe]: (input: unknown, _context?: Context) => {
   if (canonicalJsonWithin(input ?? null, LIMITS.inputBytes) === null) throw new AttachmentCallError('invalid-input');
   return { protocol: PROTOCOL, versions: [...WIRE_VERSIONS] };
  },
  [METHODS.observe]: wrap(ObserveInputV1Schema, ReadOutputV1Schema, 'observe', adapter.observe.bind(adapter), (input, output) => readViolation({ version: 1, threadIds: [input.threadId] }, output)),
  [METHODS.read]: wrap(ReadInputV1Schema, ReadOutputV1Schema, 'read', adapter.read.bind(adapter), readViolation),
  [METHODS.assess]: wrap(AssessInputV1Schema, AssessOutputV1Schema, 'write', adapter.assess.bind(adapter), assessViolation),
  [METHODS.family]: wrap(FamilyInputV1Schema, FamilyOutputV1Schema, 'read', adapter.family.bind(adapter), familyViolation),
  [METHODS.attach]: wrap(AttachInputV1Schema, WriteOutputV1Schema, 'write', adapter.attach.bind(adapter), writeViolation),
  [METHODS.detach]: wrap(DetachInputV1Schema, WriteOutputV1Schema, 'write', adapter.detach.bind(adapter), writeViolation),
 };
}
export function registerThreadAttachmentsSupplier(bb: Pick<BbPluginApi, 'rpc'>, adapter: ThreadAttachmentsSupplierHandlers): void {
 bb.rpc.register(threadAttachmentsRpcContract, createThreadAttachmentsSupplierHandlers(adapter) as never, { experimental_discoverable: true });
}
export type AttachmentsSdk = { plugins: Pick<BbPluginApi['sdk']['plugins'], 'callRpc'> };
export interface ThreadAttachmentsClient {
 readonly pluginId: string;
 /** Local transport settlement only: no RPC, timer, retry or reservation for the next call. */
 whenIdle(signal?: AbortSignal): Promise<void>;
 describe(signal?: AbortSignal): Promise<{ version: 1 } | null>;
 /** Explicit view wake, never automatically replayed; dispatched failure has unknown outcome. */
 assess(input: AssessInputV1, signal?: AbortSignal): Promise<AssessOutputV1>;
 /** Bounded event-backed observation; returned unknown state is not proof of no attachment. */
 observe(input: ObserveInputV1, signal?: AbortSignal): Promise<ReadOutputV1>;
 read(input: ReadInputV1, signal?: AbortSignal): Promise<ReadOutputV1>;
 family(input: FamilyInputV1, signal?: AbortSignal): Promise<FamilyOutputV1>;
 attach(input: AttachInputV1, signal?: AbortSignal): Promise<WriteOutputV1>;
 detach(input: DetachInputV1, signal?: AbortSignal): Promise<WriteOutputV1>;
}
/** Keep one client per authority per consumer lifetime. No retries, globals, caches or timers at idle. */
export function createThreadAttachmentsClient(sdk: AttachmentsSdk, pluginId: string): ThreadAttachmentsClient {
 let outstanding: object | null = null;
 const idleWaiters = new Set<() => void>();
 function whenIdle(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AttachmentCallError('cancelled'));
  if (!outstanding) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
   const cleanup = () => {
    idleWaiters.delete(onIdle);
    signal?.removeEventListener('abort', onAbort);
   };
   const onIdle = () => { cleanup(); resolve(); };
   const onAbort = () => { cleanup(); reject(new AttachmentCallError('cancelled')); };
   idleWaiters.add(onIdle);
   signal?.addEventListener('abort', onAbort, { once: true });
   if (signal?.aborted) onAbort();
  });
 }
 async function call<T>(method: string, input: unknown, maxBytes: number, accept: (value: unknown) => T, write: boolean, signal?: AbortSignal): Promise<T> {
  const deadlineAt = performance.now() + LIMITS.clientMs;
  if (signal?.aborted) throw new AttachmentCallError('cancelled');
  if (outstanding) throw new AttachmentCallError('busy');
  let dispatched = false;
  try {
   const wire = plainJsonSnapshot(input);
   if (canonicalJsonWithin(wire, LIMITS.inputBytes) === null) throw new AttachmentCallError('invalid-input');
   const value = await withDeadline(s => {
    const token = {}; outstanding = token; // reserve before injected transport can re-enter
    const release = () => {
     if (outstanding !== token) return;
     outstanding = null;
     // Clear the set atomically with admission release before waking any waiter.
     const ready = [...idleWaiters];
     idleWaiters.clear();
     for (const notify of ready) notify();
    };
    let raw: Promise<unknown>;
    try {
     dispatched = true;
     raw = Promise.resolve(sdk.plugins.callRpc({ pluginId, method, input: wire, outputSchema: z.unknown(), signal: s }));
    } catch (error) { release(); throw error; }
    raw.then(release, release);
    return raw;
   }, deadlineAt, signal);
   try { if (canonicalJsonWithin(value, maxBytes) === null) throw new AttachmentCallError('incompatible'); }
   catch (error) { throw new AttachmentCallError('incompatible', error); }
   const output = accept(value);
   if (performance.now() > deadlineAt) throw new DOMException('Client deadline passed', 'TimeoutError');
   return output;
  } catch (error) {
   const kind = signal?.aborted ? 'cancelled' : classifyAttachmentError(error);
   throw new AttachmentCallError(kind, error, write && dispatched ? 'unknown' : 'not-dispatched');
  }
 }
 function operation<I, O>(method: string, schema: ZodType<I>, output: ZodType<O>, violation: (input: I, output: O) => string | null, write: boolean) {
  return async (input: I, signal?: AbortSignal): Promise<O> => {
   let parsed: I;
   try {
    if (canonicalJsonWithin(input, LIMITS.inputBytes) === null) throw new Error('Input byte limit');
    parsed = schema.parse(plainJsonSnapshot(input));
   }
   catch (error) { throw new AttachmentCallError('invalid-input', error); }
   return call(method, parsed, LIMITS.responseBytes, value => {
    const result = output.safeParse(value);
    if (!result.success) throw new AttachmentCallError('incompatible', result.error);
    const reason = violation(parsed, result.data);
    if (reason) throw new AttachmentCallError('incompatible', new Error(reason));
    return result.data;
   }, write, signal);
  };
 }
 return {
  pluginId,
  whenIdle,
  describe: signal => call(METHODS.describe, null, LIMITS.describeBytes, negotiateVersion, false, signal),
  assess: operation(METHODS.assess, AssessInputV1Schema, AssessOutputV1Schema, assessViolation, true),
  observe: operation(METHODS.observe, ObserveInputV1Schema, ReadOutputV1Schema, (input, output) => readViolation({ version: 1, threadIds: [input.threadId] }, output), false),
  read: operation(METHODS.read, ReadInputV1Schema, ReadOutputV1Schema, readViolation, false),
  family: operation(METHODS.family, FamilyInputV1Schema, FamilyOutputV1Schema, familyViolation, false),
  attach: operation(METHODS.attach, AttachInputV1Schema, WriteOutputV1Schema, writeViolation, true),
  detach: operation(METHODS.detach, DetachInputV1Schema, WriteOutputV1Schema, writeViolation, true),
 };
}
/** One explicit fresh read, never a write replay. May remain unknown (including busy raw transport). */
export async function reconcileUnknownWrite(client: ThreadAttachmentsClient, input: AttachInputV1 | DetachInputV1, signal?: AbortSignal): Promise<{ state: 'observed' | 'unknown'; fresh: ReadOutputV1 | null }> {
 try {
  const fresh = await client.read({ version: 1, threadIds: [input.threadId] }, signal);
  return { state: reconcileWrite(input, fresh), fresh };
 } catch { return { state: 'unknown', fresh: null }; }
}

export interface AttachmentDiscoveryRow {
 pluginId: string;
 state: 'ready' | 'incompatible' | 'absent' | 'unavailable' | 'error';
 error?: AttachmentErrorKind;
}
/** Retain per consumer lifetime: repeated refreshes cannot accumulate ignored-abort RPCs.
 * Listed discovery is explicit; this factory schedules no polls or lifecycle work.
 */
export function createThreadAttachmentsDiscovery(sdk: Pick<BbPluginApi['sdk'], 'plugins'>) {
 const clients = new Map<string, ThreadAttachmentsClient>();
 let pass = false, listing = false, rawProbes = 0;
 const boundedSdk: AttachmentsSdk = { plugins: { callRpc(args) {
  if (rawProbes >= LIMITS.discoveryConcurrency) throw new AttachmentCallError('busy');
  rawProbes++;
  try {
   const raw = sdk.plugins.callRpc(args);
   const release = () => { rawProbes--; };
   raw.then(release, release);
   return raw;
  } catch (error) { rawProbes--; throw error; }
 } } };
 return { async discover(signal?: AbortSignal): Promise<AttachmentDiscoveryRow[]> {
  if (signal?.aborted) throw new AttachmentCallError('cancelled');
  if (pass || listing) throw new AttachmentCallError('busy');
  pass = true;
  try {
   const listed = await withDeadline(s => {
    listing = true;
    try {
     const raw = sdk.plugins.list({ signal: s });
     const release = () => { listing = false; };
     raw.then(release, release);
     return raw;
    } catch (error) { listing = false; throw error; }
   }, performance.now() + LIMITS.clientMs, signal);
   const ids = [...new Set(listed.plugins.filter(p => p.status === 'running' || p.status === 'degraded').map(p => p.id))];
   const rows: AttachmentDiscoveryRow[] = [];
   let cursor = 0;
   await Promise.all(Array.from({ length: Math.min(LIMITS.discoveryConcurrency, ids.length) }, async () => {
    while (cursor < ids.length && !signal?.aborted) {
     const pluginId = ids[cursor++]!;
     let client = clients.get(pluginId);
     if (!client) { client = createThreadAttachmentsClient(boundedSdk, pluginId); clients.set(pluginId, client); }
     try {
      const version = await client.describe(signal);
      rows.push({ pluginId, state: version ? 'ready' : 'incompatible' });
     } catch (error) {
      const kind = classifyAttachmentError(error);
      rows.push({ pluginId, state: kind === 'absent' ? 'absent' : ['vanished', 'unavailable', 'cancelled', 'transient', 'busy'].includes(kind) ? 'unavailable' : 'error', error: kind });
     }
    }
   }));
   return rows.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  } finally { pass = false; }
 } };
}
/** One-shot convenience. For refresh/reconnect, retain createThreadAttachmentsDiscovery instead. */
export function discoverThreadAttachmentsSuppliers(sdk: Pick<BbPluginApi['sdk'], 'plugins'>, signal?: AbortSignal): Promise<AttachmentDiscoveryRow[]> {
 return createThreadAttachmentsDiscovery(sdk).discover(signal);
}
