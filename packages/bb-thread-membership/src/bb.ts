/**
 * @phosphorco/bb-thread-membership/bb — SDK adapters over injected `bb`/`sdk`.
 * Suppliers register handlers; consumers build an owner-bound client keyed by
 * the source plugin id and request one bounded page at a time.
 */
import type { BbPluginApi, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { z, type ZodType } from 'zod';
import {
  LIMITS, METHODS, PROTOCOL, WIRE_VERSIONS, DescribeV1Schema, PageInputV1Schema, PageOutputV1Schema,
  canonicalJsonWithin, negotiateVersion, pageViolation,
  type JsonValue, type PageInputV1, type PageOutputV1,
} from './index.js';

export type MembershipErrorKind = 'absent' | 'vanished' | 'host-incompatible' | 'unavailable' | 'incompatible' | 'error' | 'unauthorized' | 'cancelled' | 'transient';

export class MembershipCallError extends Error {
  constructor(readonly kind: MembershipErrorKind, readonly cause?: unknown) {
    super(`Thread membership call failed: ${kind}`);
    this.name = 'MembershipCallError';
  }
}

/** Native status and body shape → per-supplier kind. */
export function classifyMembershipError(error: unknown): MembershipErrorKind {
  if (error instanceof MembershipCallError) return error.kind;
  const e = error as { name?: string; status?: number; body?: unknown } | null;
  if (e?.name === 'AbortError') return 'cancelled';
  if (e?.name === 'TimeoutError') return 'transient';
  if (e?.name === 'ZodError') return 'incompatible';
  const body = e?.body;
  const bodyError = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  const code = bodyError && typeof bodyError === 'object' ? (bodyError as { code?: unknown }).code : undefined;
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

type RpcHost = Pick<BbPluginApi, 'rpc'>;

/** Zod → the SDK's Standard Schema shape (same adapter as the sibling contract packages). */
function sdkSchema<T>(schema: ZodType<T>): StandardSchemaV1<T> {
  return { '~standard': {
    version: 1,
    vendor: 'bb-thread-membership',
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

export interface MembershipSupplierHandlers {
  /** Must not write. `caller` is attribution only. */
  page(input: z.output<typeof PageInputV1Schema>, context: { readonly caller: { kind: 'plugin'; pluginId: string } | { kind: 'client' } }): PageOutputV1 | Promise<PageOutputV1>;
}

/** Register describe + page with bounded, validated output. */
export function registerThreadMembershipSupplier(bb: RpcHost, handlers: MembershipSupplierHandlers): void {
  bb.rpc.register({
    [METHODS.describe]: { input: sdkSchema(z.null()), output: sdkSchema(DescribeV1Schema) },
    [METHODS.page]: { input: sdkSchema(PageInputV1Schema), output: sdkSchema(PageOutputV1Schema) },
  }, {
    [METHODS.describe]: () => ({ protocol: PROTOCOL, versions: [...WIRE_VERSIONS] }),
    [METHODS.page]: async (input: z.output<typeof PageInputV1Schema>, context: { experimental_caller?: { kind: 'plugin'; pluginId: string } | { kind: 'client' } }) => {
      const output = PageOutputV1Schema.parse(await handlers.page(input, { caller: context?.experimental_caller ?? { kind: 'client' } }));
      const violation = pageViolation(input, output);
      if (violation) throw new Error(violation);
      if (canonicalJsonWithin(output, LIMITS.responseBytes) === null) throw new Error('Membership page exceeds responseBytes.');
      return output;
    },
  } as never, { experimental_discoverable: true });
}

type PluginsSdk = Pick<BbPluginApi['sdk'], 'plugins'>;

export interface ThreadMembershipClient {
  readonly pluginId: string;
  describe(signal?: AbortSignal): Promise<{ version: 1 } | null>;
  page(input: PageInputV1, signal?: AbortSignal): Promise<PageOutputV1>;
}

/**
 * Settles locally at the deadline or on outer abort, even when the transport
 * ignores cancellation: the caller is released and a late result or rejection
 * is consumed and discarded. Aborting the transport signal asks the host to
 * stop; it does not prove remote work stopped. An already-aborted outer
 * signal never starts a call.
 */
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

/** Owner-bound: every call targets `pluginId` explicitly. */
export function createThreadMembershipClient(sdk: PluginsSdk, pluginId: string): ThreadMembershipClient {
  /**
   * One raw SDK call per client, held until the SDK promise itself settles —
   * not merely until the local deadline or abort released the caller. While
   * held, further calls fail at once as `transient` without reaching the
   * transport, so ignored-abort requests never stack. No retry is scheduled.
   * Keep one client per source for the consumer's lifetime for this to bound
   * anything; the package holds no global registry.
   */
  /** Owned token for the one admitted raw call; reserved before any injected SDK code runs. */
  let outstanding: object | null = null;
  async function call<T>(method: string, input: JsonValue, ms: number, maxBytes: number, accept: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    /** Absolute monotonic deadline for transport, size check and decoding together. */
    const deadlineAt = performance.now() + ms;
    if (signal?.aborted) throw new MembershipCallError('cancelled');
    if (outstanding) throw new MembershipCallError('transient', new Error('A previous call to this source has not settled yet.'));
    try {
      const value = await withDeadline((s) => {
        // Reserve first: the SDK call may synchronously re-enter this client.
        const token = {};
        outstanding = token;
        const release = () => { if (outstanding === token) outstanding = null; };
        let raw: Promise<unknown>;
        try { raw = Promise.resolve(sdk.plugins.callRpc({ pluginId, method, input, outputSchema: z.unknown(), signal: s })); }
        catch (error) { release(); throw error; }
        raw.then(release, release);
        return raw;
      }, deadlineAt, signal);
      // Any local check failure on what the source returned is incompatible output, never transient.
      let within: string | null;
      try { within = canonicalJsonWithin(value, maxBytes); } catch (cause) { throw new MembershipCallError('incompatible', cause); }
      if (within === null) throw new MembershipCallError('incompatible');
      const accepted = accept(value);
      if (performance.now() > deadlineAt) throw new MembershipCallError('transient', new DOMException('Timed out', 'TimeoutError'));
      return accepted;
    } catch (error) {
      if (signal?.aborted) throw new MembershipCallError('cancelled', error);
      throw error instanceof MembershipCallError ? error : new MembershipCallError(classifyMembershipError(error), error);
    }
  }
  return {
    pluginId,
    describe: async (signal) => call(METHODS.describe, null, LIMITS.describeMs, LIMITS.describeBytes, negotiateVersion, signal),
    page: async (input, signal) => {
      const parsed = PageInputV1Schema.parse(input);
      // A fresh wire object from validated parts; `scope` is ScopeSchema's detached snapshot.
      const wire: JsonValue = { scope: parsed.scope, cursor: parsed.cursor, limit: parsed.limit, ...(parsed.expectRevision === undefined ? {} : { expectRevision: parsed.expectRevision }) };
      return call(METHODS.page, wire, LIMITS.pageMs, LIMITS.responseBytes, (value) => {
        const decoded = PageOutputV1Schema.safeParse(value);
        if (!decoded.success) throw new MembershipCallError('incompatible', decoded.error);
        if (pageViolation(parsed, decoded.data)) throw new MembershipCallError('incompatible');
        return decoded.data;
      }, signal);
    },
  };
}
