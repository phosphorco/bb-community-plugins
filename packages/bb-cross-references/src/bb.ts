import { defineRpcContract } from '@get-bb/plugin-sdk';
import { crossReferencesV2RpcSchemas, MENTION_V2_LIMITS } from './evidence-v2.js';
import type { BbPluginApi, JsonValue, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import {
  crossReferencesRpcSchemas, CROSS_REFERENCES_PLUGIN_ID, CROSS_REFERENCES_PROTOCOL,
  LIMITS, utf8ByteLength, validateProducerPluginId,
  type ApplyProjectionInput, type ApplyProjectionResponse, type GetProjectionInput,
  type GetProjectionResponse, type ListBacklinksInput, type ListBacklinksResponse,
  type ListForwardReferencesInput, type ListForwardReferencesResponse,
  type CheckForwardReferencesInput, type ForwardReferenceStatus,
} from "./index.js";

export type CrossReferencesSdk = Pick<BbPluginApi["sdk"], "plugins"> | Pick<PluginBrowserBbSdk, "plugins">;
export interface CrossReferencesDescription {
  protocol: typeof CROSS_REFERENCES_PROTOCOL;
  version: 1;
  legacy: boolean;
}
export interface CrossReferencesClient {
  readonly pluginId: string;
  describe(signal?: AbortSignal): Promise<CrossReferencesDescription>;
  applyProjection(input: ApplyProjectionInput, signal?: AbortSignal): Promise<ApplyProjectionResponse>;
  getProjection(input: GetProjectionInput, signal?: AbortSignal): Promise<GetProjectionResponse>;
  listBacklinks(input: ListBacklinksInput, signal?: AbortSignal): Promise<ListBacklinksResponse>;
  listForwardReferences(input: ListForwardReferencesInput, signal?: AbortSignal): Promise<ListForwardReferencesResponse>;
  checkForwardReferences(input: CheckForwardReferencesInput, signal?: AbortSignal): Promise<ForwardReferenceStatus[]>;
}
export class CrossReferencesProtocolError extends Error {
  readonly code = "incompatible_protocol";
  constructor(message: string) { super(message); this.name = "CrossReferencesProtocolError"; }
}
export interface CrossReferencesClientOptions {
  /** Budgets may only lower the package's published upper bounds. */
  callMs?: number;
  describeMs?: number;
}
function budget(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new RangeError(`Budget must be > 0 and <= ${maximum}.`);
  return value;
}

/** Explicit target, no hooks, storage, scheduling, retry or singleton. */
export function createCrossReferencesClient(
  sdk: CrossReferencesSdk,
  targetPluginId = CROSS_REFERENCES_PLUGIN_ID,
  options: CrossReferencesClientOptions = {},
): CrossReferencesClient {
  const pluginId = validateProducerPluginId(targetPluginId);
  const callMs = budget(options.callMs, LIMITS.callMs);
  const describeMs = budget(options.describeMs, LIMITS.describeMs);
  async function call<T>(method: string, input: unknown, inputSchema: z.ZodType, outputSchema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const parsedInput = inputSchema.parse(input);
    if (signal?.aborted) throw signal.reason ?? new DOMException("Request aborted", "AbortError");
    const controller = new AbortController();
    let rejectCancellation: (reason: unknown) => void = () => {};
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const abort = () => {
      const reason = signal?.reason ?? new DOMException("Request aborted", "AbortError");
      rejectCancellation(reason);
      controller.abort(reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      const reason = Object.assign(new Error(`Cross References ${method} timed out`), { name: "TimeoutError", code: "timeout" });
      rejectCancellation(reason);
      controller.abort(reason);
    }, method === "crossReferences.describe" ? describeMs : callMs);
    try {
      // SDK parses the envelope first; only the decoded canonical JSON bytes can
      // be bounded here. Validate the DTO after admission, including mocked SDKs.
      const value = await Promise.race([
        sdk.plugins.callRpc({ pluginId, method, input: JSON.parse(JSON.stringify(parsedInput)) as JsonValue, outputSchema: z.unknown(), signal: controller.signal }),
        cancelled,
      ]);
      const json = JSON.stringify(value);
      if (json === undefined || utf8ByteLength(json) > LIMITS.responseBytes) throw new CrossReferencesProtocolError("RPC result exceeds its canonical JSON byte limit or is not JSON.");
      return outputSchema.parse(value);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  function operation<K extends Exclude<keyof typeof crossReferencesRpcSchemas, "crossReferences.describe">>(method: K, input: unknown, signal?: AbortSignal) {
    const schemas = crossReferencesRpcSchemas[method];
    return call(method, input, schemas.input, schemas.output as z.ZodType<unknown>, signal);
  }
  return {
    pluginId,
    async describe(signal) {
      const schemas = crossReferencesRpcSchemas["crossReferences.describe"];
      try {
        const description = await call("crossReferences.describe", null, schemas.input, schemas.output, signal);
        if (!description.versions.includes(1)) throw new CrossReferencesProtocolError("Cross References does not support wire version 1.");
        return { protocol: CROSS_REFERENCES_PROTOCOL, version: 1, legacy: false };
      } catch (error) {
        // A missing describe method on an otherwise installed v1 peer is the
        // sole compatibility fallback. Missing/disabled plugins and bad DTOs fail.
        if (typeof error === "object" && error !== null && "code" in error && error.code === "unknown_method") {
          return { protocol: CROSS_REFERENCES_PROTOCOL, version: 1, legacy: true };
        }
        throw error;
      }
    },
    applyProjection: (input, signal) => operation("applyProjection", input, signal) as Promise<ApplyProjectionResponse>,
    getProjection: (input, signal) => operation("getProjection", input, signal) as Promise<GetProjectionResponse>,
    listBacklinks: (input, signal) => operation("listBacklinks", input, signal) as Promise<ListBacklinksResponse>,
    listForwardReferences: (input, signal) => operation("listForwardReferences", input, signal) as Promise<ListForwardReferencesResponse>,
    checkForwardReferences: (input, signal) => operation("checkForwardReferences", input, signal) as Promise<ForwardReferenceStatus[]>,
  };
}

/** V2 never negotiates down to strict V1 reads or legacy missing-describe. */
export interface CrossReferencesV2Client {
 readonly pluginId:string;
 describe(signal?:AbortSignal):Promise<{protocol:typeof CROSS_REFERENCES_PROTOCOL;version:2}>;
 listMentions(input:import('./evidence-v2.js').ListMentionsInputV2,signal?:AbortSignal):Promise<import('./evidence-v2.js').ListMentionsOutputV2>;
 resolveLookup(input:import('./evidence-v2.js').ResolveLookupInputV2,signal?:AbortSignal):Promise<import('./evidence-v2.js').ResolveLookupOutputV2>;
}
export function createCrossReferencesV2Client(sdk:CrossReferencesSdk,targetPluginId=CROSS_REFERENCES_PLUGIN_ID,options:CrossReferencesClientOptions={}):CrossReferencesV2Client {
 const pluginId=validateProducerPluginId(targetPluginId),callMs=budget(options.callMs,LIMITS.callMs),describeMs=budget(options.describeMs,LIMITS.describeMs);
 async function call<T>(method:string,input:unknown,inputSchema:z.ZodType,outputSchema:z.ZodType<T>,signal?:AbortSignal):Promise<T>{
  const parsed=inputSchema.parse(input),json=JSON.stringify(parsed);
  if(utf8ByteLength(json)>MENTION_V2_LIMITS.inputBytes)throw new CrossReferencesProtocolError('V2 input exceeds its byte bound.');
  signal?.throwIfAborted();const controller=new AbortController();let reject!:(error:unknown)=>void;
  const cancelled=new Promise<never>((_,r)=>{reject=r;});
  const abort=()=>{const e=signal?.reason??new DOMException('Request aborted','AbortError');controller.abort(e);reject(e);};
  signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{const e=Object.assign(new Error('Cross References V2 timed out.'),{name:'TimeoutError',code:'timeout'});controller.abort(e);reject(e);},method==='crossReferences.describe'?describeMs:callMs);
  try{const value=await Promise.race([sdk.plugins.callRpc({pluginId,method,input:JSON.parse(json) as JsonValue,outputSchema:z.unknown(),signal:controller.signal}),cancelled]);
   const encoded=JSON.stringify(value);if(encoded===undefined||utf8ByteLength(encoded)>MENTION_V2_LIMITS.responseBytes)throw new CrossReferencesProtocolError('V2 response exceeds its canonical JSON byte bound.');
   return outputSchema.parse(value);
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 }
 return {pluginId,async describe(signal){const s=crossReferencesRpcSchemas['crossReferences.describe'];const d=await call('crossReferences.describe',null,s.input,s.output,signal);if(!d.versions.includes(2))throw new CrossReferencesProtocolError('Wire V2 unavailable.');return {protocol:CROSS_REFERENCES_PROTOCOL,version:2};},
  listMentions:(input,signal)=>call('crossReferencesV2ListMentions',input,crossReferencesV2RpcSchemas.crossReferencesV2ListMentions.input,crossReferencesV2RpcSchemas.crossReferencesV2ListMentions.output,signal),
  resolveLookup:(input,signal)=>call('crossReferencesV2ResolveLookup',input,crossReferencesV2RpcSchemas.crossReferencesV2ResolveLookup.input,crossReferencesV2RpcSchemas.crossReferencesV2ResolveLookup.output,signal)};
}
// Zod's optional issue fields are wider than the SDK's exact optional shape.
// Adapt validation results at this boundary while preserving both inferred
// types (including output transforms) and the actual strict/tolerant schemas.
function sdkSchema<S extends z.ZodType>(schema:S):StandardSchemaV1<z.input<S>,z.output<S>> {
 return {'~standard':{
  version:1,vendor:'bb-cross-references',
  jsonSchema:{
   input:()=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}),
   output:()=>z.toJSONSchema(schema,{io:'output',unrepresentable:'any'}),
  },
  validate(value){
   const parsed=schema.safeParse(value);
   return parsed.success?{value:parsed.data}:{issues:parsed.error.issues.map(issue=>({message:issue.message,path:issue.path}))};
  },
 }};
}
export const crossReferencesV2RpcContract=defineRpcContract({
 crossReferencesV2ListMentions:{input:sdkSchema(crossReferencesV2RpcSchemas.crossReferencesV2ListMentions.input),output:sdkSchema(crossReferencesV2RpcSchemas.crossReferencesV2ListMentions.output)},
 crossReferencesV2ResolveLookup:{input:sdkSchema(crossReferencesV2RpcSchemas.crossReferencesV2ResolveLookup.input),output:sdkSchema(crossReferencesV2RpcSchemas.crossReferencesV2ResolveLookup.output)},
});
export function registerCrossReferencesV2(bb:Pick<BbPluginApi,'rpc'>,handlers:{
 crossReferencesV2ListMentions:(input:import('./evidence-v2.js').ListMentionsInputV2)=>import('./evidence-v2.js').ListMentionsOutputV2|Promise<import('./evidence-v2.js').ListMentionsOutputV2>;
 crossReferencesV2ResolveLookup:(input:import('./evidence-v2.js').ResolveLookupInputV2)=>import('./evidence-v2.js').ResolveLookupOutputV2|Promise<import('./evidence-v2.js').ResolveLookupOutputV2>;
}):void {bb.rpc.register(crossReferencesV2RpcContract,handlers);}


// Independent producer family. Never retry a write or fall back to V1.
import {
 crossReferencesProducerRpcSchemas, PRODUCER_METHODS, BRIEF_LIMITS, BRIEF_NAVIGATION_METHODS,
 briefNavigationRpcSchemas, briefApplyLimitCodes, BriefAdmissionError, validateBriefCommand, validateBriefNavigationResultV1,
 type ProducerGetStateInput,type ProducerState,type ProducerApplyInput,type ProducerApplyOutput,
 type ProducerReportStatusInput,type ProducerReportStatusOutput,type BriefNavigationInput,type BriefNavigationOutput,
} from './index.js';

function byteSdkSchema<S extends z.ZodType>(schema:S,bytes:number):StandardSchemaV1<z.input<S>,z.output<S>> {
 const base=sdkSchema(schema);return {'~standard':{...base['~standard'],validate(value){
  try{const json=JSON.stringify(value);if(json===undefined||utf8ByteLength(json)>bytes)return {issues:[{message:'Protocol byte bound exceeded.'}]};}
  catch{return {issues:[{message:'Invalid protocol JSON.'}]};}
  return base['~standard'].validate(value);
 }}};
}
const ps=crossReferencesProducerRpcSchemas,ns=briefNavigationRpcSchemas;
export const crossReferencesProducerRpcContract=defineRpcContract({
 [PRODUCER_METHODS.describe]:{input:byteSdkSchema(ps[PRODUCER_METHODS.describe].input,BRIEF_LIMITS.statusBytes),output:byteSdkSchema(ps[PRODUCER_METHODS.describe].output,BRIEF_LIMITS.statusBytes)},
 [PRODUCER_METHODS.getState]:{input:byteSdkSchema(ps[PRODUCER_METHODS.getState].input,BRIEF_LIMITS.statusBytes),output:byteSdkSchema(ps[PRODUCER_METHODS.getState].output,BRIEF_LIMITS.responseBytes)},
 [PRODUCER_METHODS.apply]:{input:byteSdkSchema(ps[PRODUCER_METHODS.apply].input,BRIEF_LIMITS.inputBytes),output:byteSdkSchema(ps[PRODUCER_METHODS.apply].output,BRIEF_LIMITS.responseBytes)},
 [PRODUCER_METHODS.reportStatus]:{input:byteSdkSchema(ps[PRODUCER_METHODS.reportStatus].input,BRIEF_LIMITS.statusBytes),output:byteSdkSchema(ps[PRODUCER_METHODS.reportStatus].output,BRIEF_LIMITS.responseBytes)},
});
export function registerCrossReferencesProducer(bb:Pick<BbPluginApi,'rpc'>,handlers:{
 'crossReferencesProducer.describe':()=>z.output<typeof ps['crossReferencesProducer.describe']['output']>;
 crossReferencesProducerV1GetState:(input:ProducerGetStateInput)=>ProducerState|Promise<ProducerState>;
 crossReferencesProducerV1Apply:(input:ProducerApplyInput)=>ProducerApplyOutput|Promise<ProducerApplyOutput>;
 crossReferencesProducerV1ReportStatus:(input:ProducerReportStatusInput)=>ProducerReportStatusOutput|Promise<ProducerReportStatusOutput>;
}){bb.rpc.register(crossReferencesProducerRpcContract,handlers);}
export const briefNavigationRpcContract=defineRpcContract({
 [BRIEF_NAVIGATION_METHODS.describe]:{input:byteSdkSchema(ns[BRIEF_NAVIGATION_METHODS.describe].input,8192),output:byteSdkSchema(ns[BRIEF_NAVIGATION_METHODS.describe].output,16384)},
 [BRIEF_NAVIGATION_METHODS.resolve]:{input:byteSdkSchema(ns[BRIEF_NAVIGATION_METHODS.resolve].input,8192),output:byteSdkSchema(ns[BRIEF_NAVIGATION_METHODS.resolve].output,16384)},
});
export function registerBriefNavigation(bb:Pick<BbPluginApi,'rpc'>,handlers:{
 'threadBriefNavigation.describe':()=>z.output<typeof ns['threadBriefNavigation.describe']['output']>;
 threadBriefNavigationV1ResolveHeading:(input:BriefNavigationInput)=>BriefNavigationOutput|Promise<BriefNavigationOutput>;
}){bb.rpc.register(briefNavigationRpcContract,handlers);}
/** JSON is already parsed by the host; these are canonical pre-domain bounds. */
function boundedFamilyCall(sdk:CrossReferencesSdk,pluginId:string,options:CrossReferencesClientOptions={}){
 validateProducerPluginId(pluginId);const callMs=budget(options.callMs,5000),describeMs=budget(options.describeMs,1000);
 return async function call<T>(method:string,input:unknown,inputSchema:z.ZodType,outputSchema:z.ZodType<T>,inputBytes:number,outputBytes:number,signal?:AbortSignal):Promise<T>{
  const before=JSON.stringify(input);if(before===undefined||utf8ByteLength(before)>inputBytes)throw new CrossReferencesProtocolError('Protocol input exceeds its byte bound.');
  const parsed=inputSchema.parse(input);signal?.throwIfAborted();const controller=new AbortController();let reject!:(e:unknown)=>void;
  const cancelled=new Promise<never>((_,r)=>{reject=r;});const abort=()=>{const e=signal?.reason??new DOMException('Request aborted','AbortError');controller.abort(e);reject(e);};signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{const e=Object.assign(new Error('Protocol call timed out.'),{name:'TimeoutError',code:'timeout'});controller.abort(e);reject(e);},method.endsWith('.describe')?describeMs:callMs);
  try{const value=await Promise.race([sdk.plugins.callRpc({pluginId,method,input:JSON.parse(JSON.stringify(parsed)) as JsonValue,outputSchema:z.unknown(),signal:controller.signal}),cancelled]);const json=JSON.stringify(value);if(json===undefined||utf8ByteLength(json)>outputBytes)throw new CrossReferencesProtocolError('Protocol output exceeds its byte bound.');return outputSchema.parse(value);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
 };
}
export function createCrossReferencesProducerClient(sdk:CrossReferencesSdk,pluginId=CROSS_REFERENCES_PLUGIN_ID,options:CrossReferencesClientOptions={}){
 const call=boundedFamilyCall(sdk,pluginId,options);
 return {pluginId,
  async describe(signal?:AbortSignal){const d=await call(PRODUCER_METHODS.describe,null,ps[PRODUCER_METHODS.describe].input,ps[PRODUCER_METHODS.describe].output,16384,16384,signal);if(!d.versions.includes(1))throw new CrossReferencesProtocolError('Producer protocol unavailable.');return d;},
  getState:(input:ProducerGetStateInput,signal?:AbortSignal)=>call(PRODUCER_METHODS.getState,input,ps[PRODUCER_METHODS.getState].input,ps[PRODUCER_METHODS.getState].output,16384,1048576,signal),
  apply(input:ProducerApplyInput,signal?:AbortSignal){const limits=briefApplyLimitCodes(input);if(limits.length)return Promise.reject(new BriefAdmissionError('over-limit',limits));validateBriefCommand(input.projection,input.evidence,input.evidenceDigest);return call(PRODUCER_METHODS.apply,input,ps[PRODUCER_METHODS.apply].input,ps[PRODUCER_METHODS.apply].output,1048576,1048576,signal);},
  reportStatus:(input:ProducerReportStatusInput,signal?:AbortSignal)=>call(PRODUCER_METHODS.reportStatus,input,ps[PRODUCER_METHODS.reportStatus].input,ps[PRODUCER_METHODS.reportStatus].output,16384,1048576,signal),
 };
}
export type CrossReferencesProducerClient=ReturnType<typeof createCrossReferencesProducerClient>;
export function createBriefNavigationClient(sdk:CrossReferencesSdk,options:CrossReferencesClientOptions={}){
 const call=boundedFamilyCall(sdk,'thread-brief',options);return {
  async describe(signal?:AbortSignal){const d=await call(BRIEF_NAVIGATION_METHODS.describe,null,ns[BRIEF_NAVIGATION_METHODS.describe].input,ns[BRIEF_NAVIGATION_METHODS.describe].output,8192,16384,signal);if(!d.versions.includes(1))throw new CrossReferencesProtocolError('Brief navigation unavailable.');return d;},
  async resolve(input:BriefNavigationInput,signal?:AbortSignal){const value=await call(BRIEF_NAVIGATION_METHODS.resolve,input,ns[BRIEF_NAVIGATION_METHODS.resolve].input,ns[BRIEF_NAVIGATION_METHODS.resolve].output,8192,16384,signal);
   return validateBriefNavigationResultV1(input,value);
  },
 };
}
