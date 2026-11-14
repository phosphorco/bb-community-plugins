import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBBSdk} from 'bb-app';
import Database from 'better-sqlite3';
import {AssistantLinkCollector} from '../assistant-link-collector.ts';
import {CrossReferenceStore,crossReferencesMigrations,enableForeignKeys} from '../store.ts';
import {threadResource} from '../canonical.ts';

// Captured REAL native DB/projection transcript:101 completed turns, seq505.
// A fresh native window service loses its old floor; another client warms the
// corrected window and afterSequence505 returns an empty delta against itself.
// This portable replay uses real plugin SQLite/reopen and the installed SDK's
// HTTP query path. Subscriptions are injected; no native server is launched.
const native=JSON.parse(readFileSync(new URL('./fixtures/native-restart-partial.responses.json',import.meta.url),'utf8'));
test('startup discards process-old partial inputs despite a newly warmed native same-sequence delta',{timeout:10000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'cross-native-restart-'));const path=join(dir,'queue.sqlite');
 let restarted=false;const requests:Array<{after:string|null;older:boolean}>=[];
 function open(migrate:boolean){const db=new Database(path);db.pragma('journal_mode=WAL');enableForeignKeys(db);if(migrate)for(const sql of crossReferencesMigrations)db.exec(sql);return db;}
 function make(db:Database.Database){
  const sdk:any=createBBSdk({baseUrl:'http://native-restart.fixture',fetch:async(input:any)=>{
   const url=new URL(typeof input==='string'?input:input.url),after=url.searchParams.get('afterSequence'),older=!!url.searchParams.get('beforeAnchorId');
   requests.push({after,older});const value=older?native.older:restarted?(after?native.witness:native.warm):native.original;
   return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  }});
  sdk.subscribe=()=>()=>{};sdk.threads.get=async()=>({id:native.threadId,projectId:native.projectId,title:'Restart proof'});
  sdk.plugins={list:async()=>({plugins:[]})};sdk.projects={get:async()=>({gitRemoteUrl:null})};
  const store=new CrossReferenceStore(db),collector=new AssistantLinkCollector({sdk,server:{experimental_appUrl:'https://bb.test'},log:{warn:()=>{}}} as any,db,store,()=>{});
  return {store,collector};
 }
 const identity={provider:'bb',keys:{project:native.projectId,thread:native.threadId}};
 let db=open(true),f=make(db);let running:Promise<void>|undefined;const abort=new AbortController();
 t.after(async()=>{abort.abort();await running;f.collector.dispose();if(db.open)db.close();rmSync(dir,{recursive:true,force:true});});
 f.store.replaceConversationMentions(threadResource(native.projectId,native.threadId,{label:'Restart proof'}),{occurrences:[],observedMessageIds:[],scannedMessageIds:[],failedSuppliers:[],discoveryIncomplete:false,coverage:{timelineComplete:true,reasons:[],retentionLimited:false}});
 f.collector.enqueue(native.projectId,native.threadId);await f.collector.processNext(new AbortController().signal);
 assert.equal(native.original.rows.length,200);assert.equal(native.original.maxSeq,505);assert.deepEqual(native.witness.delta,{upsertRows:[]});
 assert.equal(JSON.parse((db.prepare('SELECT state_json FROM assistant_link_checkpoints').get() as any).state_json).ready,false);
 db.prepare('UPDATE assistant_link_jobs SET version=7,attempts=3,priority=2,retry_at=?').run(Date.now()+60000);
 db.prepare("INSERT INTO assistant_link_recognition_cache VALUES (?, '[]', 2, 0)").run('0'.repeat(64));
 const intent=db.prepare('SELECT * FROM assistant_link_jobs').get(),graph=f.store.getProjection({producerPluginId:'cross-references',source:identity}),evidence=f.store.mentionState(identity);
 f.collector.dispose();db.close();restarted=true;requests.length=0;db=open(false);f=make(db);
 let idle=0;const waiters=new Map<number,()=>void>(),atIdle=(n:number)=>idle>=n?Promise.resolve():new Promise<void>(resolve=>waiters.set(n,resolve));
 const process=f.collector.processNext.bind(f.collector);f.collector.processNext=async signal=>{const worked=await process(signal);if(!worked){idle++;waiters.get(idle)?.();}return worked;};
 running=f.collector.start(abort.signal);await atIdle(1);
 assert.deepEqual(db.prepare('SELECT * FROM assistant_link_jobs').get(),intent,'startup preserves version/attempts/priority/backoff');
 assert.deepEqual(f.store.getProjection({producerPluginId:'cross-references',source:identity}),graph);assert.deepEqual(f.store.mentionState(identity),evidence);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM assistant_link_recognition_cache').get() as any).n,1);
 const oldInputsAfterStart=(db.prepare('SELECT COUNT(*) n FROM assistant_link_checkpoints').get() as any).n;
 db.prepare('UPDATE assistant_link_jobs SET retry_at=0').run();f.collector.enqueue(native.projectId,native.threadId,false,false,2);await atIdle(2);
 assert.deepEqual(f.store.listForwardReferences({source:identity}).rows.map(r=>r.target.keys.href),['https://example.test/corrected']);
 assert.equal(oldInputsAfterStart,0);assert.equal(requests[0]!.after,null,'a prior-process partial must not request an empty native delta');
 assert.equal(f.store.mentionState(identity).coverage?.timelineComplete,true);
});
