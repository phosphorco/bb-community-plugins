import type { BbPluginApi, JsonValue, PluginRpcContract, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import {
  LIMITS_V2 as L, METHODS_V2 as M, PROTOCOL_V2, pluginIdV2Schema, locatorKey,
  rpcResultV2Schema,
  negotiatePeopleAccounts, listInputV2Schema, listOutputV2Schema, getInputV2Schema, getOutputV2Schema,
  linksInputV2Schema, linksOutputV2Schema, findInputV2Schema, findOutputV2Schema,
  type ListInputV2, type ListOutputV2, type GetInputV2, type GetOutputV2,
  type LinksInputV2, type LinksOutputV2, type FindInputV2, type FindOutputV2,
} from './v2.js';

export type PeopleAccountsV2Sdk = Pick<BbPluginApi['sdk'], 'plugins'>;
export type V2ErrorKind = 'absent' | 'unavailable' | 'incompatible' | 'limit-exceeded' | 'timeout' | 'cancelled' | 'disposed';
export class PeopleAccountsV2Error extends Error {
  constructor(readonly kind: V2ErrorKind) { super(`People Accounts v2: ${kind}`); this.name = 'PeopleAccountsV2Error'; }
}
function classify(error: unknown): PeopleAccountsV2Error {
  if (error instanceof PeopleAccountsV2Error) return error;
  const e = error as { status?: unknown; code?: unknown; name?: unknown; body?: { error?: string | { code?: unknown } } } | null;
  const body = e?.body?.error;
  const code = typeof body === 'string' ? body : body?.code ?? e?.code;
  if (code === 'unknown_method' || code === 'unknown_plugin' || code === 'plugin_not_found' || e?.status === 404) return new PeopleAccountsV2Error('absent');
  if (code === 'invalid_input' || code === 'invalid_output' || e?.name === 'ZodError') return new PeopleAccountsV2Error('incompatible');
  if (e?.name === 'AbortError') return new PeopleAccountsV2Error('cancelled');
  return new PeopleAccountsV2Error('unavailable');
}
const fail = (kind: V2ErrorKind): never => { throw new PeopleAccountsV2Error(kind); };
function bounded(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return fail('incompatible');
    if (new TextEncoder().encode(json).byteLength > L.responseBytes) return fail('limit-exceeded');
    return JSON.parse(json);
  } catch (e) { throw e instanceof PeopleAccountsV2Error ? e : new PeopleAccountsV2Error('incompatible'); }
}
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(bounded(value));
  return result.success ? result.data : fail('incompatible');
}
function budget(ms: number | undefined, max: number): number {
  if (ms === undefined) return max;
  if (!Number.isFinite(ms) || ms <= 0 || ms > max) throw new RangeError(`Budget must be > 0 and <= ${max}`);
  return ms;
}
/** Caller settlement/cancellation is bounded even for a noncooperating SDK or supplier. */
async function within<T>(run: (signal: AbortSignal) => Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return fail('cancelled');
  const controller = new AbortController();
  let reject: (error: unknown) => void = () => {};
  const interrupted = new Promise<never>((_, r) => { reject = r; });
  const cancel = () => { reject(new PeopleAccountsV2Error('cancelled')); controller.abort(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { reject(new PeopleAccountsV2Error('timeout')); controller.abort(); }, ms);
  try { return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return run(controller.signal); }), interrupted]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
function validateList(input: ListInputV2, output: ListOutputV2, pluginId: string): ListOutputV2 {
  if (output.query !== input.query) return fail('incompatible');
  if (output.status === 'page') {
    if (output.items.length > input.limit || output.items.some(i => i.identity.pluginId !== pluginId)
      || new Set(output.items.map(i => locatorKey(i.identity))).size !== output.items.length
      || (input.revision !== undefined && output.revision !== input.revision)
      || (output.nextCursor !== null && (output.items.length === 0 || output.nextCursor === input.cursor))) return fail('incompatible');
  }
  return output;
}
function validateGet(input: GetInputV2, output: GetOutputV2, pluginId: string): GetOutputV2 {
  if (output.results.length !== input.subjects.length || output.results.some((r, i) => r.subject !== input.subjects[i]
    || (r.status === 'found' && (r.value.identity.pluginId !== pluginId || r.value.identity.subject !== r.subject)))) return fail('incompatible');
  return output;
}
function validateLinks(input: LinksInputV2, output: LinksOutputV2): LinksOutputV2 {
  if (output.results.length !== input.personKeys.length || output.results.some((r, i) => r.personKey !== input.personKeys[i])) return fail('incompatible');
  return output;
}
function validateFind(input: FindInputV2, output: FindOutputV2): FindOutputV2 {
  if (locatorKey(output.identity) !== locatorKey(input.identity)) return fail('incompatible');
  if (output.status === 'page' && (output.links.length > input.limit
    || new Set(output.links.map(l => l.personKey)).size !== output.links.length
    || (input.revision !== undefined && output.revision !== input.revision)
    || (output.nextCursor !== null && (output.links.length === 0 || output.nextCursor === input.cursor)))) return fail('incompatible');
  return output;
}

export function createPeopleAccountsV2Client(sdk: PeopleAccountsV2Sdk, targetPluginId: string, options: { callMs?: number } = {}) {
  const pluginId = pluginIdV2Schema.parse(targetPluginId);
  const ms = budget(options.callMs, L.callMs);
  async function call<T>(method: string, input: unknown, output: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    try {
      const value = await within(s => sdk.plugins.callRpc({ pluginId, method, input: input as JsonValue, outputSchema: z.unknown(), signal: s }), ms, signal);
      if (method === M.describe) return decode(output, value);
      const envelope = decode(rpcResultV2Schema(output), value);
      if (!envelope.ok) return fail(envelope.error.kind);
      return envelope.value;
    } catch (e) { throw classify(e); }
  }
  return {
    pluginId,
    async describe(signal?: AbortSignal) {
      const value = await call(M.describe, null, z.unknown(), signal);
      return negotiatePeopleAccounts(value);
    },
    async list(input: Omit<ListInputV2, 'version'>, signal?: AbortSignal) {
      const request = listInputV2Schema.parse({ ...input, version: 2 });
      return validateList(request, await call(M.list, request, listOutputV2Schema, signal), pluginId);
    },
    async get(input: Omit<GetInputV2, 'version'>, signal?: AbortSignal) {
      const request = getInputV2Schema.parse({ ...input, version: 2 });
      return validateGet(request, await call(M.get, request, getOutputV2Schema, signal), pluginId);
    },
    async links(input: Omit<LinksInputV2, 'version'>, signal?: AbortSignal) {
      const request = linksInputV2Schema.parse({ ...input, version: 2 });
      return validateLinks(request, await call(M.links, request, linksOutputV2Schema, signal));
    },
    async find(input: Omit<FindInputV2, 'version'>, signal?: AbortSignal) {
      const request = findInputV2Schema.parse({ ...input, version: 2 });
      return validateFind(request, await call(M.find, request, findOutputV2Schema, signal));
    },
  };
}
export type PeopleAccountsV2Client = ReturnType<typeof createPeopleAccountsV2Client>;
export interface IdentitySupplierV2 {
  list(input: ListInputV2, signal: AbortSignal): Promise<ListOutputV2>;
  get(input: GetInputV2, signal: AbortSignal): Promise<GetOutputV2>;
}
export interface LinksReaderV2 {
  links(input: LinksInputV2, signal: AbortSignal): Promise<LinksOutputV2>;
  find(input: FindInputV2, signal: AbortSignal): Promise<FindOutputV2>;
}
function sdkSchema(schema: z.ZodType): StandardSchemaV1 {
  return { '~standard': { version: 1, vendor: 'bb-people-accounts-v2',
    jsonSchema: { input: () => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), output: () => z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) },
    validate(value) { const r = schema.safeParse(value); return r.success ? { value: r.data } : { issues: r.error.issues.map(i => ({ message: i.message, path: i.path })) }; },
  } };
}
/** One registration per plugin, including when it supplies both roles. It registers no write/credential API. */
export function registerPeopleAccountsV2(bb: Pick<BbPluginApi, 'pluginId' | 'rpc' | 'onDispose'>, ports: { identities?: IdentitySupplierV2; links?: LinksReaderV2 }) {
  const pluginId = pluginIdV2Schema.parse(bb.pluginId);
  if (!ports.identities && !ports.links) throw new Error('At least one People Accounts role is required');
  const lifetime = new AbortController();
  const contract: { -readonly [K in keyof PluginRpcContract]: PluginRpcContract[K] } = {};
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const add = <I, O>(method: string, input: z.ZodType<I>, output: z.ZodType<O>, run: (input: I, signal: AbortSignal) => Promise<O>) => {
    const described = method === M.describe;
    contract[method] = { input: sdkSchema(input), output: sdkSchema(described ? output : rpcResultV2Schema(output)) };
    handlers[method] = async raw => {
      try {
        if (lifetime.signal.aborted) return fail('disposed');
        const parsed = input.parse(raw);
        const value = decode(output, await within(s => run(parsed, s), L.callMs, lifetime.signal));
        return bounded(described ? value : { ok: true, value });
      } catch (e) {
        if (described) throw classify(e);
        return { ok: false, error: { kind: classify(e).kind } };
      }
    };
  };
  const identities = ports.identities; const links = ports.links;
  add(M.describe, z.unknown(), z.unknown(), async () => ({ protocol: PROTOCOL_V2, versions: [2], capabilities: { identities: !!identities, links: !!links } }));
  if (identities) {
    add(M.list, listInputV2Schema, listOutputV2Schema, async (i, s) => validateList(i, decode(listOutputV2Schema, await identities.list(i, s)), pluginId));
    add(M.get, getInputV2Schema, getOutputV2Schema, async (i, s) => validateGet(i, decode(getOutputV2Schema, await identities.get(i, s)), pluginId));
  }
  if (links) {
    add(M.links, linksInputV2Schema, linksOutputV2Schema, async (i, s) => validateLinks(i, decode(linksOutputV2Schema, await links.links(i, s))));
    add(M.find, findInputV2Schema, findOutputV2Schema, async (i, s) => validateFind(i, decode(findOutputV2Schema, await links.find(i, s))));
  }
  bb.rpc.register(contract, handlers, { experimental_discoverable: true, experimental_description: 'People Accounts identity associations v2' });
  const dispose = () => lifetime.abort();
  bb.onDispose(dispose);
  return { dispose };
}

export type DiscoveryRowV2 = { pluginId: string; status: 'pending' | 'ready' | 'absent' | 'unavailable' | 'incompatible'; admitted: boolean; capabilities?: { identities: boolean; links: boolean } };
/** Each view owns its pass. Starting/releasing a pass fences its old notifications. No scheduler or global registry. */
export function createPeopleAccountsDiscovery() {
  let active: AbortController | undefined;
  let disposed = false;
  return {
    dispose() { disposed = true; active?.abort(); },
    async start(sdk: PeopleAccountsV2Sdk, options: { signal?: AbortSignal; previouslyReady?: readonly string[]; exclude?: readonly string[]; onRow?: (row: DiscoveryRowV2) => void; describeMs?: number; sliceMs?: number } = {}) {
      if (disposed) return fail('disposed');
      active?.abort();
      const owner = new AbortController(); active = owner;
      const signal = options.signal ? AbortSignal.any([owner.signal, options.signal]) : owner.signal;
      const ms = budget(options.describeMs, L.describeMs); const slice = budget(options.sliceMs, L.sliceMs);
      const listed = await within(s => sdk.plugins.list({ signal: s }), L.callMs, signal);
      if (signal.aborted) return fail('cancelled');
      const preferred = new Set(options.previouslyReady); const excluded = new Set(options.exclude);
      const targets = [...new Set(listed.plugins.filter(p => (p.status === 'running' || p.status === 'degraded') && !excluded.has(p.id)).map(p => p.id))]
        .sort((a,b) => Number(preferred.has(b)) - Number(preferred.has(a)) || (a < b ? -1 : a > b ? 1 : 0));
      const rows: DiscoveryRowV2[] = targets.map(pluginId => ({ pluginId, status: 'pending', admitted: false }));
      let index = 0; let running = false;
      const published = new Map<string, string>();
      const publish = () => {
        let count = 0;
        for (const row of rows) row.admitted = row.status === 'ready' && ++count <= L.suppliers;
        if (!signal.aborted) for (const row of rows) {
          const json = JSON.stringify(row);
          if (published.get(row.pluginId) === json) continue;
          published.set(row.pluginId, json);
          try { options.onRow?.(structuredClone(row)); }
          catch (e) { owner.abort(); throw e; }
        }
      };
      publish();
      return {
        snapshot: () => structuredClone(rows),
        dispose: () => owner.abort(),
        async next() {
          if (signal.aborted) return fail('cancelled');
          if (running) throw new Error('Discovery continuation already running');
          running = true;
          const end = performance.now() + slice;
          try {
            await Promise.all(Array.from({ length: L.concurrency }, async () => {
              while (index < rows.length && performance.now() < end && !signal.aborted) {
                const row = rows[index++]!;
                try {
                  const result = await createPeopleAccountsV2Client(sdk, row.pluginId, { callMs: Math.min(ms, Math.max(1, end - performance.now())) }).describe(signal);
                  if (signal.aborted) return;
                  if (result.status === 'ready') { row.status = 'ready'; row.capabilities = result.capabilities; }
                  else row.status = 'incompatible';
                } catch (e) {
                  if (signal.aborted) return;
                  row.status = classify(e).kind === 'absent' ? 'absent' : classify(e).kind === 'incompatible' || classify(e).kind === 'limit-exceeded' ? 'incompatible' : 'unavailable';
                }
                publish();
              }
            }));
            if (signal.aborted) return fail('cancelled');
            return { rows: structuredClone(rows), hasMore: index < rows.length, omittedCount: rows.filter(r => r.status === 'ready' && !r.admitted).length };
          } finally { running = false; }
        },
      };
    },
  };
}
