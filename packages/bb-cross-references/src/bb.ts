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
