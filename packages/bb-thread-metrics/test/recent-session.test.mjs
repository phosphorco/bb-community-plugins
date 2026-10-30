import {test,expect} from 'bun:test';
import {DEFAULT_SCORING_CONFIG_V3,RECENT_LIMITS,METHODS} from '../dist/index.js';
import {createRecentSnapshotSession,RecentSnapshotNotStarted,RecentSnapshotSessionError,registerThreadMetricsOwner,createThreadMetricsClient} from '../dist/bb.js';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
const T=1800000000000;
function snapshot(sequence=1,instance='writer-A',extra={}){
 const pop=()=>({m20:{count:0,coverage:'complete'},h24:{count:0,coverage:'complete'},d7:{count:0,coverage:'complete'}});
 return {version:1,unchanged:false,revision:'opaque|'+sequence+'|'+instance,publication:{instance,sequence},currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:T,rankAsOf:T,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'config-A',value:structuredClone(DEFAULT_SCORING_CONFIG_V3)},heat:{version:1,domain:{version:1,kind:'root-family'},contextRevision:'ctx',configRevision:'config-A',topologyRevision:'topo',rankRevision:'ranks',rankAsOf:T,windows:{m20:{start:T-1200000,end:T},h24:{start:T-86400000,end:T},d7:{start:T-604800000,end:T}},population:{dollars:Object.fromEntries(Object.entries(pop()).map(([w,p])=>[w,{...p,reasons:[]}])),scores:Object.fromEntries(Object.entries(pop()).map(([w,p])=>[w,{...p,reasons:[]}]))}},coverage:'complete',coverageReasons:[],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:pop(),scores:pop()},family:{dollars:pop(),scores:pop()}},rows:[],...extra};
}
function time(){const jobs=new Set();return {clock:{later(run){jobs.add(run);return ()=>jobs.delete(run);}},expire(){for(const run of [...jobs])run();},get jobs(){return jobs.size;}};}
function held(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
async function rejectsReason(promise,reason,NotStarted=false){let error;try{await promise;}catch(e){error=e;}expect(error).toBeInstanceOf(NotStarted?RecentSnapshotNotStarted:RecentSnapshotSessionError);expect(error.reason).toBe(reason);return error;}

test('session makes no reads/timers until explicit demand; conditional success interns the immutable full object',async()=>{
 const timer=time(),inputs=[];let value=snapshot();const source={pluginId:'ledger',async recentSnapshot(input){inputs.push(input);return input.ifRevision===value.revision?{version:1,unchanged:true,revision:value.revision}:value;}};
 const session=createRecentSnapshotSession(source,{clock:timer.clock});expect(inputs).toHaveLength(0);expect(timer.jobs).toBe(0);expect(session.current).toBeUndefined();
 const first=await session.read();expect(first.ownerGeneration).toBe(1);expect(first.sourceGeneration).toBe(1);expect(session.current).toBe(first);expect(Object.isFrozen(first.snapshot.config.value)).toBe(true);
 expect(await session.read()).toBe(first);expect(inputs).toEqual([{}, {ifRevision:value.revision}]);expect(timer.jobs).toBe(0);expect(session.outstandingReads).toBe(0);
 value=structuredClone(value);expect(await session.read({full:true})).toBe(first);expect(inputs.at(-1)).toEqual({});
});

test('publication ordering rejects stale/equal-conflicting data and advances a greater writer exactly once',async()=>{
 let value=snapshot(20);const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){return value;}});const first=await session.read();
 value=snapshot(2);await rejectsReason(session.read({full:true}),'stale-publication');expect(session.current).toBe(first);
 for(const bad of [snapshot(20,'writer-B'),snapshot(20,'writer-A',{revision:'different'}),snapshot(20,'writer-A',{asOf:T+1})]){value=bad;await rejectsReason(session.read({full:true}),'publication-conflict');expect(session.current).toBe(first);}
 value=snapshot(21,'writer-A',{revision:first.snapshot.revision});await rejectsReason(session.read(),'publication-conflict');expect(session.ownerGeneration).toBe(1);
 value=snapshot(21);const next=await session.read();expect(next.ownerGeneration).toBe(1);
 value=snapshot(22,'writer-B');const successor=await session.read();expect(successor.ownerGeneration).toBe(2);expect(successor.sourceGeneration).toBe(1);expect(await session.read({full:true})).toBe(successor);expect(session.ownerGeneration).toBe(2);
 value=snapshot(23,'writer-B');expect((await session.read()).ownerGeneration).toBe(2);
});

test('null, legacy header absence, transport faults, inactive/remount and wrapper recreation retain the watermark',async()=>{
 let value=snapshot(20);const source={pluginId:'ledger',async recentSnapshot(){if(value instanceof Error)throw value;return value;}};const session=createRecentSnapshotSession(source);const first=await session.read();
 value=null;await expect(session.read()).rejects.toThrow();expect(session.current).toBe(first);
 value=snapshot(21);delete value.publication;await rejectsReason(session.read(),'missing-publication');expect(session.current).toBe(first);
 value=new Error('remote failed');await expect(session.read()).rejects.toThrow('remote failed');expect(session.current).toBe(first);
 session.setActive(false);await rejectsReason(session.read(),'inactive',true);session.setActive(true);session.updateSource({...source});expect(session.current).toBe(first);expect(session.ownerGeneration).toBe(1);
 value=snapshot(2);await rejectsReason(session.read(),'stale-publication');expect(session.current).toBe(first);
 expect(()=>session.updateSource({...source,pluginId:'other'})).toThrow('explicit replacement');expect(session.pluginId).toBe('ledger');expect(session.current).toBe(first);
});

test('logical timeout and repeated remount/reconnect never free an ignored-abort actual read',async()=>{
 const timer=time(),pending=held();let calls=0,signal;const source={pluginId:'ledger',recentSnapshot(_input,s){calls++;signal=s;return pending.promise;}};const session=createRecentSnapshotSession(source,{clock:timer.clock});
 const first=session.read();timer.expire();await rejectsReason(first,'timeout');expect(signal.aborted).toBe(true);expect(session.outstandingReads).toBe(1);
 for(let i=0;i<8;i++){session.setActive(false);session.setActive(true);session.updateSource({...source});await rejectsReason(session.read(),'busy',true);}
 expect(calls).toBe(1);expect(timer.jobs).toBe(0);pending.resolve(snapshot(99));await flush();expect(session.outstandingReads).toBe(0);expect(session.current).toBeUndefined();
 session.updateSource({pluginId:'ledger',async recentSnapshot(){calls++;return snapshot(2);}});expect((await session.read()).publication.sequence).toBe(2);expect(calls).toBe(2);
});

test('caller abort/inactive preserve actual ownership; already-aborted calls do not invoke the source',async()=>{
 const timer=time(),pending=held(),control=new AbortController();let calls=0;const session=createRecentSnapshotSession({pluginId:'ledger',recentSnapshot(){calls++;return pending.promise;}},{clock:timer.clock});
 control.abort();await rejectsReason(session.read({signal:control.signal}),'aborted-before-start',true);expect(calls).toBe(0);
 const secondControl=new AbortController(),read=session.read({signal:secondControl.signal});secondControl.abort();await rejectsReason(read,'aborted');expect(session.outstandingReads).toBe(1);expect(calls).toBe(1);pending.reject(new Error('actual source failed later'));await flush();expect(session.outstandingReads).toBe(0);
 const another=held();session.updateSource({pluginId:'ledger',recentSnapshot(){return another.promise;}});const inactive=session.read();session.setActive(false);await rejectsReason(inactive,'inactive');session.setActive(true);await rejectsReason(session.read(),'busy',true);another.resolve(snapshot(1));await flush();expect(session.current).toBeUndefined();expect(session.outstandingReads).toBe(0);expect(timer.jobs).toBe(0);
});

test('explicit source replacement fences old callbacks and resets lineage only after actual old settlement',async()=>{
 let value=snapshot(40);const pending=held();let nextCalls=0;const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){return value;}});await session.read();
 session.updateSource({pluginId:'ledger',recentSnapshot(){return pending.promise;}});const old=session.read();session.replaceSource({pluginId:'ledger',async recentSnapshot(){nextCalls++;return snapshot(1,'restored');}});await rejectsReason(old,'source-replaced');expect(session.current).toBeUndefined();expect(session.sourceGeneration).toBe(2);expect(session.ownerGeneration).toBe(2);await rejectsReason(session.read(),'busy',true);expect(nextCalls).toBe(0);
 pending.resolve(snapshot(999,'old-late'));await flush();expect(session.current).toBeUndefined();const next=await session.read();expect(next.publication.sequence).toBe(1);expect(next.ownerGeneration).toBe(2);expect(next.sourceGeneration).toBe(2);expect(nextCalls).toBe(1);
});

test('ordinary source facade update does not invalidate the still-authoritative actual response',async()=>{
 const pending=held();const session=createRecentSnapshotSession({pluginId:'ledger',recentSnapshot(){return pending.promise;}});const read=session.read();session.updateSource({pluginId:'ledger',async recentSnapshot(){return snapshot(2);}});pending.resolve(snapshot(1));expect((await read).publication.sequence).toBe(1);expect((await session.read()).publication.sequence).toBe(2);expect(session.ownerGeneration).toBe(1);
});

test('forced-full/first unchanged, malformed identity and additive byte overflow never establish a cache',async()=>{
 let value={version:1,unchanged:true,revision:'nothing'};const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){return value;}});
 await expect(session.read()).rejects.toThrow();expect(session.current).toBeUndefined();
 for(const pair of [{instance:'a',sequence:0},{instance:'a',sequence:Number.MAX_SAFE_INTEGER+1},{instance:'',sequence:1}]){value=snapshot(1);value.publication=pair;await expect(session.read()).rejects.toThrow();expect(session.current).toBeUndefined();}
 value=snapshot(1,'writer-A',{extra:'x'.repeat(RECENT_LIMITS.bytes)});await expect(session.read()).rejects.toThrow();expect(session.current).toBeUndefined();
 value=snapshot();const first=await session.read();value={version:1,unchanged:true,revision:first.snapshot.revision};await expect(session.read({full:true})).rejects.toThrow();expect(session.current).toBe(first);
});

test('late payloads after a local deadline are not inspected or admitted',async()=>{
 const timer=time(),pending=held();const session=createRecentSnapshotSession({pluginId:'ledger',recentSnapshot(){return pending.promise;}},{clock:timer.clock});const read=session.read();timer.expire();await rejectsReason(read,'timeout');let touched=0;const raw={get version(){touched++;throw new Error('must not decode late data');}};pending.resolve(raw);await flush();expect(touched).toBe(0);expect(session.current).toBeUndefined();expect(session.outstandingReads).toBe(0);
});

test('reentrant source replacement or caller abort during raw validation cannot admit an obsolete response',async()=>{
 for(const mode of ['replace','abort']){let value=snapshot();const controller=new AbortController();const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){return value;}});const first=await session.read();value=snapshot(2);let once=false;Object.defineProperty(value,'version',{enumerable:true,get(){if(!once){once=true;if(mode==='replace')session.replaceSource({pluginId:'new',async recentSnapshot(){return snapshot(1,'new');}});else controller.abort();}return 1;}});
 const read=session.read({signal:controller.signal});await expect(read).rejects.toThrow();expect(session.current).toBe(mode==='replace'?undefined:first);expect(session.outstandingReads).toBe(0);}
});

test('source-thrown not-started lookalikes do not carry this session local admission proof',async()=>{
 const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){throw new RecentSnapshotNotStarted('busy');}});let error;try{await session.read();}catch(e){error=e;}expect(error).not.toBeInstanceOf(RecentSnapshotNotStarted);expect(error.cause).toBeInstanceOf(RecentSnapshotNotStarted);expect(session.outstandingReads).toBe(0);
 let rejected=false;session.updateSource({pluginId:'ledger',async recentSnapshot(){throw undefined;}});await session.read().then(()=>{throw new Error('undefined rejection must not resolve');},error=>{rejected=true;expect(error).toBeUndefined();});expect(rejected).toBe(true);expect(session.current).toBeUndefined();
});

test('actual registered owner and ordinary client preserve conditional identity and ordered writer transition',async()=>{
 let value=snapshot(20),calls=0;const host=createFakePluginHost({pluginId:'session-owner'});
 try{
  registerThreadMetricsOwner(host.bb,{capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>{throw new Error('No legacy collection');},recentSnapshot:async input=>{calls++;return input.ifRevision===value.revision?{version:1,unchanged:true,revision:value.revision}:value;}});
  const sdk={plugins:{list:async()=>({plugins:[]}),callRpc:async args=>host.harness.behavior.callRpc(args.method,args.input)}};
  const client=createThreadMetricsClient(sdk,'session-owner'),session=createRecentSnapshotSession(client);const first=await session.read();for(let i=0;i<20;i++)expect(await session.read()).toBe(first);expect(calls).toBe(21);
  value=snapshot(21,'new-writer');const next=await session.read();expect(next.ownerGeneration).toBe(2);expect(next.publication.instance).toBe('new-writer');value=snapshot(2,'restored');await rejectsReason(session.read(),'stale-publication');expect(session.current).toBe(next);expect(host.harness.behavior).toBeDefined();expect(METHODS.recentSnapshot).toBe('threadMetricsRecentSnapshotV1');
 }finally{await host.harness.lifecycle.dispose();}
});
