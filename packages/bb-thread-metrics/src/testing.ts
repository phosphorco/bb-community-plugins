import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { METHODS, LIMITS, readInputSchema, detailInputSchema, describeEnvelopeSchema, parseBounded, negotiateVersion, validateReadResult, validateDetailResult } from './index.js';
import type { ReadInput, DetailInput } from './index.js';
export interface ConformanceOptions {
 pluginId:string;
 /** The adopter's real factory/registration, never a second implementation. */
 register(bb:BbPluginApi):void|Promise<void>;
 readCases:readonly ReadInput[];
 detailCases?:readonly DetailInput[];
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
  let detail=false;
  await check('describe-negotiation',async()=>{const n=negotiateVersion(parseBounded(describeEnvelopeSchema,await call(METHODS.describe,{}),LIMITS.describeBytes));if(n.kind!=='ready')throw new Error('No compatible v1');detail=n.capabilities.detail;});
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
  if(detail){if(!options.detailCases?.length)checks.push({name:'detail-cases-required',passed:false,error:'Advertised detail needs real cases'});for(let i=0;i<(options.detailCases?.length??0);i++)await check(`detail-${i}`,async()=>{const input=parseBounded(detailInputSchema,options.detailCases![i],LIMITS.inputBytes);validateDetailResult(input,await call(METHODS.detail,input));});await check('strict-detail-input',()=>rejectsInput(METHODS.detail,{...options.detailCases?.[0],unexpected:true}));}
 }finally{await host.harness.lifecycle.dispose();}
 return {passed:checks.every(c=>c.passed),checks,proof:'source-conformance'};
}
