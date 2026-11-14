import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {createMessageRules} from '../../ui-suite-server.ts';
import {GLOBAL_CATALOG as G} from '../../contracts/catalog.ts';
import {defaultConnection} from '../../contracts/model.ts';
import {snapshotSchema} from '../../suite-rpc-contract.ts';
import {memoryFiles,source,testGroup,jevRule,answer,waitUntil} from '../helpers.ts';
import {confirmsWrite} from '../../ui/writes.ts';

async function setup(transport?:Parameters<typeof createMessageRules>[1]) {
 const fake=createFakePluginHost({pluginId:'message-rules'});
 const mem=memoryFiles(Object.fromEntries(['chosen','other'].map(id=>[id+'.md',source(id).replace('version: 1','version: 1\nproject_id: project')])));
 for(const name of ['list','read','write','mkdir'] as const)fake.harness.inspection.sdk.stub('files.'+name,mem.port[name] as never);
 let calls=0;
 const product=createMessageRules(fake.bb,transport??{transportFor:()=>async wire=>{calls++;return answer(wire);}});
 const rpc=async(method:string,input:object={})=>snapshotSchema.parse(await fake.harness.behavior.callRpc(method,{projectId:G,...input}));
 let s=await rpc('configure',{revision:product.store.get(G)!.revision,hostId:'host-proof',root:'/tests',connection:{...defaultConnection,maxCalls:2,timeoutMs:1000}});
 s=await rpc('saveGroup',{revision:s.project!.revision,group:testGroup});
 s=await rpc('saveRule',{revision:s.project!.revision,rule:jevRule()});
 return {fake,mem,product,rpc,s,calls:()=>calls,async close(){await fake.harness.lifecycle.dispose();}};
}
test('registered selected Test deduplicates saved identities, freezes denominator, scopes and ledger; omitted selection keeps Test all',async()=>{
 const f=await setup();try{
 const selected=f.s.project!.occurrences.find(o=>o.path==='chosen.md')!.occurrenceId;
 const i={requestId:'selected',basis:f.s.basis,hasRelevantDrafts:false,selectedOccurrenceIds:[selected,selected]};
 let s=await f.rpc('startSuite',i);const id=s.run!.id;
 await waitUntil(()=>!!f.product.store.run(id)?.quiescent);
 s=await f.rpc('snapshot',{discoverFiles:false,requestId:i.requestId});
 assert.equal(f.calls(),1);assert.equal(s.acknowledgedRun!.frozen.denominator,1);assert.deepEqual(s.run!.frozen.selectedOccurrenceIds,[selected]);
 assert.deepEqual(s.run!.frozen.occurrences.map(o=>o.path),['chosen.md']);assert.equal(s.run!.results[0]!.status,'pass');
 assert.equal(s.run!.results[0]!.evaluation!.groups!.find(g=>g.id===testGroup.id)!.status,'in-scope');
 assert.equal((f.product.store.db.prepare('SELECT count(*) n FROM mr_attempts WHERE run_id=?').get(id) as any).n,1);
 assert.equal(confirmsWrite({projectId:G,method:'startSuite',input:i},s),true);
 assert.equal(confirmsWrite({projectId:G,method:'startSuite',input:{...i,selectedOccurrenceIds:['other']}},s),false);
 const same=await f.rpc('startSuite',i);assert.equal(same.run!.id,id);assert.equal(f.calls(),1);
 await assert.rejects(f.rpc('startSuite',{...i,selectedOccurrenceIds:undefined}),/different inputs/);
 await assert.rejects(f.rpc('startSuite',{...i,selectedOccurrenceIds:['other']}),/different inputs/);
 assert.equal(f.calls(),1);
 s=await f.rpc('startSuite',{requestId:'all',basis:f.s.basis,hasRelevantDrafts:false});
 await waitUntil(()=>!!f.product.store.run(s.run!.id)?.quiescent);
 const all=f.product.store.run(s.run!.id)!;assert.equal(all.frozen.denominator,2);assert.equal(all.frozen.selectedOccurrenceIds,undefined);assert.equal(f.calls(),3);
 }finally{await f.close();}
});
test('selected Test rejects empty/oversized/unknown/disabled/missing/changed-basis input before any paid reservation',async()=>{
 const f=await setup();try{
 const o=f.s.project!.occurrences[0]!;let n=0;
 const start=(selectedOccurrenceIds:string[],basis=f.s.basis)=>f.rpc('startSuite',{requestId:'bad-'+n++,basis,hasRelevantDrafts:false,selectedOccurrenceIds});
 for(const selection of [[],Array(101).fill(o.occurrenceId),['unknown']])await assert.rejects(start(selection));
 await assert.rejects(start([o.occurrenceId],'stale-basis'));
 f.mem.values.set(o.path,o.source!+'\n');
 await assert.rejects(start([o.occurrenceId]),/changed|Refresh/);
 let p=f.product.store.get(G)!;
 f.product.store.toggle(G,p.revision,o.occurrenceId,false);
 let s=await f.rpc('snapshot',{discoverFiles:false});await assert.rejects(start([o.occurrenceId],s.basis),/disabled/);
 p=f.product.store.get(G)!;f.product.store.toggle(G,p.revision,o.occurrenceId,true);
 f.mem.values.delete(o.path);s=await f.rpc('snapshot');await assert.rejects(start([o.occurrenceId],s.basis),/missing/);
 assert.equal(f.calls(),0);assert.equal((f.product.store.db.prepare('SELECT count(*) n FROM mr_attempts').get() as any).n,0);
 }finally{await f.close();}
});
test('selected fixture keeps explicit project scope and cannot invoke an outside-project predicate',async()=>{
 const f=await setup();try{
 const o=f.s.project!.occurrences[0]!;
 f.mem.values.set(o.path,o.source!.replace('project_id: project','project_id: outside-project'));
 const current=await f.rpc('snapshot');
 const s=await f.rpc('startSuite',{requestId:'outside',basis:current.basis,hasRelevantDrafts:false,selectedOccurrenceIds:[o.occurrenceId]});
 await waitUntil(()=>!!f.product.store.run(s.run!.id)?.quiescent);
 const run=f.product.store.run(s.run!.id)!;assert.equal(run.frozen.denominator,1);assert.equal(run.results[0]!.evaluation!.groups!.find(g=>g.id===testGroup.id)!.status,'outside-scope');assert.equal(f.calls(),0);
 }finally{await f.close();}
});
test('selected Test cancellation and deadline retain the same paid attempt and refuse changed-selection replay',async()=>{
 for(const cancel of [true,false]){
 let entered=false,release!:()=>void;
 const f=await setup({transportFor:()=>async(wire,signal)=>{entered=true;await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return answer(wire);}});
 try{
 const selected=f.s.project!.occurrences[0]!.occurrenceId;
 const i={requestId:'held',basis:f.s.basis,hasRelevantDrafts:false,selectedOccurrenceIds:[selected]};
 const s=await f.rpc('startSuite',i);await waitUntil(()=>entered);
 if(cancel)await f.rpc('cancelSuite',{runId:s.run!.id});
 else await new Promise(resolve=>setTimeout(resolve,1100));
 await waitUntil(()=>!!f.product.store.run(s.run!.id)?.quiescent);
 const run=f.product.store.run(s.run!.id)!;assert.equal(run.frozen.denominator,1);assert.equal(run.status,'cancelled');
 if(!cancel)assert.match(run.error!,/time budget exhausted/);
 const attempts=f.product.store.db.prepare('SELECT * FROM mr_attempts WHERE run_id=?').all(run.id);assert.equal(attempts.length,1);
 await f.rpc('startSuite',i);assert.equal(f.product.store.db.prepare('SELECT * FROM mr_attempts WHERE run_id=?').all(run.id).length,1);
 await assert.rejects(f.rpc('startSuite',{...i,selectedOccurrenceIds:['changed']}),/different inputs/);
 }finally{release?.();await f.close();}
 }
});
