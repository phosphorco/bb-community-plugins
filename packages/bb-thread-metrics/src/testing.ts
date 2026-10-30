import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { RECENT_LIMITS,recentSnapshotInputSchema,validateRecentSnapshot,METHODS, LIMITS, readInputSchema, detailInputSchema, describeEnvelopeSchema, parseBounded, negotiateVersion, validateReadResult, validateDetailResult } from './index.js';
import type { RecentSnapshotInput,ReadInput, DetailInput } from './index.js';
import { createHeatSettingsClient } from './bb.js';
import { HEAT_SETTINGS_METHODS } from './index.js';
import type { HeatSettingsSaveInput,ScoringConfigV3 } from './index.js';
/** Drives the adopter's actual registration/storage. Uses a caller-supplied
 * valid candidate; never touches a runtime owner or discovers suppliers. */
export async function runHeatSettingsConformance(options:{pluginId:string;register(bb:BbPluginApi):void|Promise<void>;candidate:ScoringConfigV3}):Promise<ConformanceReport> {
 const host=createFakePluginHost({pluginId:options.pluginId}),checks:ConformanceReport['checks']=[];
 const client=createHeatSettingsClient({plugins:{list:async()=>({plugins:[]}),callRpc:async<T>(args:{method:string;input?:unknown})=>await host.harness.behavior.callRpc(args.method,args.input) as T}},options.pluginId);
 const check=async(name:string,fn:()=>Promise<void>)=>{try{await fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:String(e)});}};
 try {
  await options.register(host.bb);
  const initial=await client.read({protocolVersion:1});
  const input:HeatSettingsSaveInput={protocolVersion:1,operationKey:'kit:save',baseConfigVersion:initial.current.version,candidate:options.candidate};
  let saved:Awaited<ReturnType<typeof client.save>>;
  await check('heat-CAS-save',async()=>{saved=await client.save(input);if(saved.kind!=='saved'||saved.record.version===initial.current.version)throw new Error('CAS did not publish fresh config version');});
  await check('heat-root-domain-saved',async()=>{if(saved!.record.value.schemaVersion!==3||saved!.record.value.domain.kind!=='root-family')throw new Error('Root-family domain missing from saved record');});
  await check('heat-required-domain',async()=>{const {domain,...missing}=options.candidate;let rejected=false;try{await host.harness.behavior.callRpc(HEAT_SETTINGS_METHODS.save,{...input,operationKey:'kit:no-domain',candidate:missing});}catch{rejected=true;}if(!rejected)throw new Error('Domain-less root candidate accepted');});
  await check('heat-idempotency',async()=>{const repeated=await client.save(input);if(JSON.stringify(repeated)!==JSON.stringify(saved))throw new Error('Idempotency changed result');});
  await check('heat-stale-base',async()=>{const conflict=await client.save({...input,operationKey:'kit:conflict'});if(conflict.kind!=='conflict'||conflict.record.version!==saved!.record.version)throw new Error('Stale base wrote');});
  await check('heat-reconciliation',async()=>{const read=await client.read({protocolVersion:1,operationKey:input.operationKey});if(read.outcome?.kind!=='saved'||read.outcome.record.version!==saved!.record.version)throw new Error('Missing operation receipt');});
  await check('heat-strict-nested-input',async()=>{let rejected=false;try{await host.harness.behavior.callRpc(HEAT_SETTINGS_METHODS.save,{...input,operationKey:'kit:invalid',candidate:{...input.candidate,unexpected:true}});}catch{rejected=true;}if(!rejected)throw new Error('Nested unknown field accepted');});
 } finally {await host.harness.lifecycle.dispose();}
 return {passed:checks.every(c=>c.passed),checks,proof:'source-conformance'};
}
export interface ConformanceOptions {
 pluginId:string;
 /** The adopter's real factory/registration, never a second implementation. */
 register(bb:BbPluginApi):void|Promise<void>;
 readCases:readonly ReadInput[];
 detailCases?:readonly DetailInput[];
 recentCases?:readonly RecentSnapshotInput[];
 deadlineMs?:number;
}
export interface ConformanceReport {passed:boolean;checks:{name:string;passed:boolean;error?:string}[];proof:'source-conformance'}
export async function runSupplierConformance(options:ConformanceOptions):Promise<ConformanceReport>{
 if(!options.readCases.length)throw new Error('At least one real read case required');
 const host=createFakePluginHost({pluginId:options.pluginId}),checks:ConformanceReport['checks']=[];
 const deadline=options.deadlineMs??LIMITS.callMs;
 if(!Number.isInteger(deadline)||deadline<1||deadline>LIMITS.discoveryMs)throw new Error('Invalid conformance deadline');
 const call=(method:string,input:unknown)=>host.harness.behavior.callRpc(method,input);
 async function check(name:string,fn:()=>Promise<void>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([fn(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Conformance deadline')),deadline);})]);checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e instanceof Error?e.message:String(e)});}finally{clearTimeout(timer);}}
 function validationError(e:unknown){const v=e as {name?:string;issues?:unknown;code?:string;body?:{code?:string}};return (v.name==='ZodError'&&Array.isArray(v.issues))||v.code==='invalid_input'||v.body?.code==='invalid_input';}
 async function rejectsInput(method:string,input:unknown){try{await call(method,input);}catch(e){if(validationError(e))return;throw new Error('Expected structured invalid_input or ZodError');}throw new Error('Invalid input accepted');}
 try{
  await options.register(host.bb);
  let detail=false,recent=false;
  await check('describe-negotiation',async()=>{const n=negotiateVersion(parseBounded(describeEnvelopeSchema,await call(METHODS.describe,{}),LIMITS.describeBytes));if(n.kind!=='ready')throw new Error('No compatible v1');detail=n.capabilities.detail;recent=Boolean(n.capabilities.recentSnapshotV1);});
  await check('strict-describe-input',()=>rejectsInput(METHODS.describe,{unexpected:true}));
  for(let i=0;i<options.readCases.length;i++)await check(`read-${i}`,async()=>{const input=parseBounded(readInputSchema,options.readCases[i],LIMITS.inputBytes);validateReadResult(input,await call(METHODS.read,input));});
  await check('strict-read-input',()=>rejectsInput(METHODS.read,{...options.readCases[0],unexpected:true}));
  await check('oversized-id-count',()=>rejectsInput(METHODS.read,{scope:'family',threadIds:Array.from({length:201},(_,i)=>`thr_${i}`)}));
  await check('oversized-input-bytes',async()=>{
   // Count/field-valid input that only byte admission rejects (133051 UTF-8 bytes).
   const threadIds=Array.from({length:200},(_,i)=>`thr_${i}_`.padEnd(200,'x'));
   const oversized={scope:'family' as const,threadIds,knownRevisions:Object.fromEntries(threadIds.map(id=>[id,'r'.repeat(256)]))};
   readInputSchema.parse(oversized);
   if(new TextEncoder().encode(JSON.stringify(oversized)).byteLength<=LIMITS.inputBytes)throw new Error('Byte fixture is not oversized');
   await rejectsInput(METHODS.read,oversized);
  });
  if(recent){if(!options.recentCases?.length)checks.push({name:'recent-cases-required',passed:false,error:'Advertised recent snapshot needs real cases'});for(let i=0;i<(options.recentCases?.length??0);i++)await check(`recent-${i}`,async()=>{const input=parseBounded(recentSnapshotInputSchema,options.recentCases![i],RECENT_LIMITS.inputBytes);validateRecentSnapshot(input,await call(METHODS.recentSnapshot,input));});await check('strict-recent-input',()=>rejectsInput(METHODS.recentSnapshot,{unexpected:true}));}
  if(detail){if(!options.detailCases?.length)checks.push({name:'detail-cases-required',passed:false,error:'Advertised detail needs real cases'});for(let i=0;i<(options.detailCases?.length??0);i++)await check(`detail-${i}`,async()=>{const input=parseBounded(detailInputSchema,options.detailCases![i],LIMITS.inputBytes);validateDetailResult(input,await call(METHODS.detail,input));});await check('strict-detail-input',()=>rejectsInput(METHODS.detail,{...options.detailCases?.[0],unexpected:true}));}
 }finally{await host.harness.lifecycle.dispose();}
 return {passed:checks.every(c=>c.passed),checks,proof:'source-conformance'};
}
