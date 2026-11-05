import type { BbPluginApi, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { PROTOCOL, METHODS, LIMITS, describeEnvelopeSchema, describeSchema, choicesInputSchema, choicesOutputSchema, matchInputSchema, matchOutputSchema, valuesInputSchema, valuesOutputSchema, validateValuesInput, validateValues, parseBounded, validateMatch, type ValuesInput, type ValuesOutput, type Dimension, type ChoicesInput, type ChoicesOutput, type MatchInput, type MatchOutput } from './index.js';
function sdkSchema<T>(schema: z.ZodType<T>): StandardSchemaV1<T> {
  return { '~standard': { version: 1, vendor: PROTOCOL, jsonSchema: { input: () => schema.toJSONSchema({io: 'input', unrepresentable: 'any'}), output: () => schema.toJSONSchema({io: 'output', unrepresentable: 'any'}) }, validate(value: unknown) { const r = schema.safeParse(value); return r.success ? { value: r.data } : { issues: r.error.issues }; } } } as StandardSchemaV1<T>;
}
export interface FilterSupplier<Context = void> {
  dimensions: readonly Dimension[];
  choices(input: ChoicesInput, context?: Context): ChoicesOutput | Promise<ChoicesOutput>;
  match(input: MatchInput, context?: Context): MatchOutput | Promise<MatchOutput>;
}
/** One registration supplies both filtering and columns for every dimension. */
export interface AttributeSupplier<Context = void> extends FilterSupplier<Context> {
  values(input: ValuesInput, context?: Context): ValuesOutput | Promise<ValuesOutput>;
}
export const threadFilterRpcContract = {
  [METHODS.describe]: { input: sdkSchema(z.null()), output: sdkSchema(z.unknown()) },
  [METHODS.choices]: { input: sdkSchema(choicesInputSchema), output: sdkSchema(z.unknown()) },
  [METHODS.match]: { input: sdkSchema(matchInputSchema), output: sdkSchema(z.unknown()) },
};
export const threadAttributeRpcContract = {...threadFilterRpcContract,[METHODS.values]:{input:sdkSchema(valuesInputSchema),output:sdkSchema(z.unknown())}};
export function createThreadFilterHandlers<Context>(supplier: FilterSupplier<Context>) {
  const description = parseBounded(describeSchema,{ protocol: PROTOCOL, versions: [1], dimensions: supplier.dimensions },LIMITS.describeBytes);
  if (new Set(description.dimensions.map(d => d.id)).size !== description.dimensions.length) throw Error('Duplicate filter dimensions.');
  const checkDimension = (id: string) => { if (!description.dimensions.some(d => d.id === id)) throw Error('Unknown filter dimension.'); };
  return {
    describe: () => description,
    async choices(raw: unknown, context?: Context) { const input = parseBounded(choicesInputSchema, raw, LIMITS.inputBytes); checkDimension(input.dimensionId); const output = parseBounded(choicesOutputSchema, await supplier.choices(input,context), LIMITS.outputBytes); if ((output.nextCursor !== null && output.nextCursor === input.cursor) || output.choices.length > input.limit || new Set(output.choices.map(c => c.id)).size !== output.choices.length) throw Error('Invalid choices page.'); return output; },
    async match(raw: unknown, context?: Context) { const input = parseBounded(matchInputSchema, raw, LIMITS.inputBytes); checkDimension(input.selection.dimensionId); const dimension = description.dimensions.find(d => d.id === input.selection.dimensionId)!; if (!dimension.multiple && input.selection.values.length !== 1) throw Error('Filter requires one choice.'); return validateMatch(input, parseBounded(matchOutputSchema, await supplier.match(input,context), LIMITS.outputBytes)); },
  };
}
export function createThreadAttributeHandlers<Context>(supplier: AttributeSupplier<Context>) {
  if(typeof supplier.values!=='function')throw Error('Attributes require display values together with filtering.');
  const filters=createThreadFilterHandlers(supplier);
  return {...filters,describe:()=>({...filters.describe(),valueVersions:[1]}),async values(raw:unknown,context?:Context){
    const input=validateValuesInput(parseBounded(valuesInputSchema,raw,LIMITS.inputBytes));
    for(const id of input.dimensionIds)if(!supplier.dimensions.some(d=>d.id===id))throw Error('Unknown attribute dimension.');
    const output=validateValues(input,parseBounded(valuesOutputSchema,await supplier.values(input,context),LIMITS.outputBytes));
    for(const row of output.rows)for(const cell of row.cells)if(!supplier.dimensions.find(d=>d.id===cell.dimensionId)!.multiple&&cell.values.length>1)throw Error('Single-valued attribute returned multiple values.');
    return output;
  }};
}
export function registerThreadAttributeSupplier(bb: Pick<BbPluginApi,'rpc'>,supplier:AttributeSupplier):void {
  const handlers=createThreadAttributeHandlers(supplier);
  bb.rpc.register(threadAttributeRpcContract,{[METHODS.describe]:handlers.describe,[METHODS.choices]:(input:unknown)=>handlers.choices(input),[METHODS.match]:(input:unknown)=>handlers.match(input),[METHODS.values]:(input:unknown)=>handlers.values(input)} as never,{experimental_discoverable:true});
}
/** Legacy filter-only registration. New attributes use registerThreadAttributeSupplier. */
export function registerThreadFilterSupplier(bb: Pick<BbPluginApi, 'rpc'>, supplier: FilterSupplier): void {
  const handlers = createThreadFilterHandlers(supplier);
  bb.rpc.register(threadFilterRpcContract, {
    [METHODS.describe]: handlers.describe,
    [METHODS.choices]: (input: unknown) => handlers.choices(input),
    [METHODS.match]: (input: unknown) => handlers.match(input),
  } as never, { experimental_discoverable: true });
}
export type FilterCall = { pluginId: string; method: string; input: null | ChoicesInput | MatchInput | ValuesInput; signal: AbortSignal };
export type FilterTransport = (call: FilterCall) => Promise<unknown>;
export function createThreadFilterClient(transport: FilterTransport, pluginId: string) {
  let outstanding = false;
  async function rawCall(method: string, input: FilterCall['input'], outer?: AbortSignal): Promise<unknown> {
    if (outstanding) throw Error('A filter call is still outstanding.');
    if (outer?.aborted) throw new DOMException('Aborted', 'AbortError');
    outstanding = true;
    const controller = new AbortController(), signal = outer ? AbortSignal.any([outer, controller.signal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = performance.now();
    const flight = Promise.resolve().then(() => transport({pluginId,method,input,signal})).finally(() => { outstanding = false; });
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Thread filter call timed out. Refresh to try again.')); }, LIMITS.callMs);
    });
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => { abort = () => reject(new DOMException('Aborted', 'AbortError')); signal.addEventListener('abort', abort, { once: true }); });
    try { const raw = await Promise.race([flight, interrupted, aborted]); if (performance.now() - start > LIMITS.callMs) throw Error('Thread filter call timed out.'); return raw; }
    finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
  let queue: Promise<unknown> = Promise.resolve(), queued = 0;
  function call(method: string, input: FilterCall['input'], outer?: AbortSignal): Promise<unknown> {
    if (queued >= 32) return Promise.reject(Error('Thread filter request queue is full.'));
    if (outer?.aborted) return Promise.reject(new DOMException('Aborted','AbortError'));
    queued++;
    const controller=new AbortController(), signal=outer ? AbortSignal.any([outer,controller.signal]) : controller.signal;
    const deadline=performance.now()+LIMITS.callMs;
    let timer: ReturnType<typeof setTimeout> | undefined, abort: (()=>void) | undefined;
    const interrupted=new Promise<never>((_,reject)=>{
      abort=()=>reject(new DOMException('Aborted','AbortError'));
      signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>{controller.abort();reject(Error('Thread filter call timed out.'));},LIMITS.callMs);
    });
    const scheduled=queue.then(()=>rawCall(method,input,signal)).finally(()=>{queued--;});
    queue=scheduled.catch(()=>undefined);
    return Promise.race([scheduled,interrupted]).then(raw=>{
      if(performance.now()>deadline)throw Error('Thread filter call timed out.');
      return raw;
    }).finally(()=>{clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);});
  }
  return {
    pluginId,
    async describeAttributes(signal?:AbortSignal) {
      const raw=await call(METHODS.describe,null,signal),envelope=parseBounded(describeEnvelopeSchema,raw,LIMITS.describeBytes);
      if(!envelope.versions.includes(1))throw Error('Unsupported filter protocol version.');
      const result=parseBounded(describeSchema,raw,LIMITS.describeBytes);
      if(new Set(result.dimensions.map(d=>d.id)).size!==result.dimensions.length)throw Error('Duplicate dimensions.');
      return {dimensions:result.dimensions,values:result.valueVersions?.includes(1)??false};
    },
    async describe(signal?: AbortSignal) {
      const raw = await call(METHODS.describe, null, signal), envelope = parseBounded(describeEnvelopeSchema, raw, LIMITS.describeBytes);
      if (!envelope.versions.includes(1)) throw Error('Unsupported filter protocol version.');
      const result = parseBounded(describeSchema, raw, LIMITS.describeBytes);
      if (new Set(result.dimensions.map(d => d.id)).size !== result.dimensions.length) throw Error('Duplicate dimensions.');
      return result.dimensions;
    },
    async choices(input: ChoicesInput, signal?: AbortSignal) { const valid = parseBounded(choicesInputSchema,input,LIMITS.inputBytes); const result = parseBounded(choicesOutputSchema, await call(METHODS.choices, valid, signal), LIMITS.outputBytes); if ((result.nextCursor !== null && result.nextCursor === valid.cursor) || result.choices.length > valid.limit || new Set(result.choices.map(c => c.id)).size !== result.choices.length) throw Error('Invalid choices page.'); return result; },
    async match(input: MatchInput, signal?: AbortSignal) { const valid = parseBounded(matchInputSchema,input,LIMITS.inputBytes); return validateMatch(valid, parseBounded(matchOutputSchema, await call(METHODS.match, valid, signal), LIMITS.outputBytes)); },
    async values(input:ValuesInput,signal?:AbortSignal){const valid=validateValuesInput(parseBounded(valuesInputSchema,input,LIMITS.inputBytes));return validateValues(valid,parseBounded(valuesOutputSchema,await call(METHODS.values,valid,signal),LIMITS.outputBytes));},
  };
}
