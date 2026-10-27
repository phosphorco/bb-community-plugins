import { test,expect } from 'bun:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createThreadMetricsClient,registerThreadMetricsOwner,createThreadMetricsDiscovery } from '../dist/bb.js';
import { runSupplierConformance } from '../dist/testing.js';
import { METHODS,LIMITS } from '../dist/index.js';
import { row,detail,detailInput } from './core.test.mjs';
const caps={summary:true,series:true,detail:true};
const description={protocol:'bb-thread-metrics',versions:[1],capabilities:caps};
const request={threadIds:['thr_a'],scope:'family'};
const port={capabilities:caps,read:async()=>({version:1,rows:[row()]}),detail:async()=>detail()};
const listed=(n)=>({plugins:Array.from({length:n},(_,i)=>({id:`p${i}`,status:'running'}))});
const discoverThreadMetricsOwners=({sdk,...options})=>createThreadMetricsDiscovery(sdk).discover(options);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function sdkFor(fn,n=1){return {plugins:{list:async()=>listed(n),callRpc:fn}};}
test('owner-bound client drives real fake-host registrations and preserves strict boundaries',async()=>{
 const host=createFakePluginHost({pluginId:'supplier'});registerThreadMetricsOwner(host.bb,port);
 const calls=[];
 const sdk=sdkFor(async args=>{calls.push(args);expect(args.pluginId).toBe('supplier');return host.harness.behavior.callRpc(args.method,args.input);});
 try{
  const client=createThreadMetricsClient(sdk,'supplier');expect((await client.describe()).kind).toBe('ready');expect((await client.read(request)).rows).toHaveLength(1);expect((await client.detail(detailInput)).rows).toHaveLength(1);
  expect(calls.map(c=>c.method)).toEqual([METHODS.describe,METHODS.read,METHODS.detail]);
  await expect(host.harness.behavior.callRpc(METHODS.read,{...request,unexpected:1})).rejects.toThrow();
 }finally{await host.harness.lifecycle.dispose();}
});
test('conformance kit runs real factory and rejects invalid supplier',async()=>{
 const report=await runSupplierConformance({pluginId:'supplier',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[request],detailCases:[detailInput]});
 expect(report.checks.filter(c=>!c.passed)).toEqual([]);expect(report.passed).toBe(true);expect(report.proof).toBe('source-conformance');
 const bad=await runSupplierConformance({pluginId:'bad',register:bb=>registerThreadMetricsOwner(bb,{...port,read:async()=>({version:1,rows:[row('not-requested')]})}),readCases:[request],detailCases:[detailInput]});
 expect(bad.passed).toBe(false);expect(bad.checks.find(c=>c.name==='read-0').passed).toBe(false);
});
test('discovery zero, failure-independent, malformed, incompatible and duplicate targets',async()=>{
 expect(await discoverThreadMetricsOwners({sdk:sdkFor(async()=>description,0)})).toEqual({rows:[],omittedCount:0,complete:true});
 const sdk={plugins:{list:async()=>({plugins:[...listed(4).plugins,{id:'p0',status:'degraded'}]}),callRpc:async({pluginId})=>{
  if(pluginId==='p0')return description;if(pluginId==='p1')throw {status:404};if(pluginId==='p2')return {protocol:'bb-thread-metrics',versions:[2]};return {garbage:true};
 }}};
 const result=await discoverThreadMetricsOwners({sdk});expect(result.rows).toHaveLength(4);expect(result.rows.find(r=>r.pluginId==='p0').state).toBe('ready');expect(result.rows.find(r=>r.pluginId==='p1').error).toBe('absent');expect(result.rows.find(r=>r.pluginId==='p2').state).toBe('incompatible');expect(result.rows.find(r=>r.pluginId==='p3').error).toBe('malformed');
});
test('ignored-abort reads occupy actual lanes until settled; overall deadline bounds pass',async()=>{
 let started=0,outstanding=0,peak=0;const releases=[];const updates=[];
 const sdk=sdkFor(()=>{started++;outstanding++;peak=Math.max(peak,outstanding);return new Promise(resolve=>releases.push(()=>{outstanding--;resolve(description);}));},20);
 const result=await discoverThreadMetricsOwners({sdk,concurrency:2,callMs:5,deadlineMs:35,onRow:r=>updates.push(r)});
 expect(started).toBe(2);expect(peak).toBe(2);expect(outstanding).toBe(2);expect(result.complete).toBe(false);expect(result.omittedCount).toBe(18);expect(result.rows.every(r=>r.error==='timeout')).toBe(true);
 const count=updates.length;releases.forEach(r=>r());await sleep(5);expect(started).toBe(2);expect(updates).toHaveLength(count);
});
test('settlement after timeout permits next queued probe without exceeding actual concurrency',async()=>{
 let outstanding=0,peak=0,started=0;
 const sdk=sdkFor(async()=>{started++;outstanding++;peak=Math.max(peak,outstanding);await sleep(12);outstanding--;return description;},4);
 const result=await discoverThreadMetricsOwners({sdk,concurrency:2,callMs:3,deadlineMs:150});expect(started).toBe(4);expect(peak).toBe(2);expect(result.rows).toHaveLength(4);
});
test('candidate cap and duplicate listing prevent extra reads; oversized describe bytes rejected',async()=>{
 let calls=0;const sdk=sdkFor(async()=>{calls++;return description;},200);
 const result=await discoverThreadMetricsOwners({sdk,maxCandidates:3});expect(calls).toBe(3);expect(result.omittedCount).toBe(197);expect(result.complete).toBe(false);
 await expect(createThreadMetricsClient(sdkFor(async()=>({...description,future:'é'.repeat(LIMITS.describeBytes)})),'x').describe()).rejects.toThrow('Payload byte limit');
});
test('list deadline, abort, and callback abort stop stale pass updates',async()=>{
 const stalled={plugins:{list:()=>new Promise(()=>{}),callRpc:async()=>description}};
 const result=await discoverThreadMetricsOwners({sdk:stalled,deadlineMs:5});expect(result.listError).toBe('timeout');
 const aborted=new AbortController();aborted.abort();expect((await discoverThreadMetricsOwners({sdk:sdkFor(async()=>description),signal:aborted.signal})).listError).toBe('aborted');
 const control=new AbortController();let count=0;
 const cancelled=await discoverThreadMetricsOwners({sdk:sdkFor(async()=>description,10),concurrency:1,signal:control.signal,onRow:()=>{count++;control.abort();}});
 expect(cancelled.complete).toBe(false);expect(count).toBe(1);
});
test('root/bb/testing emitted modules expose no React, rate seed or SDK runtime in root/bb',async()=>{
 for(const entry of ['index','bb']){const source=await Bun.file(new URL(`../dist/${entry}.js`,import.meta.url)).text();expect(source).not.toMatch(/from ["'](?:react|@get-bb\/plugin-sdk)/);expect(source).not.toMatch(/rateSeed|seedRates|globalThis|setInterval/);}
 const kit=await Bun.file(new URL('../dist/testing.js',import.meta.url)).text();expect(kit).toContain('from "./index.js"');expect(kit).toContain('@get-bb/plugin-sdk/testing');
});

test('same coordinator retains ignored-abort admission across repeated refresh passes, including stalled list',async()=>{
 let calls=0;const release=[];
 const coordinator=createThreadMetricsDiscovery(sdkFor(()=>{calls++;return new Promise(resolve=>release.push(()=>resolve(description)));},20));
 await coordinator.discover({concurrency:2,callMs:2,deadlineMs:8});expect(calls).toBe(2);expect(coordinator.outstandingReads).toBe(2);
 for(let i=0;i<10;i++)expect((await coordinator.discover({deadlineMs:5})).listError).toBe('busy');expect(calls).toBe(2);
 release.forEach(r=>r());await sleep(2);expect(coordinator.outstandingReads).toBe(0);
 const next=coordinator.discover({maxCandidates:1,deadlineMs:8});await sleep(2);expect(calls).toBe(3);release.at(-1)();expect((await next).rows[0].state).toBe('ready');
 let listCalls=0,releaseList;const stalled=createThreadMetricsDiscovery({plugins:{list:()=>{listCalls++;return new Promise(resolve=>{releaseList=resolve;});},callRpc:async()=>description}});
 await stalled.discover({deadlineMs:2});for(let i=0;i<5;i++)expect((await stalled.discover()).listError).toBe('busy');expect(listCalls).toBe(1);releaseList(listed(0));await sleep(1);expect(stalled.outstandingReads).toBe(0);
});
test('conformance surfaces a stalled real handler as failed source proof within local budget',async()=>{
 const report=await runSupplierConformance({pluginId:'stalled',register:bb=>registerThreadMetricsOwner(bb,{capabilities:{summary:true,series:false,detail:false},read:()=>new Promise(()=>{})}),readCases:[request],deadlineMs:5});
 expect(report.passed).toBe(false);expect(report.checks.find(c=>c.name==='read-0').error).toBe('Conformance deadline');
});

test('real registered handlers and conformance reject reviewer time/unchanged/null witnesses',async()=>{
 const {windows,...base}=row();
 const witnesses=[
  {read:async()=>({version:1,rows:[{...base,changed:false,windows,buckets:[{start:base.asOf+1,amount:4}]}]}),request:{...request,knownRevisions:{thr_a:base.revision}}},
  {read:async()=>({version:1,rows:[{...row(),buckets:[{start:99900000,amount:null}]}]}),request:{...request,series:{activeThreadId:'thr_a',maxPoints:1}}},
  {detail:async()=>({...detail(),coverage:'partial',coverageReasons:['source-gap'],total:{tokens:row().windows.m20.tokens,amount:null},rows:[]}),detailRequest:detailInput},
  {detail:async()=>({...detail(),axis:'time',window:'m20',total:{tokens:{inputUncached:20,cacheRead:4,cacheWrite:6,output:8},amount:2},rows:[99300000,99600000].map(start=>({axis:'time',start,end:100000000,tokens:row().windows.m20.tokens,amount:1,approximation:{approximate:false,reasons:[]}}))}),detailRequest:{...detailInput,axis:'time',window:'m20'}},
 ];
 for(const witness of witnesses){
  const broken={...port,...(witness.read?{read:witness.read}:{}),...(witness.detail?{detail:witness.detail}:{})};
  const host=createFakePluginHost({pluginId:'witness'});registerThreadMetricsOwner(host.bb,broken);
  try{await expect(host.harness.behavior.callRpc(witness.detail?METHODS.detail:METHODS.read,witness.detailRequest??witness.request)).rejects.toThrow();}finally{await host.harness.lifecycle.dispose();}
  const report=await runSupplierConformance({pluginId:'witness',register:bb=>registerThreadMetricsOwner(bb,broken),readCases:[witness.request??request],detailCases:[witness.detailRequest??detailInput]});expect(report.passed).toBe(false);
 }
});

test('kit requires byte rejection independently of shape-only registered supplier',async()=>{
 const {z}=await import('zod');
 const {readInputSchema,detailInputSchema,describeInputSchema}=await import('../dist/index.js');
 const rawRegister=bb=>bb.rpc.register({
  threadMetricsDescribe:{input:describeInputSchema,output:z.unknown()},
  threadMetricsReadV1:{input:readInputSchema,output:z.unknown()},
  threadMetricsDetailV1:{input:detailInputSchema,output:z.unknown()},
 },{
  threadMetricsDescribe:()=>description,
  threadMetricsReadV1:()=>({version:1,rows:[]}),
  threadMetricsDetailV1:()=>detail(),
 },{experimental_discoverable:true});
 const raw=await runSupplierConformance({pluginId:'shape-only',register:rawRegister,readCases:[request],detailCases:[detailInput]});
 expect(raw.checks.filter(c=>!c.passed).map(c=>c.name)).toEqual(['oversized-input-bytes']);
 const real=await runSupplierConformance({pluginId:'real',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[request],detailCases:[detailInput]});
 expect(real.passed).toBe(true);expect(real.checks.find(c=>c.name==='oversized-input-bytes').passed).toBe(true);
 const ids=Array.from({length:200},(_,i)=>`thr_${i}_`.padEnd(200,'x'));
 const oversized={scope:'family',threadIds:ids,knownRevisions:Object.fromEntries(ids.map(id=>[id,'r'.repeat(256)]))};
 expect(readInputSchema.safeParse(oversized).success).toBe(true);expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBe(133051);
 const positive=await runSupplierConformance({pluginId:'bounded-cases',register:rawRegister,readCases:[oversized],detailCases:[detailInput]});
 expect(positive.checks.find(c=>c.name==='read-0').error).toBe('Payload byte limit');
});
test('aggregate approximation and rate provenance faults fail real handlers and conformance',async()=>{
 const fallback={approximate:true,reasons:['provider-default']};
 const badRates={approximate:true,reasons:['provider-default'],rates:[{providerId:'provider',modelId:'model',rateId:null,basis:'provider-default'}]};
 const witnesses=[
  {...detail(),rows:[{...detail().rows[0],approximation:fallback}]},
  {...detail(),approximation:{approximate:true,reasons:['bucket-boundary']},rows:[{...detail().rows[0],approximation:fallback}]},
  {...detail(),approximation:badRates},
  {...detail(),rows:[{...detail().rows[0],approximation:badRates}]},
 ];
 for(const value of witnesses){
  const invalid={...port,detail:async()=>value};const host=createFakePluginHost({pluginId:'bad-provenance'});registerThreadMetricsOwner(host.bb,invalid);
  try{await expect(host.harness.behavior.callRpc(METHODS.detail,detailInput)).rejects.toThrow();}finally{await host.harness.lifecycle.dispose();}
  const report=await runSupplierConformance({pluginId:'bad-provenance',register:bb=>registerThreadMetricsOwner(bb,invalid),readCases:[request],detailCases:[detailInput]});
  expect(report.checks.find(c=>c.name==='detail-0').passed).toBe(false);
 }
});
test('ordinary client forwards abort but consumer fences a late ignored-abort response',async()=>{
 let resolveRead,forwardedSignal;const control=new AbortController();let published=0;
 const client=createThreadMetricsClient(sdkFor(args=>{forwardedSignal=args.signal;return new Promise(resolve=>{resolveRead=resolve;});}),'supplier');
 const pending=client.read(request,control.signal).then(result=>{if(control.signal.aborted)return;published+=result.rows.length;});
 expect(forwardedSignal).toBe(control.signal);control.abort();resolveRead({version:1,rows:[row()]});await pending;
 expect(published).toBe(0); // aborted remote work still completed; caller owns the publication fence
});
