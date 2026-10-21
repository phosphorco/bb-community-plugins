import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostAdapter,inspectForkExtension,externalContributionV1Codec} from '../host-runtime.js';
import {createAdapterHarness} from '../testing-runtime.js';
const codec={decode:value=>({ok:true,value}),encode:value=>value};
const presentation={displayName:'Cole',handle:'cole',avatarUrl:null};
const contribution={version:1,author:{subject:'T/U',presentation},personAttribution:{identity:{kind:'person',key:'person:cole',issuer:'tailnet',subject:'cole'},presentation,evidence:'integration-asserted'}};
const input={operationId:'operation-1',threadId:'thread-1',mode:'start',input:['hello']};
const receipt=(value,operationId='operation-1')=>({status:'submitted',receipt:{operationId,evidence:'host-accepted',acceptedAt:'2026-10-21T00:00:00Z',retainedUntil:'2026-11-21T00:00:00Z',provenance:'structured',deduplication:'guaranteed',native:{deliveryId:null,queuedMessageId:null,turnId:null},references:[],...(value?{externalContribution:value}:{})}});
function fixture(capability) {
 const harness=createAdapterHarness({mode:'single-user',inputCodec:codec});let legacy=0;
 const protocol={version:1,instanceId:'fixture-instance',bindInvocation:()=>({registration:{generation:'g',status:'active',dispose(){}},handler(){}}),
 session:context=>harness.upstream.session(context),selfProfile:context=>harness.upstream.selfProfile(context),openRequest:async()=>({ok:false,error:{code:'unsupported',message:'unused',retry:'never'}}),
 accept:async()=>{legacy++;return receipt();},lookup:async()=>({ok:true,value:{status:'unknown',reason:'unsupported'}}),provenance:async()=>({ok:true,value:{status:'unknown',correlation:null,reason:'unused'}}),
 historyContributions:async()=>({ok:true,value:{status:'unavailable',reason:'unsupported'}}),historyAttempts:async()=>({ok:true,value:{status:'unavailable',reason:'unsupported'}}),
 directorySources:()=>[],participants:async()=>({ok:false,error:{code:'unsupported',message:'unused',retry:'never'}}),forwardRpc:async()=>null,registerProvider:async()=>({ok:false,error:{code:'unsupported',message:'unused',retry:'never'}}),subscribe:()=>()=>{},
 ...(capability===undefined?{}:{externalContributions:capability})};
 const host=createHostAdapter({upstream:harness.upstream,extension:inspectForkExtension(protocol)});
 return {host,harness,protocol,legacy:()=>legacy};
}
function capability(acceptV1=async ({contribution})=>receipt(contribution),lookupV1=async()=>({ok:true,value:{status:'absent-final',retry:'same-operation-only'}})) {
 return {versions:[1],personKinds:['person'],history:'accepted-and-queued',rollback:'requires-capable-host',acceptV1,lookupV1};
}

test('new package on old enhanced host keeps legacy external sends and refuses V1 without dispatch',async()=>{
 const f=fixture();assert.deepEqual(f.host.externalContributionCapabilities(),{ok:true,value:null});
 assert.equal((await f.host.sendExternalContribution(contribution,input)).error.code,'unsupported');assert.equal(f.legacy(),0);
 assert.equal((await f.host.sendExternal(contribution.author,input)).status,'submitted');assert.equal(f.legacy(),1);
 assert.deepEqual(await f.host.lookupExternalContribution('operation-1'),{ok:true,value:{status:'unknown',reason:'unsupported'}});
 f.host.dispose();
});

test('plain upstream remains external-only and malformed enhanced extensions never select it',async()=>{
 const harness=createAdapterHarness({mode:'single-user',inputCodec:codec});
 for(const raw of [undefined,{version:1}]) {
  const host=createHostAdapter({upstream:harness.upstream,extension:inspectForkExtension(raw)});
  assert.equal((await host.sendExternalContribution(contribution,input)).status,'rejected');
  assert.equal(host.externalContributionCapabilities().ok,raw===undefined);host.dispose();
 }
});

test('malformed or unknown feature versions produce no dispatch',async()=>{
 let calls=0;
 for(const cap of [{versions:1},{...capability(),acceptV1:undefined},{...capability(),history:'parser-only'},{...capability(),versions:[2]}]) {
  const f=fixture({...cap,acceptV1:cap.acceptV1===undefined?undefined:async()=>{calls++;return receipt(contribution);}});
  assert.equal((await f.host.sendExternalContribution(contribution,input)).status,'rejected');f.host.dispose();
 }
 assert.equal(calls,0);
});

test('strict V1 inputs reject default users, false verification, null snapshots and unchecked fields',async()=>{
 let calls=0;const f=fixture(capability(async()=>{calls++;return receipt(contribution);}));
 for(const value of [{...contribution,extra:true},{...contribution,personAttribution:null},{...contribution,personAttribution:{...contribution.personAttribution,evidence:'provider-verified'}},{...contribution,personAttribution:{...contribution.personAttribution,identity:{kind:'default-user',key:'local:i',instanceId:'i'}}}]) {
  assert.equal(externalContributionV1Codec.decode(value).ok,false);
  assert.equal((await f.host.sendExternalContribution(value,input)).status,'rejected');
 }
 assert.equal(calls,0);f.host.dispose();
});

test('snapshots freeze before dispatch and receipt/lookup confirms the persisted attribution',async()=>{
 let release,entered,stored;const started=new Promise(resolve=>entered=resolve);
 const f=fixture(capability(async request=>{stored=structuredClone(request);entered();await new Promise(resolve=>release=resolve);return receipt(stored.contribution,stored.input.operationId);},async()=>({ok:true,value:{status:'final',outcome:receipt(stored.contribution,stored.input.operationId)}})));
 const supplied=structuredClone(contribution),sendInput=structuredClone(input);
 const sending=f.host.sendExternalContribution(supplied,sendInput);await started;
 supplied.personAttribution.presentation.displayName='Changed';supplied.author.subject='OTHER';sendInput.operationId='operation-2';
 release();const accepted=await sending;assert.equal(accepted.status,'submitted');
 assert.deepEqual(accepted.receipt.externalContribution,contribution);assert.equal(stored.input.operationId,'operation-1');
 const lookup=await f.host.lookupExternalContribution('operation-1');assert.deepEqual(lookup.value.outcome,accepted);f.host.dispose();
});

test('malformed or changed receipts remain uncertainty after dispatch, never a new fallback send',async()=>{
 for(const output of [receipt(),receipt({...contribution,personAttribution:undefined}),{status:'submitted',receipt:{}}]) {
  let calls=0;const f=fixture(capability(async()=>{calls++;return output;}));
  const result=await f.host.sendExternalContribution(contribution,input);assert.equal(result.status,'indeterminate');assert.equal(calls,1);assert.equal(f.legacy(),0);f.host.dispose();
 }
});

test('V1 receipts tolerate additive output metadata; unsupported lookup is not absence',async()=>{
 const richer={...contribution,future:true,author:{...contribution.author,future:true},personAttribution:{...contribution.personAttribution,presentation:{...presentation,future:true}}};
 const f=fixture(capability(async()=>receipt(richer),async()=>({ok:true,value:{status:'unknown',reason:'unsupported'}})));
 const accepted=await f.host.sendExternalContribution(contribution,input);assert.equal(accepted.status,'submitted');
 assert.deepEqual(accepted.receipt.externalContribution,contribution);
 assert.deepEqual(await f.host.lookupExternalContribution('operation-1'),{ok:true,value:{status:'unknown',reason:'unsupported'}});f.host.dispose();
});

 test('lookup rejects a receipt for another operation',async()=>{
 const f=fixture(capability(undefined,async()=>({ok:true,value:{status:'final',outcome:receipt(contribution,'other-operation')}})));
 const result=await f.host.lookupExternalContribution('operation-1');
 assert.equal(result.ok,false);assert.equal(result.error.code,'incompatible');f.host.dispose();
 });

 test('canonical person identifiers share the native 512-character boundary',()=>{
 for(const field of ['issuer','subject']) {
  const value=structuredClone(contribution);value.personAttribution.identity[field]='a'.repeat(512);
  assert.equal(externalContributionV1Codec.decode(value).ok,true);
  value.personAttribution.identity[field]+='a';assert.equal(externalContributionV1Codec.decode(value).ok,false);
 }
 });
