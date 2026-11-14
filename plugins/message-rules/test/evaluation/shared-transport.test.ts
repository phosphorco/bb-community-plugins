import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {METHODS,LIMITS,PROTOCOL,fingerprint,type Submit,type OperationRecord} from '@phosphorco/bb-jev';
import {createSelectedJevTransport} from '../../evaluation/shared-transport.ts';
import {defaultConnection} from '../../contracts/model.ts';
import {TransportError,createHttpTransport} from '../../evaluation/transport.ts';
import type {TransportInvocation,Wire} from '../../evaluation/evaluator.ts';
const source={ownerPluginId:'jev-topics',kind:'plugin-setting' as const,field:'typesafeApiKey'};
const description={protocol:PROTOCOL,versions:[1],ownerPluginId:'jev-topics',configured:true,source,workKinds:['message-rules.admission','message-rules.suite'],limits:{requestBytes:LIMITS.requestBytes,responseBytes:LIMITS.responseBytes,deadlineMs:60000,concurrency:4}};
const wire:Wire={model:'jev-1.14.0',state:'fixture only',questions:{q:{type:'score',instructions:'fixture',criteria:['0','1','2','3']}}};
const raw={model:wire.model,answers:{q:{score:3}},usage:{input_tokens:20,output_tokens:3}};
function invocation(observe:(v:unknown)=>void=()=>{}):TransportInvocation{return {operation:{namespace:'message-rules.admission',operationId:'paid-attempt-uuid'},deadlineAt:Date.now()+1000,kind:'message-rules.admission',attribution:{assessmentId:'native-assessment',partitionHash:'frozen-partition',attemptId:'paid-attempt-uuid'},observe};}
async function record(input:Submit):Promise<OperationRecord>{return {version:1,operation:input.operation,requestFingerprint:await fingerprint(input),work:input.work,state:'succeeded',invoked:true,source,createdAt:1,settledAt:2,latencyMs:1,httpStatus:200,response:raw,usage:{status:'reported',inputTokens:20,outputTokens:3,cost:null},error:null};}
test('explicit shared owner receives retained paid-attempt identity and returns untouched semantic response with accounting',async()=>{
 let sent:Submit|undefined,receipt:unknown;const host=createFakePluginHost({pluginId:'message-rules',sdk:{plugins:{list:async()=>({plugins:[{id:'jev-topics',status:'running'}]}),callRpc:async args=>{assert.equal(args.pluginId,'jev-topics');if(args.method===METHODS.describe)return description;sent=args.input as Submit;return record(sent);}}}});
 try{const transport=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'shared',credential:'unused-override'}),async()=>{throw Error('Shared mode must not use dedicated HTTP');});
  assert.deepEqual(await transport(wire,new AbortController().signal,undefined,invocation(v=>{receipt=v;})),raw);assert.deepEqual(sent?.operation,invocation().operation);assert.deepEqual(sent?.work.attribution,invocation().attribution);assert.equal(sent?.work.consumerPluginId,'message-rules');assert.equal((receipt as OperationRecord).source.field,'typesafeApiKey');assert.ok(!JSON.stringify(sent).includes('unused-override'));
 }finally{await host.harness.lifecycle.dispose();}
});
test('dedicated override uses only explicitly selected MR key and never probes shared owner',async()=>{
 let calls=0;const host=createFakePluginHost({pluginId:'message-rules'});
 try{const t=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'dedicated',credential:'dedicated-synthetic'}),async(_url,init)=>{calls++;assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer dedicated-synthetic');return new Response(JSON.stringify(raw));});assert.deepEqual(await t(wire,new AbortController().signal),raw);assert.equal(calls,1);assert.equal(host.harness.sdk.callsTo('plugins.list').length,0);}finally{await host.harness.lifecycle.dispose();}
});
test('missing owner or owner key refuses before JEV; no implicit dedicated fallback',async()=>{
 for(const missing of [true,false]){
  const host=createFakePluginHost({pluginId:'message-rules',sdk:{plugins:{list:async()=>({plugins:missing?[]:[{id:'jev-topics',status:'running'}]}),callRpc:async()=>({...description,configured:false})}}});
  try{let own=0;const t=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'shared',credential:'not-selected'}),async()=>{own++;return new Response(JSON.stringify(raw));});await assert.rejects(t(wire,new AbortController().signal,undefined,invocation()),e=>e instanceof TransportError&&!e.invoked);assert.equal(own,0);}finally{await host.harness.lifecycle.dispose();}
 }
});
test('lost shared acknowledgement reconciles exact operation without HTTP/write retry',async()=>{
 let saved:OperationRecord|null=null,submits=0,lookups=0;const host=createFakePluginHost({pluginId:'message-rules',sdk:{plugins:{list:async()=>({plugins:[{id:'jev-topics',status:'running'}]}),callRpc:async args=>{if(args.method===METHODS.describe)return description;if(args.method===METHODS.submit){submits++;saved=await record(args.input as Submit);throw Error('lost acknowledgement');}lookups++;return saved;}}}});
 try{const t=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'shared',credential:null}));assert.deepEqual(await t(wire,new AbortController().signal,undefined,invocation()),raw);assert.equal(submits,1);assert.equal(lookups,1);}finally{await host.harness.lifecycle.dispose();}
});
test('uncertain invocation retains structured owner evidence, usage and no second submit',async()=>{
 let submits=0;const host=createFakePluginHost({pluginId:'message-rules',sdk:{plugins:{list:async()=>({plugins:[{id:'jev-topics',status:'running'}]}),callRpc:async args=>{if(args.method===METHODS.describe)return description;submits++;return {...await record(args.input as Submit),state:'uncertain',response:null,error:{code:'deadline',message:'deadline; possible spend'}};}}}});
 try{const t=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'shared',credential:null}));await assert.rejects(t(wire,new AbortController().signal,undefined,invocation()),e=>e instanceof TransportError&&e.invoked&&JSON.stringify(e.observation).includes('possible spend'));assert.equal(submits,1);}finally{await host.harness.lifecycle.dispose();}
});
test('shared transport refuses missing existing attempt and wire budget before any owner RPC',async()=>{
 const host=createFakePluginHost({pluginId:'message-rules'});try{const t=createSelectedJevTransport(host.bb.sdk,{...defaultConnection,maxWireBytes:10},async()=>({source:'shared',credential:null}));await assert.rejects(t(wire,new AbortController().signal),e=>e instanceof TransportError&&!e.invoked);await assert.rejects(t(wire,new AbortController().signal,undefined,invocation()),e=>e instanceof TransportError&&!e.invoked);assert.equal(host.harness.sdk.callsTo('plugins.list').length,0);}finally{await host.harness.lifecycle.dispose();}
});
test('owner discovery consumes the existing absolute attempt deadline and cannot extend paid work',async()=>{
 let submits=0;const host=createFakePluginHost({pluginId:'message-rules',sdk:{plugins:{list:async()=>{await new Promise(resolve=>setTimeout(resolve,30));return {plugins:[{id:'jev-topics',status:'running'}]};},callRpc:async args=>{if(args.method===METHODS.describe)return description;submits++;return record(args.input as Submit);}}}});
 try{const transport=createSelectedJevTransport(host.bb.sdk,defaultConnection,async()=>({source:'shared',credential:null}));await assert.rejects(transport(wire,new AbortController().signal,undefined,{...invocation(),deadlineAt:Date.now()+5}),e=>e instanceof TransportError&&!e.invoked);assert.equal(submits,0);}finally{await host.harness.lifecycle.dispose();}
});

test('dedicated override masks escaped credential values while retaining HTTP diagnosis',async()=>{
 const key='dedicated-synthetic';const encoded=JSON.stringify({error:key,requestId:'retained'}).replace(key,'\\u0064'+key.slice(1));assert.equal(JSON.parse(encoded).error,key);
 const transport=createHttpTransport(defaultConnection,async()=>key,async()=>new Response(encoded,{status:401}));
 await assert.rejects(transport(wire,new AbortController().signal),error=>error instanceof TransportError&&error.invoked&&!JSON.stringify(error.observation).includes(key)&&JSON.stringify(error.observation).includes('retained'));
});
