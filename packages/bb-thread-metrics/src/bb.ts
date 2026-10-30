import { z } from 'zod';
import type { BbPluginApi, JsonValue, StandardSchemaV1 } from '@get-bb/plugin-sdk';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
import { HEAT_SETTINGS_METHODS,HEAT_SETTINGS_LIMITS,bounded,validateHeatSaveInput,heatSettingsReadInputSchema,heatSettingsSaveInputSchema,heatSettingsReadResultSchema,heatSettingsSaveResultSchema } from './index.js';
import type { HeatSettingsPort,HeatSettingsReadInput,HeatSettingsSaveInput } from './index.js';
import { RECENT_LIMITS,recentSnapshotInputSchema,validateRecentSnapshot,LIMITS, METHODS, describeInputSchema, describeEnvelopeSchema, capabilitiesSchema, readInputSchema, detailInputSchema, parseBounded, negotiateVersion, validateReadResult, validateDetailResult, classifyOwnerError } from './index.js';
import type { RecentSnapshotInput,RecentSnapshotResult,ReadInput, ReadResult, DetailInput, DetailResult, Capabilities, OwnerErrorKind } from './index.js';
export type MetricsSdk={readonly plugins:Pick<BbPluginApi['sdk']['plugins'],'list'|'callRpc'>}|{readonly plugins:Pick<PluginBrowserBbSdk['plugins'],'list'|'callRpc'>};
export function registerHeatSettingsOwner(bb:Pick<BbPluginApi,'rpc'>,port:HeatSettingsPort):void {
 bb.rpc.register({
  threadMetricsHeatSettingsReadV1:{input:sdkSchema(heatSettingsReadInputSchema,HEAT_SETTINGS_LIMITS.inputBytes),output:sdkSchema(z.unknown())},
  threadMetricsHeatSettingsSaveV1:{input:sdkSchema(heatSettingsSaveInputSchema,HEAT_SETTINGS_LIMITS.inputBytes),output:sdkSchema(z.unknown())},
 },{
  threadMetricsHeatSettingsReadV1:async(raw:unknown)=>bounded(heatSettingsReadResultSchema,await port.read(bounded(heatSettingsReadInputSchema,raw,HEAT_SETTINGS_LIMITS.inputBytes)),HEAT_SETTINGS_LIMITS.outputBytes),
  threadMetricsHeatSettingsSaveV1:async(raw:unknown)=>bounded(heatSettingsSaveResultSchema,await port.save(validateHeatSaveInput(raw)),HEAT_SETTINGS_LIMITS.outputBytes),
 },{experimental_discoverable:true});
}
export function createHeatSettingsClient(sdk:MetricsSdk,pluginId:string):HeatSettingsPort {
 if(!pluginId||pluginId.length>200)throw new Error('Invalid target plugin id');
 const call=async(method:string,input:unknown,signal?:AbortSignal)=>sdk.plugins.callRpc({pluginId,method,input:input as JsonValue,outputSchema:z.unknown(),...(signal?{signal}:{})});
 return {
  read:async(input:HeatSettingsReadInput,signal?:AbortSignal)=>bounded(heatSettingsReadResultSchema,await call(HEAT_SETTINGS_METHODS.read,bounded(heatSettingsReadInputSchema,input,HEAT_SETTINGS_LIMITS.inputBytes),signal),HEAT_SETTINGS_LIMITS.outputBytes),
  save:async(input:HeatSettingsSaveInput,signal?:AbortSignal)=>{
   const result=bounded(heatSettingsSaveResultSchema,await call(HEAT_SETTINGS_METHODS.save,validateHeatSaveInput(input),signal),HEAT_SETTINGS_LIMITS.outputBytes);
   if(result.operationKey!==input.operationKey)throw new Error('Save operation mismatch');return result;
  },
 };
}
function sdkSchema<T>(schema:z.ZodType<T>,maxBytes?:number):StandardSchemaV1<T>{
 return {'~standard':{version:1,vendor:'bb-thread-metrics',jsonSchema:{input:()=>z.toJSONSchema(schema,{io:'input',unrepresentable:'any'}),output:()=>z.toJSONSchema(schema,{io:'output',unrepresentable:'any'})},validate(value){try{return {value:maxBytes===undefined?schema.parse(value):parseBounded(schema,value,maxBytes)};}catch(e){return {issues:e instanceof z.ZodError?e.issues.map(i=>({message:i.message,path:i.path})):[{message:'Payload byte limit'}]};}}}};
}
export interface MetricsPort {
 capabilities:Capabilities;
 read(input:ReadInput):Promise<ReadResult>;
 detail?(input:DetailInput):Promise<DetailResult>;
 recentSnapshot?(input:RecentSnapshotInput):Promise<RecentSnapshotResult>;
 heatSettings?:HeatSettingsPort;
}
export function registerThreadMetricsOwner(bb:Pick<BbPluginApi,'rpc'>,port:MetricsPort):void{
 const capabilities=capabilitiesSchema.parse(port.capabilities);
 if(Boolean(capabilities.recentSnapshotV1)!==Boolean(port.recentSnapshot))throw new Error('Recent snapshot capability/handler mismatch');
 if(Boolean(capabilities.heatSettingsV1)!==Boolean(port.heatSettings))throw new Error('Heat settings capability/handler mismatch');
 if(capabilities.detail!==Boolean(port.detail))throw new Error('Detail capability/handler mismatch');
 const describe=()=>({protocol:'bb-thread-metrics' as const,versions:[1],capabilities});
 // Unknown schemas preserve the full wire object until byte admission and semantic validation.
 const contract={
  threadMetricsDescribe:{input:sdkSchema(describeInputSchema,LIMITS.inputBytes),output:sdkSchema(z.unknown())},
  threadMetricsReadV1:{input:sdkSchema(readInputSchema,LIMITS.inputBytes),output:sdkSchema(z.unknown())},
 };
 const handlers={
  threadMetricsDescribe:(raw:unknown)=>{parseBounded(describeInputSchema,raw,LIMITS.inputBytes);return describe();},
  threadMetricsReadV1:async(raw:unknown)=>{
   const input=parseBounded(readInputSchema,raw,LIMITS.inputBytes);
   if(input.series&&!capabilities.series)throw new Error('Series not supported');
   return validateReadResult(input,await port.read(input));
  },
 };
 bb.rpc.register(contract,handlers,{experimental_discoverable:true});
 if(port.heatSettings)registerHeatSettingsOwner(bb,port.heatSettings);
 if(port.recentSnapshot)bb.rpc.register({threadMetricsRecentSnapshotV1:{input:sdkSchema(recentSnapshotInputSchema,RECENT_LIMITS.inputBytes),output:sdkSchema(z.unknown())}},{threadMetricsRecentSnapshotV1:async(raw:unknown)=>{
  const input=parseBounded(recentSnapshotInputSchema,raw,RECENT_LIMITS.inputBytes);return validateRecentSnapshot(input,await port.recentSnapshot!(input));
 }},{experimental_discoverable:true});
 if(port.detail)bb.rpc.register({threadMetricsDetailV1:{input:sdkSchema(detailInputSchema,LIMITS.inputBytes),output:sdkSchema(z.unknown())}},{threadMetricsDetailV1:async(raw:unknown)=>{
  const input=parseBounded(detailInputSchema,raw,LIMITS.inputBytes);return validateDetailResult(input,await port.detail!(input));
 }},{experimental_discoverable:true});
}
export function createThreadMetricsClient(sdk:MetricsSdk,pluginId:string){
 if(!pluginId||pluginId.length>200)throw new Error('Invalid target plugin id');
 async function call(method:string,input:unknown,signal?:AbortSignal){
  return sdk.plugins.callRpc({pluginId,method,input:input as JsonValue,outputSchema:z.unknown(),...(signal?{signal}:{})});
 }
 return {
  pluginId,
  async describe(signal?:AbortSignal){const raw=await call(METHODS.describe,{},signal);return negotiateVersion(parseBounded(describeEnvelopeSchema,raw,LIMITS.describeBytes));},
  async recentSnapshot(raw:RecentSnapshotInput={},signal?:AbortSignal){const input=parseBounded(recentSnapshotInputSchema,raw,RECENT_LIMITS.inputBytes);return validateRecentSnapshot(input,await call(METHODS.recentSnapshot,input,signal));},
  async read(raw:ReadInput,signal?:AbortSignal){const input=parseBounded(readInputSchema,raw,LIMITS.inputBytes);return validateReadResult(input,await call(METHODS.read,input,signal));},
  async detail(raw:DetailInput,signal?:AbortSignal){const input=parseBounded(detailInputSchema,raw,LIMITS.inputBytes);return validateDetailResult(input,await call(METHODS.detail,input,signal));},
 };
}
export type DiscoveryRow={pluginId:string;state:'ready';version:1;capabilities:Capabilities}|{pluginId:string;state:'incompatible'}|{pluginId:string;state:'error';error:OwnerErrorKind};
export interface DiscoveryResult {rows:DiscoveryRow[];omittedCount:number;complete:boolean;listError?:OwnerErrorKind|'busy'}
export interface DiscoveryOptions {sdk:MetricsSdk;signal?:AbortSignal;maxCandidates?:number;concurrency?:number;callMs?:number;deadlineMs?:number;onRow?:(row:DiscoveryRow)=>void}
/** No polling. A stalled read keeps its lane until actual settlement, including after local timeout. */
async function discoverThreadMetricsOwners(options:DiscoveryOptions):Promise<DiscoveryResult>{
 const bounded=(v:number|undefined,max:number)=>{const n=v??max;if(!Number.isInteger(n)||n<1||n>max)throw new Error('Invalid discovery budget');return n;};
 const count=bounded(options.maxCandidates,LIMITS.candidates),concurrency=bounded(options.concurrency,LIMITS.concurrency),callMs=bounded(options.callMs,LIMITS.callMs),deadlineMs=bounded(options.deadlineMs,LIMITS.discoveryMs);
 const pass=new AbortController(),rows=new Map<string,DiscoveryRow>(),active=new Map<string,AbortController>();
 let done=false,ending=false,listedReady=false,omittedCount=0,eligibleCount=0,started=0;
 const timers=new Set<ReturnType<typeof setTimeout>>();
 let finish!:(v:DiscoveryResult)=>void;
 const result=new Promise<DiscoveryResult>(resolve=>{finish=resolve;});
 const publish=(row:DiscoveryRow)=>{if(done)return;rows.set(row.pluginId,row);try{options.onRow?.(row);}catch{/* consumer callback must not consume a transport lane */}};
 const end=(complete:boolean,listError?:OwnerErrorKind)=>{
  if(done||ending)return;ending=true;
  for(const [pluginId]of active)if(!rows.has(pluginId))publish({pluginId,state:'error',error:options.signal?.aborted?'aborted':'timeout'});
  done=true;pass.abort();for(const c of active.values())c.abort();for(const t of timers)clearTimeout(t);timers.clear();options.signal?.removeEventListener('abort',abort);
  finish({rows:[...rows.values()],omittedCount:omittedCount+Math.max(0,eligibleCount-started),complete,...(listError?{listError}:{})});
 };
 const abort=()=>end(false,'aborted');options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted){abort();return result;}
 const deadline=setTimeout(()=>end(false,listedReady?undefined:'timeout'),deadlineMs);timers.add(deadline);
 // Do not await ignored cancellation: the returned pass is deadline bounded.
 void (async()=>{
  let listed:Awaited<ReturnType<MetricsSdk['plugins']['list']>>;
  try{listed=await options.sdk.plugins.list({signal:pass.signal});}catch(e){end(false,classifyOwnerError(e));return;}
  if(done)return;
  listedReady=true;
  const unique=new Map<string,{id:string;status:string}>();
  for(const p of listed.plugins.slice(0,LIMITS.listedPlugins))if(p.id.length<=200&&(p.status==='running'||p.status==='degraded'))unique.set(p.id,p);
  const candidates=[...unique.values()].slice(0,count);omittedCount=unique.size-candidates.length+Math.max(0,listed.plugins.length-LIMITS.listedPlugins);eligibleCount=candidates.length;
  let index=0;
  async function worker(){
   while(!done&&index<candidates.length){
    const p=candidates[index++]!;started++;const control=new AbortController();active.set(p.id,control);
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;control.abort();publish({pluginId:p.id,state:'error',error:'timeout'});},callMs);timers.add(timer);
    try{
     // Await underlying SDK promise. Never race this with a timeout then reuse the lane.
     const negotiated=await createThreadMetricsClient(options.sdk,p.id).describe(control.signal);
     if(!timedOut&&!done)publish(negotiated.kind==='ready'?{pluginId:p.id,state:'ready',version:1,capabilities:negotiated.capabilities}:{pluginId:p.id,state:'incompatible'});
    }catch(e){if(!timedOut&&!done)publish({pluginId:p.id,state:'error',error:classifyOwnerError(e)});}
    finally{clearTimeout(timer);timers.delete(timer);active.delete(p.id);}
   }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,candidates.length)},()=>worker()));
  if(!done)end(omittedCount===0);
 })().catch(()=>end(false,'failed'));
 return result;
}

/** One instance per mounted demand coordinator, retained across refresh/reconnect passes.
 * A completed local deadline does not free underlying reads. Busy passes do no I/O.
 * No queue, retries, timers or global singleton are created by the coordinator itself.
 */
export function createThreadMetricsDiscovery(sdk:MetricsSdk){
 let running=false,outstanding=0;
 async function track<T>(fn:()=>Promise<T>):Promise<T>{outstanding++;try{return await fn();}finally{outstanding--;}}
 const admitted:MetricsSdk={plugins:{
  list:args=>track(()=>sdk.plugins.list(args)),
  callRpc:args=>track(()=>sdk.plugins.callRpc(args)),
 }};
 return {
  get outstandingReads(){return outstanding;},
  async discover(options:Omit<DiscoveryOptions,'sdk'>={}):Promise<DiscoveryResult>{
   if(running||outstanding>0)return {rows:[],omittedCount:0,complete:false,listError:'busy'};
   running=true;try{return await discoverThreadMetricsOwners({...options,sdk:admitted});}finally{running=false;}
  },
 };
}

export {createRecentSnapshotSession,RecentSnapshotSessionError,RecentSnapshotNotStarted} from './recent-session.js';
export type {RecentSnapshotSource,RecentSnapshotObservation,RecentSnapshotSession,RecentSessionClock,RecentSessionFailure} from './recent-session.js';
