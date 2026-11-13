import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/protocol.js';
import {createJevClient,registerJevOwner} from '../dist/bb.js';
import {runJevConformance} from '../dist/testing.js';
const input=()=>({version:1,operation:{namespace:'mr-admission',operationId:'attempt-1'},work:{consumerPluginId:'message-rules',kind:'message-rules.admission',attribution:{assessmentId:'native-1',partition:'p1'}},wire:{model:'jev-1.0.0',state:'hello',questions:{x:{type:'score',instructions:'x',criteria:['a','b','c','d']}}},deadlineAt:Date.now()+2000,maxResponseBytes:1024});
const source={ownerPluginId:'jev-topics',kind:'plugin-setting',field:'typesafeApiKey'};
const description={protocol:p.PROTOCOL,versions:[1],ownerPluginId:'jev-topics',configured:true,source,workKinds:['message-rules.admission'],limits:{requestBytes:p.LIMITS.requestBytes,responseBytes:p.LIMITS.responseBytes,deadlineMs:60000,concurrency:4}};
async function result(request){return {version:1,operation:request.operation,requestFingerprint:await p.fingerprint(request),work:request.work,state:'succeeded',invoked:true,source,createdAt:1,settledAt:2,latencyMs:1,httpStatus:200,response:{model:'jev-1.0.0',answers:{x:{score:3}},usage:{input_tokens:2,output_tokens:1}},usage:{status:'reported',inputTokens:2,outputTokens:1,cost:null},error:null};}
function sdk(call,list=async()=>({plugins:[{id:'jev-topics',status:'running'}]})){return {plugins:{callRpc:call,list}};}
test('strict request and finite plain JSON boundaries',()=>{
  const i=input();assert.equal(p.SubmitSchema.parse(i).work.kind,i.work.kind);
  for(const v of [{...i,apiKey:'bad'},{...i,wire:undefined},{...i,wire:NaN},{...i,wire:new Date()}, {...i,wire:{a:undefined}}])assert.throws(()=>p.decode(p.SubmitSchema,v));
  const cyclic={};cyclic.x=cyclic;assert.throws(()=>p.canonical(cyclic));assert.throws(()=>p.canonical({big:'💡'.repeat(1000)},100));
  assert.throws(()=>p.canonical(Object.defineProperty({},'secret',{get(){throw Error('must not invoke');},enumerable:true})));
});
test('canonical fingerprint anchors complete deadline, work, wire and bounds',async()=>{
  const a=input(),h=await p.fingerprint(a);assert.equal(h,await p.fingerprint({...a,wire:{...a.wire}}));
  for(const changed of [{...a,deadlineAt:a.deadlineAt+1},{...a,wire:{...a.wire,state:'changed'}},{...a,maxResponseBytes:2048},{...a,work:{...a.work,attribution:{assessmentId:'other'}}}])assert.notEqual(await p.fingerprint(changed),h);
});
test('additive outputs retained, exact opaque attribution and request identity anchored',async()=>{
  const i=input(),r=await result(i);const additive={...r,extra:1,operation:{...r.operation,extra:2},work:{...r.work,extra:3},source:{...source,extra:4}};
  assert.equal((await p.decodeRecord(i,additive)).extra,1);
  for(const bad of [{...r,operation:{...r.operation,operationId:'wrong'}},{...r,work:{...r.work,attribution:{wrong:true}}},{...r,requestFingerprint:'sha256:'+'0'.repeat(64)}])await assert.rejects(p.decodeRecord(i,bad));
});
test('state truth does not confuse not-issued with uncertain effect',async()=>{
  const r=await result(input());assert.throws(()=>p.RecordSchema.parse({...r,state:'not-invoked'}));assert.throws(()=>p.RecordSchema.parse({...r,invoked:false}));
  assert.throws(()=>p.RecordSchema.parse({...r,state:'effect-possible'}));assert.throws(()=>p.RecordSchema.parse({...r,response:null}));
});
test('explicit listed owner and tolerant describe envelope',async()=>{
  let calls=0;const client=createJevClient(sdk(async args=>{calls++;assert.equal(args.pluginId,'jev-topics');return {...description,future:1};}));
  assert.equal((await client.describe()).configured,true);assert.equal(calls,1);
  const absent=createJevClient(sdk(async()=>{throw Error('must not call')},async()=>({plugins:[]})));
  await assert.rejects(absent.describe(),/missing, disabled/);
  const incompatible=createJevClient(sdk(async()=>({...description,versions:[2]})));await assert.rejects(incompatible.describe(),/incompatible/);
});
test('lost submit acknowledgement performs exactly one lookup and no write replay',async()=>{
  const i=input(),r=await result(i),calls=[];
  const client=createJevClient(sdk(async args=>{calls.push(args.method);if(args.method===p.METHODS.submit)throw Error('lost ack');return r;}));
  assert.deepEqual(await client.submit(i),r);assert.deepEqual(calls,[p.METHODS.submit,p.METHODS.lookup]);
});
test('missing outcome remains unknown; wrong retained basis cannot become success',async()=>{
  for(const retained of [null,await result({...input(),operation:{namespace:'mr-admission',operationId:'wrong'}})]){
    let submits=0,reads=0;const c=createJevClient(sdk(async args=>{if(args.method===p.METHODS.submit){submits++;throw Error('lost');}reads++;return retained;}));
    await assert.rejects(c.submit(input()),e=>e.outcome==='unknown');assert.equal(submits,1);assert.equal(reads,1);
  }
});
test('aborted before invocation and expired deadline never write',async()=>{
  let n=0;const c=createJevClient(sdk(async()=>{n++;}));const ctrl=new AbortController();ctrl.abort();
  await assert.rejects(c.submit(input(),ctrl.signal),e=>e.outcome==='not-invoked');await assert.rejects(c.submit({...input(),deadlineAt:1}),e=>e.outcome==='not-invoked');assert.equal(n,0);
});
test('registered owner validates actual handlers and immutable replay through kit',async()=>{
  let contract,handlers;registerJevOwner({rpc:{register(c,h){contract=c;handlers=h;}}},{describe:()=>description,submit:async request=>{const h=await p.fingerprint(request);if(saved&&saved.requestFingerprint!==h)throw Error('conflict');return saved??=(await result(request));},lookup:()=>saved});let saved;
  for(const name of Object.values(p.METHODS))assert.ok(contract[name]);
  const cases=await runJevConformance({submit:i=>handlers[p.METHODS.submit](i),lookup:operation=>handlers[p.METHODS.lookup]({version:1,operation})},input());assert.equal(cases.cases.length,4);
});
test('malformed owner result is refused by registration',async()=>{
  let handlers;registerJevOwner({rpc:{register(_c,h){handlers=h;}}},{describe:()=>description,submit:async i=>({...await result(i),operation:{namespace:'other',operationId:'wrong'}}),lookup:()=>null});
  await assert.rejects(handlers[p.METHODS.submit](input()),/mismatch/);
});
test('saturated physical writes retain a separate bounded reconciliation lane',async()=>{
  let writes=0,reads=0;const i=input();const aborts=[];
  const client=createJevClient(sdk(args=>{if(args.method===p.METHODS.submit){writes++;return new Promise(()=>{});}reads++;return Promise.resolve(null);}));
  const pending=Array.from({length:4},(_,n)=>{const ctrl=new AbortController();aborts.push(ctrl);return client.submit({...i,operation:{...i.operation,operationId:'saturated-'+n}},ctrl.signal).catch(e=>e);});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,4);for(const ctrl of aborts)ctrl.abort();
  const failures=await Promise.all(pending);assert.ok(failures.every(e=>e.outcome==='unknown'));assert.equal(reads,4);
});
test('kit anchors immutable request while factual transport observations advance',async()=>{
  const i=input(),done=await result(i),active={...done,state:'effect-possible',settledAt:null,latencyMs:null,httpStatus:null,response:null,usage:{status:'missing',cost:null}};
  let n=0;const cases=await runJevConformance({submit:async request=>{if(request.work.kind!==i.work.kind)throw Error('conflict');return ++n===1?active:done;},lookup:async()=>done},i);
  assert.equal(cases.cases.length,4);
});
