import type { ZodType } from 'zod';
import type { BbPluginApi, JsonValue, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import {
  LIMITS, METHODS, RESERVED_PROVIDER_PREFIX, UnknownResultSchema,
  CapabilitiesV1Schema, DescribeEnvelopeSchema, LinkifyInputV1Schema,
  LinkifyOutputV1Schema, ResolveInputV1Schema, ResolveOutputV1Schema,
  canonicalJson, identityKey, checkCandidate, negotiateVersion,
} from './index.js';
import type {
  CapabilitiesV1, ProviderClaimV1, LinkifyInputV1, LinkifyOutputV1,
  ResolveInputV1, ResolveOutputV1, TaggedCandidateV1, SourceIdentity,
} from './index.js';


// Adapt Zod issue paths to the SDK's exact optional Standard Schema shape.
// UnknownResultSchema remains an identity validator, so output keys survive.
function sdkSchema<T>(schema: ZodType<T>): StandardSchemaV1<T> {
  return { '~standard': {
    version: 1,
    vendor: 'bb-context-recognition',
    jsonSchema: {
      input: () => schema.toJSONSchema({ io: 'input', unrepresentable: 'any' }),
      output: () => schema.toJSONSchema({ io: 'output', unrepresentable: 'any' }),
    },
    validate(value) {
      const parsed = schema.safeParse(value);
      return parsed.success ? { value: parsed.data } : { issues: parsed.error.issues.map(issue => ({ message: issue.message, path: issue.path })) };
    },
  } };
}

export type RecognitionSdk = Pick<BbPluginApi['sdk'], 'plugins'>;
export type RecognitionErrorKind = 'absent' | 'vanished' | 'host-incompatible' | 'unavailable' | 'incompatible' | 'error' | 'unauthorized' | 'cancelled' | 'transient';
export class RecognitionCallError extends Error {
  constructor(readonly kind: RecognitionErrorKind, readonly cause?: unknown, readonly reason?: 'result-size' | 'nonjson') {
    super(`Recognition call failed: ${kind}`);
    this.name = 'RecognitionCallError';
  }
}
export function classifyRecognitionError(error: unknown): RecognitionErrorKind {
  if (error instanceof RecognitionCallError) return error.kind;
  const e = error as { name?: string; status?: number; body?: unknown } | null;
  if (e?.name === 'AbortError') return 'cancelled';
  if (e?.name === 'ZodError') return 'incompatible';
  const body = e?.body;
  const code = body && typeof body === 'object'
    ? (body as { error?: { code?: unknown } }).error?.code : undefined;
  if (e?.status === 404) {
    if (code === 'unknown_method') return 'absent';
    if (typeof body === 'string' && /unknown plugin/i.test(body)) return 'vanished';
    return 'host-incompatible';
  }
  if (e?.status === 503 && typeof body === 'string' && /not running \(status: [^)]+\)/.test(body)) return 'unavailable';
  if (e?.status === 401 || e?.status === 403) return 'unauthorized';
  if ((e?.status === 400 && code === 'invalid_input') || (e?.status === 500 && code === 'invalid_output')) return 'incompatible';
  if (e?.status === 500) return 'error';
  return 'transient';
}

/** Explicit consumer budgets. All durations and counts can only lower v1 limits.
 * Share overallDeadline (performance.now() timebase) across chained stages. */
export interface RecognitionBudgets {
  concurrency?: number;
  describeMs?: number;
  discoveryMs?: number;
  linkifyMs?: number;
  linkifyStageMs?: number;
  resolveMs?: number;
  resolveStageMs?: number;
  overallMs?: number;
  overallDeadline?: number;
}
function limit(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : 0;
}
function deadline(duration: number, explicit?: number): number {
  return Math.min(performance.now() + duration, explicit === undefined ? Infinity : Number.isFinite(explicit) ? explicit : -Infinity);
}
function failure(kind: RecognitionErrorKind): RecognitionCallError { return new RecognitionCallError(kind); }

/** Race fences callers even when a handler or SDK ignores AbortSignal. */
async function isolated<T>(run: (signal: AbortSignal) => Promise<T> | T, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw failure('cancelled');
  if (ms <= 0) throw failure('transient');
  const controller = new AbortController();
  const end = performance.now() + ms;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, value: unknown) => {
        if (settled) return;
        settled = true;
        if (ok) resolve(value as T); else reject(value);
      };
      abort = () => { finish(false, failure('cancelled')); controller.abort(); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { finish(false, failure('transient')); controller.abort(); }, Math.ceil(ms));
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw failure('cancelled');
        return run(controller.signal);
      }).then(value => {
        if (signal?.aborted) finish(false, failure('cancelled'));
        else if (performance.now() >= end) { finish(false, failure('transient')); controller.abort(); }
        else finish(true, value);
      }, error => finish(false, error));
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}
function admit(value: unknown): unknown {
  let json: string;
  try { json = canonicalJson(value); }
  catch (error) { throw new RecognitionCallError('incompatible', error, 'nonjson'); }
  if (new TextEncoder().encode(json).byteLength > LIMITS.responseBytes) throw new RecognitionCallError('incompatible', undefined, 'result-size');
  return value;
}
function decode<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(admit(value)); }
  catch (error) { if (error instanceof RecognitionCallError) throw error; throw new RecognitionCallError('incompatible', error); }
}
function correlateLinkify(output: LinkifyOutputV1, input: LinkifyInputV1, providers?: readonly string[]): LinkifyOutputV1 {
  const spans = new Set<string>();
  let previous: LinkifyOutputV1['candidates'][number] | undefined;
  for (const candidate of output.candidates) {
    if (!checkCandidate(candidate, { text: input.text, excluded: input.excluded, context: input.context, ...(providers ? { providers: [...providers] } : {}) }).valid) throw failure('incompatible');
    if (previous && (candidate.span.start < previous.span.start || (candidate.span.start === previous.span.start && candidate.span.end < previous.span.end))) throw failure('incompatible');
    previous = candidate;
    const span = `${candidate.span.start}:${candidate.span.end}`;
    if (spans.has(span)) throw failure('incompatible');
    spans.add(span);
  }
  return output;
}
function correlateResolve(output: ResolveOutputV1, input: ResolveInputV1): ResolveOutputV1 {
  const requested = new Set(input.sources.map(identityKey));
  const seen = new Set<string>();
  for (const resolution of output.resolutions) {
    const key = identityKey(resolution.source);
    if (!requested.has(key) || seen.has(key) || (input.detail === 'label' && resolution.card !== undefined)) throw failure('incompatible');
    seen.add(key);
  }
  return output;
}
export interface SupplierClient {
  readonly pluginId: string;
  describe(signal?: AbortSignal): Promise<ReturnType<typeof negotiateVersion>>;
  linkify(input: LinkifyInputV1, signal?: AbortSignal): Promise<LinkifyOutputV1>;
  resolve(input: ResolveInputV1, signal?: AbortSignal): Promise<ResolveOutputV1>;
}
export function createSupplierClient(sdk: RecognitionSdk, pluginId: string): SupplierClient {
  async function call(method: string, input: unknown, ms: number, signal?: AbortSignal): Promise<unknown> {
    try {
      return admit(await isolated(s => sdk.plugins.callRpc({ pluginId, method, input: input as JsonValue, outputSchema: UnknownResultSchema, signal: s }), ms, signal));
    } catch (error) { if (error instanceof RecognitionCallError) throw error; throw new RecognitionCallError(classifyRecognitionError(error), error); }
  }
  return {
    pluginId,
    describe: async signal => negotiateVersion(await call(METHODS.describe, null, LIMITS.describeMs, signal)),
    linkify: async (input, signal) => {
      const parsed = LinkifyInputV1Schema.parse(input);
      return correlateLinkify(decode(LinkifyOutputV1Schema, await call(METHODS.linkify, parsed, LIMITS.linkifyMs, signal)), parsed);
    },
    resolve: async (input, signal) => {
      const parsed = ResolveInputV1Schema.parse(input);
      return correlateResolve(decode(ResolveOutputV1Schema, await call(METHODS.resolve, parsed, LIMITS.resolveMs, signal)), parsed);
    },
  };
}

export type RecognitionProviderClaim = Omit<ProviderClaimV1, 'specificity'> & { specificity?: ProviderClaimV1['specificity'] };
export interface RecognitionSupplier {
  revision: string;
  linkify?: { providers: RecognitionProviderClaim[]; handler(input: LinkifyInputV1, signal: AbortSignal): LinkifyOutputV1 | Promise<LinkifyOutputV1> };
  resolve?: { providers: RecognitionProviderClaim[]; handler(input: ResolveInputV1, signal: AbortSignal): ResolveOutputV1 | Promise<ResolveOutputV1> };
}
export interface BuiltinRecognitionSupplier extends RecognitionSupplier { pluginId: string }
export interface ReadyRecognitionSupplier { client: SupplierClient; capabilities: CapabilitiesV1 }
export interface RecognitionOutcome {
  pluginId: string;
  origin: 'builtin' | 'contributed';
  state: 'ready' | RecognitionErrorKind;
  batch?: number;
  /** Omitted identities are transient and must not be negatively cached. */
  omittedSources?: SourceIdentity[];
}
export type ResolverRoute =
  | { state: 'ready'; pluginId: string; origin: 'contributed'; client: SupplierClient }
  | { state: 'ready'; pluginId: string; origin: 'builtin'; handler: NonNullable<RecognitionSupplier['resolve']>['handler'] }
  | { state: 'contested'; pluginIds: string[] };
export type ResolverRoutes = ReadonlyMap<string, ResolverRoute>;

function resolveRoutes(clients: readonly ReadyRecognitionSupplier[], builtins: readonly BuiltinRecognitionSupplier[]): Map<string, ResolverRoute> {
  const routes = new Map<string, ResolverRoute>();
  for (const builtin of builtins) for (const claim of builtin.resolve?.providers ?? []) {
    if (routes.has(claim.provider)) throw new Error(`Duplicate builtin resolver: ${claim.provider}`);
    routes.set(claim.provider, { state: 'ready', pluginId: builtin.pluginId, origin: 'builtin', handler: builtin.resolve!.handler });
  }
  for (const { client, capabilities } of clients) for (const claim of capabilities.resolve?.providers ?? []) {
    const current = routes.get(claim.provider);
    if (current?.state === 'ready' && current.origin === 'builtin') {
      if (claim.provider.startsWith(RESERVED_PROVIDER_PREFIX)) continue;
      throw new Error(`Builtin resolver must own a reserved provider: ${claim.provider}`);
    }
    if (!current) routes.set(claim.provider, { state: 'ready', pluginId: client.pluginId, origin: 'contributed', client });
    else {
      const pluginIds = current.state === 'contested' ? current.pluginIds : [current.pluginId];
      routes.set(claim.provider, { state: 'contested', pluginIds: [...new Set([...pluginIds, client.pluginId])].sort() });
    }
  }
  return routes;
}

/** An explicit handle per consumer. It is independent even if consumers share an SDK. */
export interface RecognitionDiscoveryOwner {
  begin(): { generation: number; signal: AbortSignal; current(): boolean; cancel(): void; finish(): void };
  dispose(): void;
}
export function createRecognitionDiscoveryOwner(): RecognitionDiscoveryOwner {
  let generation = 0;
  let active: AbortController | undefined;
  return {
    begin() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      const token = ++generation;
      return { generation: token, signal: controller.signal,
        current: () => generation === token && !controller.signal.aborted,
        cancel: () => controller.abort(),
        finish: () => { if (active === controller) active = undefined; },
      };
    },
    dispose() { ++generation; active?.abort(); active = undefined; },
  };
}
export interface RecognitionSupplierRow {
  pluginId: string;
  displayName: string | null;
  listedStatus: string;
  generation: number;
  state: 'pending' | 'ready' | 'contested' | 'absent' | 'incompatible' | 'unavailable' | 'transient' | 'error';
  capabilities?: CapabilitiesV1;
  /** Resolve contention is provider-specific; other claims remain usable. */
  contestedProviders?: { provider: string; pluginIds: string[] }[];
  error?: RecognitionErrorKind;
}
async function lanes<T>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.floor(concurrency)) }, async () => {
    while (index < items.length) {
      const i = index++;
      await run(items[i]!, i);
    }
  }));
}
export async function enumerateRecognitionSuppliers(opts: {
  sdk: RecognitionSdk;
  owner: RecognitionDiscoveryOwner;
  signal?: AbortSignal;
  exclude: string | readonly string[];
  onRow?(row: RecognitionSupplierRow): void;
  builtins?: readonly BuiltinRecognitionSupplier[];
  budgets?: RecognitionBudgets;
}): Promise<{ rows: RecognitionSupplierRow[]; routes: Map<string, ResolverRoute>; omittedCount: number; generation: number }> {
  const pass = opts.owner.begin();
  const abort = () => pass.cancel();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  const rows = new Map<string, RecognitionSupplierRow>();
  const end = deadline(limit(opts.budgets?.discoveryMs, LIMITS.discoveryMs));
  let omittedCount = 0;
  const publish = (row: RecognitionSupplierRow) => {
    if (!pass.current()) return;
    rows.set(row.pluginId, row);
    opts.onRow?.(structuredClone(row));
  };
  try {
    const listed = await isolated(s => opts.sdk.plugins.list({ signal: s }), end - performance.now(), pass.signal);
    if (!pass.current()) return { rows: [], routes: resolveRoutes([], opts.builtins ?? []), omittedCount: 0, generation: pass.generation };
    const exclude = new Set(typeof opts.exclude === 'string' ? [opts.exclude] : opts.exclude);
    const eligible = [...new Map(listed.plugins.filter(p => (p.status === 'running' || p.status === 'degraded') && !exclude.has(p.id)).map(p => [p.id, p])).values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const selected = eligible.slice(0, LIMITS.plugins);
    omittedCount = listed.plugins.length - selected.length;
    await lanes(selected, Math.max(1, limit(opts.budgets?.concurrency, LIMITS.concurrency)), async p => {
      if (!pass.current()) return;
      const base = { pluginId: p.id, displayName: p.name ?? null, listedStatus: p.status, generation: pass.generation };
      publish({ ...base, state: 'pending' });
      try {
        const result = await isolated(s => createSupplierClient(opts.sdk, p.id).describe(s), Math.min(limit(opts.budgets?.describeMs, LIMITS.describeMs), end - performance.now()), pass.signal);
        publish(result.state === 'ready' ? { ...base, state: 'ready', capabilities: result.capabilities } : { ...base, state: 'incompatible', error: 'incompatible' });
      } catch (error) {
        const kind = classifyRecognitionError(error);
        if (kind === 'cancelled') return;
        const state = kind === 'vanished' || kind === 'unavailable' ? 'unavailable' : kind === 'host-incompatible' || kind === 'incompatible' ? 'incompatible' : kind === 'absent' || kind === 'transient' ? kind : 'error';
        publish({ ...base, state, error: kind });
      }
    });
    if (!pass.current()) return { rows: [], routes: resolveRoutes([], opts.builtins ?? []), omittedCount, generation: pass.generation };
    const finalRows = [...rows.values()].sort((a, b) => a.pluginId < b.pluginId ? -1 : a.pluginId > b.pluginId ? 1 : 0);
    const ready = finalRows.flatMap(row => (row.state === 'ready' || row.state === 'contested') && row.capabilities ? [{ client: createSupplierClient(opts.sdk, row.pluginId), capabilities: row.capabilities }] : []);
    const routes = resolveRoutes(ready, opts.builtins ?? []);
    for (let i = 0; i < finalRows.length; i++) {
      const row = finalRows[i]!;
      if (!row.capabilities) continue;
      const contestedProviders = [...routes].flatMap(([provider, route]) => route.state === 'contested' && route.pluginIds.includes(row.pluginId) ? [{ provider, pluginIds: [...route.pluginIds] }] : []).sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0);
      if (contestedProviders.length) {
        const contested: RecognitionSupplierRow = { ...row, state: 'contested', contestedProviders };
        finalRows[i] = contested;
        publish(contested);
      }
    }
    if (!pass.current()) return { rows: [], routes: resolveRoutes([], opts.builtins ?? []), omittedCount, generation: pass.generation };
    return { rows: finalRows, routes, omittedCount, generation: pass.generation };
  } catch (error) {
    if (classifyRecognitionError(error) !== 'cancelled') throw new RecognitionCallError(classifyRecognitionError(error), error);
    return { rows: [], routes: resolveRoutes([], opts.builtins ?? []), omittedCount, generation: pass.generation };
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    pass.finish();
  }
}

export async function linkifyAll(opts: {
  clients?: readonly ReadyRecognitionSupplier[];
  builtins?: readonly BuiltinRecognitionSupplier[];
  input: LinkifyInputV1;
  signal?: AbortSignal;
  budgets?: RecognitionBudgets;
}): Promise<{ results: TaggedCandidateV1[]; outcomes: RecognitionOutcome[] }> {
  const input = LinkifyInputV1Schema.parse(opts.input);
  const budgets = opts.budgets;
  const overall = deadline(limit(budgets?.overallMs, LIMITS.overallMs), budgets?.overallDeadline);
  const end = deadline(limit(budgets?.linkifyStageMs, LIMITS.linkifyStageMs), overall);
  const reserved = new Set((opts.builtins ?? []).flatMap(b => b.linkify?.providers.map(p => p.provider).filter(p => p.startsWith(RESERVED_PROVIDER_PREFIX)) ?? []));
  const jobs: { pluginId: string; origin: 'builtin' | 'contributed'; providers: RecognitionProviderClaim[]; run(signal: AbortSignal): LinkifyOutputV1 | Promise<LinkifyOutputV1> }[] = [];
  for (const b of opts.builtins ?? []) if (b.linkify) jobs.push({ pluginId: b.pluginId, origin: 'builtin', providers: b.linkify.providers, run: s => b.linkify!.handler(structuredClone(input), s) });
  for (const c of opts.clients ?? []) if (c.capabilities.linkify) jobs.push({ pluginId: c.client.pluginId, origin: 'contributed', providers: c.capabilities.linkify.providers, run: s => c.client.linkify(structuredClone(input), s) });
  const values: TaggedCandidateV1[][] = [];
  const outcomes: RecognitionOutcome[] = [];
  await lanes(jobs, Math.max(1, limit(budgets?.concurrency, LIMITS.concurrency)), async (job, i) => {
    try {
      const raw = await isolated(job.run, Math.min(limit(budgets?.linkifyMs, LIMITS.linkifyMs), end - performance.now()), opts.signal);
      const output = correlateLinkify(decode(LinkifyOutputV1Schema, raw), input, job.providers.map(p => p.provider));
      values[i] = output.candidates.filter(c => job.origin === 'builtin' || !reserved.has(c.source.provider)).map(candidate => ({ candidate, origin: job.origin, pluginId: job.pluginId, specificity: job.providers.find(p => p.provider === candidate.source.provider)?.specificity ?? 'typed', providers: job.providers.map(p => p.provider) }));
      outcomes[i] = { pluginId: job.pluginId, origin: job.origin, state: 'ready' };
    } catch (error) { outcomes[i] = { pluginId: job.pluginId, origin: job.origin, state: classifyRecognitionError(error) }; }
  });
  return { results: values.flat(), outcomes };
}

export async function resolveAll(opts: {
  routes: ResolverRoutes;
  sources: ResolveInputV1['sources'];
  detail: ResolveInputV1['detail'];
  context: ResolveInputV1['context'];
  signal?: AbortSignal;
  budgets?: RecognitionBudgets;
}): Promise<{ results: ResolveOutputV1['resolutions']; outcomes: RecognitionOutcome[] }> {
  const budgets = opts.budgets;
  const overall = deadline(limit(budgets?.overallMs, LIMITS.overallMs), budgets?.overallDeadline);
  const end = deadline(limit(budgets?.resolveStageMs, LIMITS.resolveStageMs), overall);
  const seen = new Set<string>();
  const groups = new Map<string | NonNullable<RecognitionSupplier['resolve']>['handler'], { route: Exclude<ResolverRoute, { state: 'contested' }>; sources: ResolveInputV1['sources'] }>();
  for (const rawSource of opts.sources) {
    const source = ResolveInputV1Schema.parse({ version: 1, context: opts.context, detail: opts.detail, sources: [rawSource] }).sources[0]!;
    const key = identityKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    const route = opts.routes.get(source.provider);
    if (!route || route.state !== 'ready') continue;
    const owner = route.origin === 'builtin' ? route.handler : route.pluginId;
    let group = groups.get(owner);
    if (!group) { group = { route, sources: [] }; groups.set(owner, group); }
    group.sources.push(source);
  }
  const jobs = [...groups.values()].flatMap(group => {
    const batches = [];
    for (let offset = 0; offset < group.sources.length; offset += LIMITS.identitiesPerResolve) {
      batches.push({ route: group.route, batch: offset / LIMITS.identitiesPerResolve, input: ResolveInputV1Schema.parse({ version: 1, context: opts.context, detail: opts.detail, sources: group.sources.slice(offset, offset + LIMITS.identitiesPerResolve) }) });
    }
    return batches;
  });
  const results: ResolveOutputV1['resolutions'][] = [];
  const outcomes: RecognitionOutcome[] = [];
  await lanes(jobs, Math.max(1, limit(budgets?.concurrency, LIMITS.concurrency)), async (job, i) => {
    const { route, input, batch } = job;
    try {
      const output = await isolated(s => route.origin === 'contributed' ? route.client.resolve(structuredClone(input), s) : route.handler(structuredClone(input), s), Math.min(limit(budgets?.resolveMs, LIMITS.resolveMs), end - performance.now()), opts.signal);
      results[i] = correlateResolve(decode(ResolveOutputV1Schema, output), input).resolutions;
      const returned = new Set(results[i]!.map(r => identityKey(r.source)));
      const omittedSources = input.sources.filter(s => !returned.has(identityKey(s)));
      outcomes[i] = { pluginId: route.pluginId, origin: route.origin, state: 'ready', batch, ...(omittedSources.length ? { omittedSources } : {}) };
    } catch (error) { outcomes[i] = { pluginId: route.pluginId, origin: route.origin, state: classifyRecognitionError(error), batch }; }
  });
  return { results: results.flat(), outcomes };
}

export class UnsupportedStageError extends Error {
  constructor(readonly stage: 'linkify' | 'resolve') { super(`Unadvertised recognition stage: ${stage}`); this.name = 'UnsupportedStageError'; }
}

/** All three methods register, but callers must consult advertised capabilities.
 * Calling an absent stage throws UnsupportedStageError (programmer misuse).
 * Public SDK registration supplies input only. Signals are local invocation
 * deadlines; they do not represent cancellation of a native RPC request. */
export function registerRecognitionSupplier(bb: Pick<BbPluginApi, 'rpc'>, supplier: RecognitionSupplier): void {
  const capabilities = CapabilitiesV1Schema.parse({
    revision: supplier.revision,
    ...(supplier.linkify ? { linkify: { providers: supplier.linkify.providers } } : {}),
    ...(supplier.resolve ? { resolve: { providers: supplier.resolve.providers } } : {}),
  });
  const unsupported = (stage: 'linkify' | 'resolve'): never => { throw new UnsupportedStageError(stage); };
  bb.rpc.register({
    [METHODS.describe]: { input: sdkSchema(UnknownResultSchema), output: sdkSchema(UnknownResultSchema) },
    [METHODS.linkify]: { input: sdkSchema(LinkifyInputV1Schema), output: sdkSchema(UnknownResultSchema) },
    [METHODS.resolve]: { input: sdkSchema(ResolveInputV1Schema), output: sdkSchema(UnknownResultSchema) },
  }, {
    [METHODS.describe]: () => DescribeEnvelopeSchema.parse({ protocol: 'bb-context-recognition', versions: [1], capabilities }),
    [METHODS.linkify]: async input => {
      if (!supplier.linkify) return unsupported('linkify');
      const parsed = LinkifyInputV1Schema.parse(input);
      const raw = await isolated(signal => supplier.linkify!.handler(structuredClone(parsed), signal), LIMITS.linkifyMs);
      correlateLinkify(decode(LinkifyOutputV1Schema, raw), parsed, capabilities.linkify!.providers.map(p => p.provider));
      return raw;
    },
    [METHODS.resolve]: async input => {
      if (!supplier.resolve) return unsupported('resolve');
      const parsed = ResolveInputV1Schema.parse(input);
      const raw = await isolated(signal => supplier.resolve!.handler(structuredClone(parsed), signal), LIMITS.resolveMs);
      correlateResolve(decode(ResolveOutputV1Schema, raw), parsed);
      return raw;
    },
  }, { experimental_discoverable: true });
}
