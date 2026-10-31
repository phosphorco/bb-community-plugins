import { ZodError, type ZodType } from 'zod';
import {
  LIMITS, METHODS, PROTOCOL, InputSchemas, UnknownResultSchema, PluginIdSchema,
  DescribeEnvelopeSchema, RecognizeInputSchema, ResolveInputSchema, FeedInputSchema,
  InvalidateInputSchema, InvalidateOutputSchema, decodeInput, decodeOutput,
  canonicalJson, negotiateVersion, validateRecognizeInput, correlateRecognizeOutput,
  correlateResolveOutput, correlateFeedOutput,
  SOURCE_FAULT_BYTES, ResultsSourceFaultSchema,
  ResultsContractError, JsonAdmissionError,
} from './index.js';
import type {
  JsonValue, CapabilitiesV1, KindDescriptor, RecognizeInput, RecognizeOutput,
  ResolveInput, ResolveOutput, FeedInput, FeedOutput, InvalidateInput, InvalidateOutput,
  ResultRoute, FileIdentity, ResultsSourceFault,
} from './index.js';

/** Structural public SDK ports. No SDK import survives in JS OR declarations. */
export interface RpcPort {
  callRpc<T>(args: { pluginId: string; method: string; input?: JsonValue;
    outputSchema: ZodType<T>; signal?: AbortSignal }): Promise<T>;
}
export interface ListedResultPlugin { id: string; enabled: boolean; status: string }
export interface PluginListPort {
  list(args?: { signal?: AbortSignal }): Promise<{ plugins: readonly ListedResultPlugin[] }>;
}
export interface ResultStandardSchema<I = unknown, O = I> {
  readonly '~standard': {
    readonly version: 1; readonly vendor: string;
    readonly validate: (value: unknown) => { readonly value: O; readonly issues?: undefined }
      | { readonly issues: readonly { readonly message: string; readonly path?: readonly PropertyKey[] }[] };
    readonly jsonSchema: {
      readonly input: (options: { target: string }) => Record<string, unknown>;
      readonly output: (options: { target: string }) => Record<string, unknown>;
    };
    readonly types?: { readonly input: I; readonly output: O };
  };
}
export interface ResultRpcContext {
  readonly experimental_caller: { readonly kind: 'client' } | { readonly kind: 'plugin'; readonly pluginId: string };
}
export interface RegistrationPort {
  rpc: { register(contract: Readonly<Record<string, { input: ResultStandardSchema; output: ResultStandardSchema }>>,
    handlers: Readonly<Record<string, (input: unknown, context: ResultRpcContext) => unknown | Promise<unknown>>>,
    options?: { experimental_discoverable?: boolean; experimental_description?: string }): void };
  onDispose?(handler: () => void): void;
}
export interface ResultNavigationPort {
  experimental_openFilePreview(options: { target: FileIdentity; location: null }): boolean;
  openUrl(url: string): boolean;
  toThread(threadId: string, options?: { split?: boolean }): void;
  /** Optional consumer-owned provenance panel; native toThread has no event seek. */
  showSource?(source: { threadId: string; eventId: string; seq: number }): void;
}
export type ResultsErrorKind = 'unknown-method' | 'unknown-plugin' | 'disabled' | 'not-running'
  | 'incompatible' | 'unauthorized' | 'aborted' | 'timeout' | 'stale' | 'source-error' | 'transport-error';
export class ResultsCallError extends Error {
  constructor(readonly kind: ResultsErrorKind, readonly reason?: 'call-deadline' | 'overall-deadline',
    readonly cause?: unknown) { super(`Turn results call failed: ${kind}`); this.name = 'ResultsCallError'; }
}
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
/** Recognize actual status + structured/string body.error; legacy strings are
 * whole-body matches only. A substring in unrelated source text is not routing.
 */
export function classifyResultsError(error: unknown): ResultsErrorKind {
  if (error instanceof ResultsCallError) return error.kind;
  const e = record(error);
  if (e?.name === 'AbortError') return 'aborted';
  if (e?.name === 'TimeoutError') return 'timeout';
  if (e?.name === 'ZodError') return 'incompatible';
  const body = e?.body;
  const detail = record(body)?.error ?? body;
  const code = record(detail)?.code;
  if (e?.status === 401 || e?.status === 403 || code === 'unauthenticated') return 'unauthorized';
  if (e?.status === 404 && code === 'unknown_method') return 'unknown-method';
  if (e?.status === 404 && (code === 'unknown_plugin' || typeof detail === 'string'
    && /^unknown plugin "[a-z][a-z0-9-]{0,63}"$/u.test(detail))) return 'unknown-plugin';
  if (e?.status === 503 && code === 'plugin_disabled') return 'disabled';
  if (e?.status === 503 && code === 'unavailable') return 'not-running';
  if (e?.status === 503 && typeof detail === 'string') {
    const match = /^plugin "[a-z][a-z0-9-]{0,63}" is not running \(status: ([a-z-]+)(?: — [^\r\n)]{1,512})?\)$/u.exec(detail);
    if (match) return match[1] === 'disabled' ? 'disabled' : 'not-running';
  }
  if (typeof code === 'string' && ['invalid_input', 'invalid_json', 'invalid_output', 'non_json_result'].includes(code)) return 'incompatible';
  if (code === 'handler_error' || e?.status === 500) return 'source-error';
  return 'transport-error';
}
function classified(error: unknown): ResultsCallError {
  return error instanceof ResultsCallError ? error : new ResultsCallError(classifyResultsError(error), undefined, error);
}
/** Source faults cross native RPC as JSON; exceptions/classes do not survive it.
 * A fault never advances cursor/debt or substitutes for a correlated outcome.
 */
function decodeSourceFault(raw: unknown, method: string): void {
  // Admit the whole raw response before inspecting even a reserved discriminator.
  normalize(() => canonicalJson(raw, LIMITS.responseBytes));
  if (record(raw)?.protocol !== 'bb-turn-results-fault') return;
  const fault = normalize(() => {
    canonicalJson(raw, SOURCE_FAULT_BYTES);
    return ResultsSourceFaultSchema.parse(raw);
  });
  if (fault.method !== method) throw new ResultsCallError('incompatible');
  throw new ResultsCallError(fault.code);
}
function sourceFault(method: string, error: unknown): ResultsSourceFault {
  const kind = error instanceof ResultsCallError ? error.kind : 'source-error';
  const code = kind === 'timeout' || kind === 'incompatible' || kind === 'aborted' || kind === 'stale' ? kind : 'source-error';
  // Only fixed public codes; no source exception text, stack, receipt or token.
  return ResultsSourceFaultSchema.parse({ protocol: 'bb-turn-results-fault', version: 1, method, code });
}
function incompatible(error: unknown): never { throw new ResultsCallError('incompatible', undefined, error); }
function normalize<T>(work: () => T): T { try { return work(); } catch (error) { return incompatible(error); } }
async function correlate<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { return incompatible(error); }
}
async function sourceCall<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ResultsCallError) throw error;
    // These typed failures are classified locally, before native RPC serializes
    // the public JSON fault. Arbitrary source/I/O exceptions remain source-error.
    const kind = error instanceof ResultsContractError || error instanceof JsonAdmissionError || error instanceof ZodError
      ? 'incompatible' : 'source-error';
    throw new ResultsCallError(kind, undefined, error);
  }
}
function budget(value: number | undefined, ceiling: number): number {
  return value === undefined ? ceiling : Number.isFinite(value) ? Math.max(0, Math.min(ceiling, value)) : 0;
}
export interface ResultsBudgets {
  describeMs?: number; recognizeMs?: number; resolveMs?: number; feedMs?: number;
  invalidateMs?: number; discoveryMs?: number; concurrency?: number; processingSlots?: number;
}
export interface ResultsClientOptions {
  budgets?: ResultsBudgets; signal?: AbortSignal; overallDeadline?: number;
  current?: () => boolean; descriptors?: readonly KindDescriptor[];
}
function joined(...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}
/** Entire task, including async input/digest/output correlation, is fenced.
 * Abort is local evidence only; native RPC has no cancellation acknowledgement.
 */
async function isolated<T>(work: (signal: AbortSignal, check: () => void) => Promise<T> | T,
  ms: number, options: { signal?: AbortSignal; overallDeadline?: number; current?: () => boolean } = {}): Promise<T> {
  const start = performance.now();
  const overall = options.overallDeadline === undefined ? Infinity
    : Number.isFinite(options.overallDeadline) ? options.overallDeadline : -Infinity;
  const callEnd = start + ms, end = Math.min(callEnd, overall);
  const timeout = () => new ResultsCallError('timeout', overall <= callEnd ? 'overall-deadline' : 'call-deadline');
  const controller = new AbortController();
  const check = () => {
    if (options.signal?.aborted) throw new ResultsCallError('aborted');
    if (options.current && !options.current()) throw new ResultsCallError('stale');
    if (performance.now() >= end) throw timeout();
    if (controller.signal.aborted) throw new ResultsCallError('aborted');
  };
  check();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (value: T | undefined, error?: unknown) => {
        if (done) return;
        done = true;
        if (error !== undefined) reject(classified(error)); else resolve(value as T);
      };
      abort = () => { finish(undefined, new ResultsCallError('aborted')); controller.abort(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { finish(undefined, timeout()); controller.abort(); }, Math.max(0, Math.ceil(end - performance.now())));
      Promise.resolve().then(() => { check(); return work(controller.signal, check); })
        .then(value => { try { check(); finish(value); } catch (error) { finish(undefined, error); } }, error => {
          try { check(); finish(undefined, error); } catch (fenced) { finish(undefined, fenced); }
        });
    });
  } finally {
    clearTimeout(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}
function json(value: unknown): JsonValue {
  // Validated plain finite JSON, no undefined/accessors/functions, before cast.
  canonicalJson(value, LIMITS.inputBytes);
  return value as JsonValue;
}
function schema<T>(value: ZodType<T>, enforceInput = false, emptyAsNull = false): ResultStandardSchema<unknown, T> {
  return { '~standard': { version: 1, vendor: 'bb-turn-results',
    jsonSchema: { input: () => value.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      output: () => value.toJSONSchema({ io: 'output', unrepresentable: 'any' }) },
    validate(input) {
      const raw = emptyAsNull && input === undefined ? null : input;
      if (enforceInput) {
        try { canonicalJson(raw, LIMITS.inputBytes); }
        catch { return { issues: [{ message: 'Raw RPC input exceeds JSON admission bounds.' }] }; }
      }
      const parsed = value.safeParse(raw);
      return parsed.success ? { value: parsed.data }
        : { issues: parsed.error.issues.map(issue => ({ message: issue.message, path: issue.path })) };
    },
  } };
}
type SupplierSdk = { plugins: RpcPort };
export interface ResultsSupplierClient {
  readonly pluginId: string;
  describe(signal?: AbortSignal): Promise<ReturnType<typeof negotiateVersion>>;
  recognize(input: RecognizeInput, signal?: AbortSignal): Promise<RecognizeOutput>;
  resolve(input: ResolveInput, signal?: AbortSignal): Promise<ResolveOutput>;
  enumerate(input: FeedInput, signal?: AbortSignal): Promise<FeedOutput>;
}
export interface ResultsConsumerClient {
  readonly pluginId: string;
  invalidate(input: InvalidateInput, signal?: AbortSignal): Promise<InvalidateOutput>;
}
function clientCall(sdk: SupplierSdk, pluginId: string, options: ResultsClientOptions) {
  return async <T>(method: string, cap: number, signal: AbortSignal | undefined,
    work: (request: (input: unknown) => Promise<unknown>, check: () => void) => Promise<T>): Promise<T> => {
    try {
      return await isolated(async (bounded, check) => work(async input => {
        check();
        const raw = await sdk.plugins.callRpc({ pluginId, method, input: normalize(() => json(input)),
          outputSchema: UnknownResultSchema, signal: bounded });
        check();
        decodeSourceFault(raw, method);
        return raw;
      }, check), cap, { signal: joined(options.signal, signal),
        ...(options.overallDeadline === undefined ? {} : { overallDeadline: options.overallDeadline }),
        ...(options.current ? { current: options.current } : {}) });
    } catch (error) { throw classified(error); }
  };
}
export function createResultsSupplierClient(sdk: SupplierSdk, listedPluginId: string,
  options: ResultsClientOptions = {}): ResultsSupplierClient {
  const pluginId = normalize(() => PluginIdSchema.parse(listedPluginId));
  const call = clientCall(sdk, pluginId, options);
  return {
    pluginId,
    describe: signal => call(METHODS.describe, budget(options.budgets?.describeMs, LIMITS.describeMs), signal,
      async request => negotiateVersion(await request(null))),
    recognize: (input, signal) => call(METHODS.recognize, budget(options.budgets?.recognizeMs, LIMITS.recognizeMs), signal,
      async (request, check) => {
        const parsed = await correlate(() => validateRecognizeInput(input)); check();
        const raw = await request(parsed);
        return correlate(() => correlateRecognizeOutput(parsed, raw, options.descriptors));
      }),
    resolve: (input, signal) => call(METHODS.resolve, budget(options.budgets?.resolveMs, LIMITS.resolveMs), signal,
      async request => {
        const parsed = normalize(() => decodeInput(ResolveInputSchema, input));
        const raw = await request(parsed);
        return correlate(() => correlateResolveOutput(parsed, raw));
      }),
    enumerate: (input, signal) => call(METHODS.enumerate, budget(options.budgets?.feedMs, LIMITS.feedMs), signal,
      async request => {
        const parsed = normalize(() => decodeInput(FeedInputSchema, input));
        const raw = await request(parsed);
        return correlate(() => correlateFeedOutput(parsed, raw, options.descriptors));
      }),
  };
}
export function createResultsConsumerClient(sdk: SupplierSdk, listedPluginId: string,
  options: ResultsClientOptions = {}): ResultsConsumerClient {
  const pluginId = normalize(() => PluginIdSchema.parse(listedPluginId));
  const call = clientCall(sdk, pluginId, options);
  return { pluginId, invalidate: (input, signal) => call(METHODS.invalidate,
    budget(options.budgets?.invalidateMs, LIMITS.recognizeMs), signal, async request => {
      const parsed = normalize(() => decodeInput(InvalidateInputSchema, input));
      const raw = await request(parsed);
      return normalize(() => decodeOutput(InvalidateOutputSchema, raw));
    }) };
}

export interface ResultsParticipant {
  pluginId: string; capabilities: CapabilitiesV1;
  recognize?(input: RecognizeInput, signal: AbortSignal): RecognizeOutput | Promise<RecognizeOutput>;
  resolve?(input: ResolveInput, signal: AbortSignal): ResolveOutput | Promise<ResolveOutput>;
  enumerate?(input: FeedInput, signal: AbortSignal): FeedOutput | Promise<FeedOutput>;
  invalidate?(input: InvalidateInput, signal: AbortSignal, context: { targetPluginId: string }): InvalidateOutput | Promise<InvalidateOutput>;
}
/** One aggregated describe registration. Handlers remain responsible for source
 * access, read-only effects/purity and their own retained-source work bounds.
 */
export function registerTurnResultsParticipant(bb: RegistrationPort, participant: ResultsParticipant,
  options: { budgets?: ResultsBudgets; signal?: AbortSignal } = {}): { dispose(): void } {
  const pluginId = normalize(() => PluginIdSchema.parse(participant.pluginId));
  const capabilities = normalize(() => decodeInput(InputSchemas.capabilities, participant.capabilities));
  const required = { recognize: capabilities.supplier?.recognize ?? false, resolve: !!capabilities.supplier,
    enumerate: capabilities.supplier?.enumerate ?? false, invalidate: !!capabilities.consumer };
  for (const [name, needed] of Object.entries(required)) {
    if (needed !== (typeof participant[name as keyof typeof required] === 'function')) {
      throw new ResultsCallError('incompatible');
    }
  }
  const lifetime = new AbortController();
  let disposed = false;
  const dispose = () => { disposed = true; lifetime.abort(); };
  const signal = joined(lifetime.signal, options.signal);
  const handlers = { recognize: participant.recognize, resolve: participant.resolve,
    enumerate: participant.enumerate, invalidate: participant.invalidate };
  const contract: Record<string, { input: ResultStandardSchema; output: ResultStandardSchema }> = {};
  const calls: Record<string, (input: unknown, context: ResultRpcContext) => Promise<unknown>> = {};
  const add = (method: string, inputSchema: ZodType, ms: number,
    handler: (input: unknown, bounded: AbortSignal, check: () => void) => Promise<unknown>) => {
    const emptyAsNull = method === METHODS.describe;
    contract[method] = { input: schema(inputSchema, true, emptyAsNull), output: schema(UnknownResultSchema) };
    calls[method] = async input => { try { return await isolated((bounded, check) => {
      const raw = emptyAsNull && input === undefined ? null : input;
      normalize(() => json(raw));
      return handler(raw, bounded, check);
    }, ms,
      { signal, current: () => !disposed });
    } catch (error) { return sourceFault(method, error); } };
  };
  add(METHODS.describe, UnknownResultSchema, budget(options.budgets?.describeMs, LIMITS.describeMs),
    async () => normalize(() => decodeOutput(DescribeEnvelopeSchema,
      { protocol: PROTOCOL, versions: [1], capabilities: structuredClone(capabilities) })));
  if (handlers.recognize) add(METHODS.recognize, RecognizeInputSchema,
    budget(options.budgets?.recognizeMs, LIMITS.recognizeMs), async (input, bounded, check) => {
      const parsed = await correlate(() => validateRecognizeInput(input)); check();
      const raw = await sourceCall(() => handlers.recognize!(structuredClone(parsed), bounded)); check();
      await correlate(() => correlateRecognizeOutput(parsed, raw, capabilities.supplier!.kinds)); check();
      return raw; // preserve admitted additive wire fields
    });
  if (handlers.resolve) add(METHODS.resolve, ResolveInputSchema,
    budget(options.budgets?.resolveMs, LIMITS.supplierResolveMs), async (input, bounded, check) => {
      const parsed = normalize(() => decodeInput(ResolveInputSchema, input)); check();
      const raw = await sourceCall(() => handlers.resolve!(structuredClone(parsed), bounded)); check();
      await correlate(() => correlateResolveOutput(parsed, raw)); check(); return raw;
    });
  if (handlers.enumerate) add(METHODS.enumerate, FeedInputSchema,
    budget(options.budgets?.feedMs, LIMITS.supplierResolveMs), async (input, bounded, check) => {
      const parsed = normalize(() => decodeInput(FeedInputSchema, input)); check();
      const raw = await sourceCall(() => handlers.enumerate!(structuredClone(parsed), bounded)); check();
      await correlate(() => correlateFeedOutput(parsed, raw, capabilities.supplier!.kinds)); check(); return raw;
    });
  if (handlers.invalidate) add(METHODS.invalidate, InvalidateInputSchema,
    budget(options.budgets?.invalidateMs, LIMITS.recognizeMs), async (input, bounded, check) => {
      const parsed = normalize(() => decodeInput(InvalidateInputSchema, input)); check();
      const raw = await sourceCall(() => handlers.invalidate!(structuredClone(parsed), bounded, { targetPluginId: pluginId })); check();
      normalize(() => decodeOutput(InvalidateOutputSchema, raw)); return raw;
    });
  bb.rpc.register(contract, calls, { experimental_discoverable: true });
  bb.onDispose?.(dispose);
  return { dispose };
}

export interface ResultsDiscoveryOwner {
  begin(): { generation: number; signal: AbortSignal; current(): boolean; finish(): void };
  dispose(): void;
}
export function createResultsDiscoveryOwner(): ResultsDiscoveryOwner {
  let generation = 0;
  let active: AbortController | null = null;
  return {
    begin() {
      active?.abort(); const controller = new AbortController(); active = controller;
      const token = ++generation;
      return { generation: token, signal: controller.signal, current: () => token === generation && !controller.signal.aborted,
        finish() { if (active === controller) active = null; } };
    },
    dispose() { generation++; active?.abort(); active = null; },
  };
}
export interface ResultsDiscoveryCursor { afterPluginId: string | null }
export interface ResultsDiscoveryRow { pluginId: string;
  state: 'queued' | 'prior-slice' | 'ready' | ResultsErrorKind;
  capabilities?: CapabilitiesV1; reason?: string }
export interface ResultsDiscoveryResult {
  generation: number; rows: ResultsDiscoveryRow[]; state: 'complete' | 'continued' | 'failed';
  cursor: ResultsDiscoveryCursor | null; remaining: number; capacity: { omitted: number; complete: boolean };
  error?: ResultsErrorKind;
}
/** Exactly one list per requested pass; max 4 concurrent describes, 32 processing
 * slots and 256 metadata rows. Caller resumes cursor; no internal slice loop.
 */
export async function discoverResultsParticipants(options: {
  sdk: { plugins: RpcPort & PluginListPort }; owner: ResultsDiscoveryOwner;
  cursor?: ResultsDiscoveryCursor | null; exclude?: readonly string[];
  signal?: AbortSignal; budgets?: ResultsBudgets; overallDeadline?: number;
}): Promise<ResultsDiscoveryResult> {
  const after = options.cursor?.afterPluginId ?? null;
  if (after !== null) normalize(() => PluginIdSchema.parse(after));
  const pass = options.owner.begin();
  const signal = joined(pass.signal, options.signal);
  const deadline = Math.min(performance.now() + budget(options.budgets?.discoveryMs, 3000),
    options.overallDeadline === undefined ? Infinity : Number.isFinite(options.overallDeadline) ? options.overallDeadline : -Infinity);
  const result: ResultsDiscoveryResult = { generation: pass.generation, rows: [], state: 'complete', cursor: null,
    remaining: 0, capacity: { omitted: 0, complete: true } };
  try {
    let listed: { plugins: readonly ListedResultPlugin[] };
    try {
      listed = await isolated(bounded => options.sdk.plugins.list({ signal: bounded }), Math.max(0, deadline - performance.now()),
        { signal, current: pass.current, overallDeadline: deadline });
    } catch (error) {
      if (signal.aborted || !pass.current()) throw classified(error);
      return { ...result, state: 'failed', error: classifyResultsError(error), cursor: options.cursor ?? null };
    }
    if (!listed || !Array.isArray(listed.plugins)) throw new ResultsCallError('incompatible');
    const exclude = new Set(options.exclude ?? []);
    const targets: ListedResultPlugin[] = [];
    const seen = new Set<string>();
    result.capacity = { omitted: Math.max(0, listed.plugins.length - 256), complete: listed.plugins.length <= 256 };
    for (const row of listed.plugins.slice(0, 256)) {
      if (!row || !PluginIdSchema.safeParse(row.id).success || typeof row.enabled !== 'boolean'
        || typeof row.status !== 'string' || row.status.length > 64 || seen.has(row.id)) throw new ResultsCallError('incompatible');
      seen.add(row.id);
      if (!exclude.has(row.id)) targets.push({ id: row.id, enabled: row.enabled, status: row.status });
    }
    targets.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    result.rows = targets.map(row => ({ pluginId: row.id,
      state: !row.enabled || row.status === 'disabled' ? 'disabled'
        : row.status !== 'running' && row.status !== 'degraded' ? 'not-running'
          : after !== null && row.id <= after ? 'prior-slice' : 'queued' }));
    const queued = result.rows.filter(row => row.state === 'queued');
    const slots = Math.floor(budget(options.budgets?.processingSlots, 32));
    const lanes = Math.floor(budget(options.budgets?.concurrency, LIMITS.requestLanes));
    let completedPrefix = 0;
    let visited = 0;
    while (visited < queued.length && visited < slots && lanes > 0 && performance.now() < deadline) {
      if (!pass.current() || signal.aborted) throw new ResultsCallError('aborted');
      const batch = queued.slice(visited, Math.min(visited + lanes, slots));
      await Promise.all(batch.map(async row => {
        try {
          const client = createResultsSupplierClient(options.sdk, row.pluginId,
            { signal, current: pass.current, overallDeadline: deadline,
              ...(options.budgets ? { budgets: options.budgets } : {}) });
          const negotiated = await client.describe();
          if (!pass.current() || signal.aborted) return;
          if (negotiated.state === 'ready') { row.state = 'ready'; row.capabilities = negotiated.capabilities; }
          else { row.state = 'incompatible'; row.reason = negotiated.reason; }
        } catch (error) {
          if (!pass.current() || signal.aborted) return;
          if (error instanceof ResultsCallError && error.reason === 'overall-deadline') return;
          row.state = classifyResultsError(error);
        }
      }));
      visited += batch.length;
      while (completedPrefix < queued.length && queued[completedPrefix]!.state !== 'queued') completedPrefix++;
      if (batch.some(row => row.state === 'queued')) break;
    }
    if (!pass.current() || signal.aborted) throw new ResultsCallError('aborted');
    result.remaining = queued.slice(completedPrefix).length;
    if (result.remaining) {
      result.state = 'continued';
      result.cursor = { afterPluginId: completedPrefix ? queued[completedPrefix - 1]!.pluginId : after };
    }
    return result;
  } catch (error) {
    if (signal.aborted || !pass.current()) throw classified(error);
    return { ...result, state: 'failed', error: classifyResultsError(error), cursor: options.cursor ?? null };
  } finally { pass.finish(); }
}

export type ResultsNavigationResult = { state: 'handled' | 'unhandled' | 'unavailable' | 'invalid';
  source?: { threadId: string; eventId: string; seq: number } };
/** No host-target casts into CR. Return source metadata when native event seek
 * is unavailable, rather than claiming exact-row navigation was handled.
 */
export function navigateResult(port: ResultNavigationPort, raw: ResultRoute): ResultsNavigationResult {
  let route: ResultRoute;
  try { route = decodeInput(InputSchemas.route, raw); } catch { return { state: 'invalid' }; }
  if (route.kind === 'unavailable') return { state: 'unavailable' };
  if (route.kind === 'file') {
    const path = route.target.path;
    if (route.target.kind === 'host' && !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path)
      || path.split(/[\\/]/u).includes('..')) return { state: 'invalid' };
    return { state: port.experimental_openFilePreview({ target: route.target, location: null }) ? 'handled' : 'unhandled' };
  }
  if (route.kind === 'url') return { state: port.openUrl(route.href) ? 'handled' : 'unhandled' };
  if (route.kind === 'thread') { port.toThread(route.threadId); return { state: 'handled' }; }
  const source = { threadId: route.threadId, eventId: route.eventId, seq: route.seq };
  port.toThread(route.threadId); port.showSource?.(source);
  return { state: 'handled', source };
}
