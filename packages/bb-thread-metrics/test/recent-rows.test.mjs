import {test,expect} from 'bun:test';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {DEFAULT_SCORING_CONFIG_V2,RECENT_LIMITS,projectRecentRows,validateRecentRows,validateRecentSnapshot,RecentRowsBaselineMissing} from '../dist/index.js';
import {createRecentSnapshotSession,createThreadMetricsClient,registerThreadMetricsOwner} from '../dist/bb.js';
const T=1800000000000;
const windows=()=>Object.fromEntries(['m20','h24','d7','lifetime'].map(k=>[k,{kind:'estimate',amount:1}]));
const scope=()=>({memberCount:1,coverage:'complete',coverageReasons:[],priceVersion:'rates-v1',approximation:{approximate:false,reasons:[]},windows:windows(),scores:windows(),providers:[{providerId:'claude-code',approximation:{approximate:false,reasons:[]},windows:windows()}],omittedProviders:0,dollarRanks:{m20:0,h24:0,d7:0},scoreRanks:{m20:0,h24:0,d7:0}});
function snapshot(sequence=1,n=80){const population=()=>Object.fromEntries(['m20','h24','d7'].map(k=>[k,{count:n,coverage:'complete'}]));return {version:1,revision:'writer:'+sequence,publication:{instance:'writer',sequence},unchanged:false,currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:T+sequence,rankAsOf:T,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'cfg:1',value:DEFAULT_SCORING_CONFIG_V2},coverage:'complete',coverageReasons:[],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:population(),scores:population()},family:{dollars:population(),scores:population()}},rows:Array.from({length:n},(_,i)=>({threadId:'thr_'+String(i).padStart(4,'0'),revision:'r1',configRevision:'cfg:1',asOf:T,ownLastFoldAt:T,familyLastFoldAt:T,own:scope(),family:scope()}))};}
async function fixture(){
 const host=createFakePluginHost({pluginId:'rows-owner'});let value=snapshot(),reuse=true,badEcho=false;const calls=[],requests=[];
 registerThreadMetricsOwner(host.bb,{capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true,recentRowsV1:true},read:async()=>{throw new Error('No summary collection');},recentSnapshot:async input=>input.ifRevision===value.revision?{version:1,unchanged:true,revision:value.revision}:value,recentRows:async input=>{const result=projectRecentRows(input,value,reuse);return badEcho&&'rowsUnchanged' in result?{...result,baseRevision:'other'}:result;}});
 const sdk={plugins:{list:async()=>({plugins:[]}),callRpc:async args=>{requests.push({method:args.method,input:args.input});const result=await host.harness.behavior.callRpc(args.method,args.input);calls.push({method:args.method,input:args.input,bytes:new TextEncoder().encode(JSON.stringify(result)).byteLength,hasRows:Object.hasOwn(result,'rows')});return result;}}};
 return {host,sdk,calls,requests,badEcho(value){badEcho=value;},client:createThreadMetricsClient(sdk,'rows-owner'),set(next){value=next;},reuse(value){reuse=value;},get value(){return value;}};
}

test('negotiated metadata-only publication omits unchanged rows at actual registered SDK boundary',async()=>{
 const f=await fixture();try{
  expect((await f.client.describe()).capabilities.recentRowsV1).toBe(true);
  const session=createRecentSnapshotSession({...f.client,recentRowsSnapshot:f.client.recentRows}),first=await session.read();const next=snapshot(2);next.coverage='partial';next.coverageReasons=['population-incomplete'];next.materializationPending=3;next.omittedRows={count:2,exact:false};next.cutoffLastFoldAt=T;f.set(next);
  const second=await session.read(),wire=f.calls.at(-1);console.log(JSON.stringify({event:'recent-row-transfer',method:wire.method,fullBytes:f.calls[1].bytes,metadataBytes:wire.bytes,hasRows:wire.hasRows}));
  expect(wire.hasRows).toBe(false);expect(wire.method).toBe('threadMetricsRecentRowsV1');expect(wire.bytes).toBeLessThan(f.calls[1].bytes/10);expect(second.snapshot.rows).toBe(first.snapshot.rows);expect(second.snapshot.asOf).toBe(T+2);expect(second.snapshot.materializationPending).toBe(3);expect(second.snapshot.coverageReasons).toEqual(['population-incomplete']);expect(second.snapshot.omittedRows).toEqual({count:2,exact:false});expect(second.publication.sequence).toBe(2);
 }finally{await f.host.harness.lifecycle.dispose();}
});

test('legacy full and whole-publication unchanged replies retain their exact meaning',async()=>{
 const f=await fixture();try{const source={pluginId:f.client.pluginId,recentSnapshot:f.client.recentSnapshot},session=createRecentSnapshotSession(source);const first=await session.read();expect(await session.read()).toBe(first);expect(f.calls.every(c=>c.method==='threadMetricsRecentSnapshotV1')).toBe(true);f.set(snapshot(2));expect((await session.read()).snapshot.asOf).toBe(T+2);expect(f.calls.at(-1).hasRows).toBe(true);}finally{await f.host.harness.lifecycle.dispose();}
});

test('missing or conflicting row baseline preserves last good observation and forces next full read',async()=>{
 let value=snapshot(),bad=false;const inputs=[];const source={pluginId:'ledger',async recentSnapshot(){return value;},async recentRowsSnapshot(input){inputs.push(input);return bad&&input.ifRevision?{...projectRecentRows(input,value,true),baseRevision:'other'}:projectRecentRows(input,value,true);}};const session=createRecentSnapshotSession(source),first=await session.read();value=snapshot(2);bad=true;await expect(session.read()).rejects.toBeInstanceOf(RecentRowsBaselineMissing);expect(session.current).toBe(first);bad=false;const recovered=await session.read();expect(inputs.at(-1)).toEqual({});expect(recovered.publication.sequence).toBe(2);expect(()=>validateRecentRows({ifRevision:'writer:1'},projectRecentRows({ifRevision:'writer:1'},value,true))).toThrow('baseline');
});

test('unsupported rows version falls back on the next admitted read without erasing freshness errors',async()=>{
 let value=snapshot(),unsupported=false,rows=0,legacy=0;const source={pluginId:'ledger',async recentSnapshot(input){legacy++;if(legacy===1)expect(input).toEqual({});return value;},async recentRowsSnapshot(input){rows++;return unsupported?{version:99}:projectRecentRows(input,value,true);}};const session=createRecentSnapshotSession(source),first=await session.read();value=snapshot(2);unsupported=true;await expect(session.read()).rejects.toThrow('Unsupported');expect(session.current).toBe(first);expect(session.outstandingReads).toBe(0);const next=await session.read();expect(next.snapshot.asOf).toBe(T+2);expect(legacy).toBe(1);expect(rows).toBe(2);await session.read();expect(rows).toBe(2);session.setActive(false);session.setActive(true);unsupported=false;await session.read();expect(rows).toBe(3);
});

test('absent negotiated method recovers through legacy while transport failures keep existing errors',async()=>{
 let value=snapshot(),fail=false;let legacy=0,rows=0;const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){legacy++;return value;},async recentRowsSnapshot(input){rows++;if(fail)throw Object.assign(new Error('Unknown method'),{status:404});return projectRecentRows(input,value,true);}});const first=await session.read();fail=true;value=snapshot(2);await expect(session.read()).rejects.toThrow('Unknown');expect(session.current).toBe(first);expect((await session.read()).publication.sequence).toBe(2);expect(legacy).toBe(1);expect(rows).toBe(2);
});

test('reused rows remain immutable and metadata advances without another retained row array',async()=>{
 const f=await fixture();try{const session=createRecentSnapshotSession({...f.client,recentRowsSnapshot:f.client.recentRows}),first=await session.read();for(let i=2;i<=22;i++){f.set(snapshot(i));const next=await session.read();expect(next.snapshot.rows).toBe(first.snapshot.rows);expect(next.snapshot.asOf).toBe(T+i);expect(Object.isFrozen(next.snapshot.rows)).toBe(true);}expect(session.outstandingReads).toBe(0);expect(f.calls.filter(c=>c.hasRows)).toHaveLength(1);}finally{await f.host.harness.lifecycle.dispose();}
});

test('navigation reconnect and explicit source replacement retain normal admission and lineage fences',async()=>{
 let value=snapshot(),release;const source={pluginId:'ledger',async recentSnapshot(){return value;},async recentRowsSnapshot(input){return projectRecentRows(input,value,true);}};const session=createRecentSnapshotSession(source),first=await session.read();session.setActive(false);session.setActive(true);value=snapshot(2);expect((await session.read()).snapshot.rows).toBe(first.snapshot.rows);
 session.updateSource({...source,recentRowsSnapshot:()=>new Promise(resolve=>{release=resolve;})});const pending=session.read();session.setActive(false);await expect(pending).rejects.toThrow('inactive');session.setActive(true);await expect(session.read()).rejects.toThrow('busy');release(projectRecentRows({ifRevision:'writer:2'},snapshot(3),true));await Promise.resolve();await Promise.resolve();expect(session.current.publication.sequence).toBe(2);
 session.replaceSource({...source,pluginId:'replacement'});value=snapshot(1);expect((await session.read()).sourceGeneration).toBe(2);expect(session.current.publication.sequence).toBe(1);
});

test('wrong row contexts hidden rows and aggregate bytes cannot masquerade as fresh metadata',()=>{
 const base=validateRecentSnapshot({},snapshot()),input={ifRevision:base.revision},value=snapshot(2),reply=projectRecentRows(input,value,true);expect(()=>validateRecentRows(input,{...reply,rows:[]},base)).toThrow();expect(()=>validateRecentRows(input,{...reply,config:{...reply.config,revision:'new'}},base)).toThrow();expect(()=>validateRecentRows(input,{...reply,extra:'x'.repeat(RECENT_LIMITS.bytes)},base)).toThrow('byte');expect(()=>validateRecentRows(input,{...reply,asOf:T-1},base)).toThrow();expect(validateRecentRows(input,projectRecentRows(input,value,false),base).rows).toHaveLength(80);
});


test('full row updates and removals replace the wire baseline without inventing unchanged content',async()=>{
 const f=await fixture();try{f.set(snapshot(1,1));const session=createRecentSnapshotSession({...f.client,recentRowsSnapshot:f.client.recentRows}),first=await session.read();f.reuse(false);const changed=snapshot(2,1);changed.rows[0].revision='row:2';for(const side of [changed.rows[0].own,changed.rows[0].family])for(const w of ['m20','h24','d7','lifetime']){side.windows[w].amount=2;side.scores[w].amount=2;side.providers[0].windows[w].amount=2;}f.set(changed);const next=await session.read();expect(next.snapshot.rows).not.toBe(first.snapshot.rows);expect(next.snapshot.rows[0].own.windows.m20.amount).toBe(2);expect(f.calls.at(-1).hasRows).toBe(true);f.set(snapshot(3,0));const removed=await session.read();expect(removed.snapshot.rows).toEqual([]);expect(removed.snapshot.asOf).toBe(T+3);expect(f.calls.at(-1).hasRows).toBe(true);}finally{await f.host.harness.lifecycle.dispose();}
});


test('malformed missing empty and non-string echoes fail first and recover with an unconditional full read',async()=>{
 for(const echo of [undefined,'',42]){let value=snapshot(),bad=false;const inputs=[];const session=createRecentSnapshotSession({pluginId:'ledger',async recentSnapshot(){return value;},async recentRowsSnapshot(input){inputs.push(input);const result=projectRecentRows(input,value,true);if(bad&&input.ifRevision){const wrong={...result};if(echo===undefined)delete wrong.baseRevision;else wrong.baseRevision=echo;return wrong;}return result;}});const first=await session.read();value=snapshot(2);bad=true;await expect(session.read()).rejects.toThrow();expect(session.current).toBe(first);expect(session.outstandingReads).toBe(0);bad=false;expect((await session.read()).publication.sequence).toBe(2);expect(inputs.at(-1)).toEqual({});}
});

test('actual registered owner rejection retires conditional eligibility without hiding the failed observation',async()=>{
 const f=await fixture();try{const session=createRecentSnapshotSession({...f.client,recentRowsSnapshot:f.client.recentRows}),first=await session.read();f.set(snapshot(2));f.badEcho(true);await expect(session.read()).rejects.toThrow();expect(session.current).toBe(first);expect(session.outstandingReads).toBe(0);expect(f.requests.at(-1).input).toEqual({ifRevision:first.snapshot.revision});f.badEcho(false);expect((await session.read()).publication.sequence).toBe(2);expect(f.requests.at(-1).input).toEqual({});expect(f.calls.at(-1).hasRows).toBe(true);}finally{await f.host.harness.lifecycle.dispose();}
});


test('reentrant error classification cannot disable the replacement source row method',async()=>{
 let legacy=0,rows=0;const replacement={pluginId:'replacement',async recentSnapshot(){legacy++;return snapshot();},async recentRowsSnapshot(){rows++;return snapshot();}};let session;const error={get status(){session.replaceSource(replacement);return 404;}};session=createRecentSnapshotSession({pluginId:'old',async recentSnapshot(){throw new Error('Unexpected legacy');},async recentRowsSnapshot(){throw error;}});await expect(session.read()).rejects.toThrow('source-replaced');expect(session.outstandingReads).toBe(0);expect(session.current).toBeUndefined();const next=await session.read();expect(next.sourceGeneration).toBe(2);expect(rows).toBe(1);expect(legacy).toBe(0);
});
