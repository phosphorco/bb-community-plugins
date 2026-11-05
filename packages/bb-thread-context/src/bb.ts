import type {BbPluginApi,StandardSchemaV1} from '@get-bb/plugin-sdk';
import {z,type ZodType} from 'zod';
import {LIMITS,METHODS,PROTOCOL,WIRE_VERSIONS,describeSchema,readInputSchema,readOutputSchema,canonicalJsonWithin,decodeRead,negotiateVersion,type ReadInput,type ReadOutput} from './index.js';
import type {JsonValue} from './json.js';
export type ContextErrorKind = 'absent' | 'vanished' | 'host-incompatible' | 'unavailable' | 'incompatible' | 'error' | 'unauthorized' | 'cancelled' | 'transient';

export class ContextCallError extends Error {
  constructor(readonly kind: ContextErrorKind, readonly cause?: unknown) {
    super(`Thread context call failed: ${kind}`);
    this.name = 'ContextCallError';
  }
}

/** Native status and body shape → per-supplier kind. */
export function classifyContextError(error: unknown): ContextErrorKind {
  if (error instanceof ContextCallError) return error.kind;
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

function sdkSchema<T>(schema: ZodType<T>): StandardSchemaV1<T> {
  return { '~standard': {
    version: 1,
    vendor: 'bb-thread-context',
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


export function registerThreadContextSupplier(bb:Pick<BbPluginApi,'rpc'>,handler:(input:ReadInput,context:{signal:AbortSignal})=>ReadOutput|Promise<ReadOutput>):void {
 let held=0;
 bb.rpc.register({[METHODS.describe]:{input:sdkSchema(z.unknown()),output:sdkSchema(describeSchema)},[METHODS.read]:{input:sdkSchema(readInputSchema),output:sdkSchema(readOutputSchema)}},{
  [METHODS.describe]:()=>({protocol:PROTOCOL,versions:[...WIRE_VERSIONS]}),
  [METHODS.read]:async(input:ReadInput)=>{
   if(held>=LIMITS.supplierRawReads)return {state:'unavailable',threadId:input.threadId,reason:'busy'};
   const deadline=performance.now()+LIMITS.supplierReadMs;
   try{return await withDeadline(signal=>{held++;const raw=Promise.resolve().then(()=>handler(input,{signal}));raw.then(()=>held--,()=>held--);return raw;},deadline).then(value=>decodeRead(input,value));}
   catch(error){if(error instanceof DOMException&&error.name==='TimeoutError')return {state:'unavailable',threadId:input.threadId,reason:'timeout'};throw error;}
  },
 } as never,{experimental_discoverable:true});
}
/** Keep one client per listed owner for the consumer lifetime. Timed-out raw calls retain admission until actual settlement. */
export function createThreadContextClient(sdk:Pick<BbPluginApi['sdk'],'plugins'>,pluginId:string) {
  let outstanding: object | null = null;
  async function call<T>(method: string, input: JsonValue, ms: number, maxBytes: number, accept: (value: unknown) => T, signal?: AbortSignal): Promise<T> {
    /** Absolute monotonic deadline for transport, size check and decoding together. */
    const deadlineAt = performance.now() + ms;
    if (signal?.aborted) throw new ContextCallError('cancelled');
    if (outstanding) throw new ContextCallError('transient', new Error('A previous call to this source has not settled yet.'));
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
      try { within = canonicalJsonWithin(value, maxBytes); } catch (cause) { throw new ContextCallError('incompatible', cause); }
      if (within === null) throw new ContextCallError('incompatible');
      let accepted:T;
      try{accepted=accept(value);}catch(cause){throw cause instanceof ContextCallError?cause:new ContextCallError('incompatible',cause);}
      if (performance.now() > deadlineAt) throw new ContextCallError('transient', new DOMException('Timed out', 'TimeoutError'));
      return accepted;
    } catch (error) {
      if (signal?.aborted) throw new ContextCallError('cancelled', error);
      throw error instanceof ContextCallError ? error : new ContextCallError(classifyContextError(error), error);
    }
  }
 return {pluginId,
 describe:(signal?:AbortSignal)=>call(METHODS.describe,null,LIMITS.describeMs,LIMITS.describeBytes,negotiateVersion,signal),
 read:(input:ReadInput,signal?:AbortSignal)=>{const parsed=readInputSchema.parse(input);return call(METHODS.read,parsed,LIMITS.readMs,LIMITS.responseBytes,value=>decodeRead(parsed,value),signal);},
 };
}
