import {test,expect} from 'bun:test';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {readInputSchema,readOutputSchema,decodeRead,negotiateVersion,LIMITS,METHODS,PROTOCOL,type ReadOutput} from '../src/index.js';
import {createThreadContextClient,registerThreadContextSupplier,classifyContextError} from '../src/bb.js';
import {runThreadContextSupplierConformance} from '../src/testing.js';
const missing={state:'missing' as const,text:'',truncated:false,heading:null};
const ready=(threadId='t'):ReadOutput=>({state:'ready',threadId,source:{document:'brief',revision:'r1',observedAt:10,modifiedAt:9,readBasis:'validated-read',completeness:'complete'},fields:{goal:{state:'present',text:'Ship a useful topic browser.',truncated:false,heading:'Goal'},whereItStands:missing,decisions:missing}});
test('strict requests; additive versioned output; identity/byte/missing facts',()=>{
 expect(readInputSchema.safeParse({threadId:'t',rootPath:'/tmp'}).success).toBe(false);
 for(const versions of [[1],[1,2]])expect(negotiateVersion({protocol:PROTOCOL,versions,future:true})).toEqual({version:1});for(const versions of [[2],[],['1']])expect(negotiateVersion({protocol:PROTOCOL,versions})).toBeNull();
 expect(readOutputSchema.safeParse({...ready(),future:true}).success).toBe(true);expect(()=>decodeRead({threadId:'other'},ready())).toThrow();const v=ready();if(v.state!=='ready')throw Error();v.fields.goal.text='日'.repeat(1400);expect(readOutputSchema.safeParse(v).success).toBe(false);expect(()=>decodeRead({threadId:'t'},{...ready(),future:'x'.repeat(LIMITS.responseBytes)})).toThrow();expect(readOutputSchema.safeParse({...v,fields:{...v.fields,goal:{...missing,text:'hidden'}}}).success).toBe(false);
});
test('conformance drives real supplier registration and distinguishes missing',async()=>{
 const report=await runThreadContextSupplierConformance({pluginId:'brief',register:bb=>registerThreadContextSupplier(bb,({threadId})=>threadId==='gone'?{state:'unavailable',threadId,reason:'missing'}:ready(threadId)),cases:[{threadId:'t',expect:'ready',check:v=>expect(v.state==='ready'&&v.fields.goal.text).toBe('Ship a useful topic browser.')},{threadId:'gone',expect:'unavailable'}]});expect(report.passed).toBe(true);expect(report.checks.length).toBe(5);
});
test('ignored abort releases caller but retains raw singleflight slot',async()=>{
 let settle:((value:unknown)=>void)|undefined;let calls=0;const sdk={plugins:{callRpc:()=>{calls++;return new Promise(resolve=>{settle=resolve;});}}} as unknown as Parameters<typeof createThreadContextClient>[0];const client=createThreadContextClient(sdk,'brief');const abort=new AbortController();const pending=client.read({threadId:'t'},abort.signal);abort.abort();await expect(pending).rejects.toMatchObject({kind:'cancelled'});await expect(client.read({threadId:'t'})).rejects.toMatchObject({kind:'transient'});expect(calls).toBe(1);settle?.(ready());await Promise.resolve();await Promise.resolve();
});
test('supplier owns deadline and held admission survives local timeout',async()=>{
 const host=createFakePluginHost({pluginId:'brief'});const releases:((v:ReadOutput)=>void)[]=[];registerThreadContextSupplier(host.bb,()=>new Promise(resolve=>releases.push(resolve)));const call=()=>host.harness.behavior.callRpc(METHODS.read,{threadId:'t'});const first=call(),second=call();expect(await call()).toMatchObject({reason:'busy'});expect(await first).toMatchObject({reason:'timeout'});expect(await second).toMatchObject({reason:'timeout'});expect(await call()).toMatchObject({reason:'busy'});for(const release of releases)release(ready());
});
test('actual SDK error shapes isolate owner failure',()=>{expect(classifyContextError({status:404,body:{error:{code:'unknown_method'}}})).toBe('absent');expect(classifyContextError({status:404,body:{error:'unknown plugin "gone"'}})).toBe('vanished');expect(classifyContextError({status:403})).toBe('unauthorized');expect(classifyContextError({status:500,body:{error:{code:'invalid_output'}}})).toBe('incompatible');});

test('actual client refuses wrong thread and malformed reasons as incompatible',async()=>{
 for(const value of [ready('other'),...([undefined,null,7,{}].map(reason=>({state:'unavailable',threadId:'t',reason})))]){
 const sdk={plugins:{callRpc:async()=>value}} as unknown as Parameters<typeof createThreadContextClient>[0];await expect(createThreadContextClient(sdk,'brief').read({threadId:'t'})).rejects.toMatchObject({kind:'incompatible'});
 }
 expect(readOutputSchema.parse({state:'unavailable',threadId:'t',reason:'future-string'})).toMatchObject({reason:'other'});
});
