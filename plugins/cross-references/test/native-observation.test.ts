import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate as tick } from 'node:timers/promises';
import { createBBSdk } from 'bb-app';
import Database from 'better-sqlite3';
import { AssistantLinkCollector } from '../assistant-link-collector.ts';
import { CrossReferenceStore, crossReferencesMigrations, enableForeignKeys } from '../store.ts';

// Use the installed production SDK and a real local WebSocket peer. Only its
// HTTP data ports are injected; subscribe/connection/dispatch are unmodified.
const { WebSocketServer } = createRequire(import.meta.url)('ws');
const source={provider:'bb',keys:{project:'proj_a',thread:'thr_a'}};
async function until(ready:()=>boolean):Promise<void> {
  const end=Date.now()+4000;
  while(!ready()){if(Date.now()>end)throw new Error('Native socket fixture did not reach its boundary');await tick();}
}
async function nativeFixture(t:TestContext,options:{holdUpgrade?:boolean;holdFirstPage?:boolean}={}) {
  const server=http.createServer();const wss=new WebSocketServer({noServer:true});
  let upgrade:(()=>void)|undefined,rawSocket:any,peer:any;const frames:any[]=[];
  server.on('upgrade',(request,socket,head)=>{
    rawSocket=socket;
    upgrade=()=>wss.handleUpgrade(request,socket,head,(ws:any)=>{peer=ws;wss.emit('connection',ws,request);});
    if(!options.holdUpgrade)upgrade();
  });
  wss.on('connection',(ws:any)=>ws.on('message',(raw:any)=>frames.push(JSON.parse(raw.toString()))));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  const sdk:any=createBBSdk({baseUrl:`http://127.0.0.1:${port}`,realtimeUrl:`ws://127.0.0.1:${port}/realtime`});
  const connections:any[]=[];
  const offConnection=sdk.subscribe({event:'realtime:connection',callback:(event:any)=>connections.push(event)});
  let changed=false,pages=0,firstSignal:AbortSignal|undefined,release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  sdk.plugins={list:async()=>({plugins:[]})};sdk.projects={get:async()=>({gitRemoteUrl:null})};
  sdk.threads={get:async({threadId}:any)=>({id:threadId,projectId:'proj_a',title:'Source'}),events:{list:async()=>[{seq:10}]},
    timeline:async({signal}:any)=>{
      const snapshot={maxSeq:10,contextBoundarySeq:null,rows:[{id:'m',threadId:'thr_a',sourceSeqStart:1,messageSeq:1,kind:'conversation',role:'assistant',createdAt:100,text:`https://example.test/${changed?'corrected':'original'}`}],timelinePage:{olderCursor:null}};
      pages++;if(pages===1 && options.holdFirstPage){firstSignal=signal;await held;}return snapshot;
    }};
  const db=new Database(':memory:');enableForeignKeys(db);for(const sql of crossReferencesMigrations)db.exec(sql);
  const store=new CrossReferenceStore(db);
  const collector=new AssistantLinkCollector({sdk,server:{experimental_appUrl:'https://bb.test'},log:{warn:()=>{}}} as any,db,store,()=>{});
  let idle=0;const waiters=new Map<number,()=>void>();
  const atIdle=(n:number)=>idle>=n?Promise.resolve():new Promise<void>(resolve=>waiters.set(n,resolve));
  const process=collector.processNext.bind(collector);
  collector.processNext=async signal=>{const worked=await process(signal);if(!worked){idle++;waiters.get(idle)?.();}return worked;};
  const abort=new AbortController();let running:Promise<void>|undefined;const offs:Array<()=>void>=[];
  t.after(async()=>{
    abort.abort();release();await running;collector.dispose();for(const off of offs)off();offConnection();db.close();
    for(const ws of wss.clients)ws.terminate();rawSocket?.destroy();wss.close();await new Promise<void>(resolve=>server.close(()=>resolve()));
  });
  return {db,collector,sdk,frames,connections,atIdle,release,
    start(){collector.enqueue('proj_a','thr_a');running=collector.start(abort.signal);},
    change(){changed=true;},disconnect(){peer.terminate();},open(){assert.ok(upgrade);upgrade();},hasUpgrade:()=>!!upgrade,
    firstSignal:()=>firstSignal,pages:()=>pages,
    hrefs:()=>store.listForwardReferences({source}).rows.map(row=>row.target.keys.href),
    async deliverAppend(){
      let delivered!:()=>void;const notification=new Promise<void>(resolve=>{delivered=resolve;});
      offs.push(sdk.subscribe({event:'thread:changed',threadId:'thr_a',callback:()=>delivered()}));
      await until(()=>frames.some(frame=>frame.type==='subscribe'&&frame.target.kind==='thread-detail'));
      peer.send(JSON.stringify({type:'changed',entity:'thread',id:'thr_a',changes:['events-appended'],metadata:{timelineSequence:10}}));
      await notification;
    }};
}

test('native initial connection gap cannot admit an equal-sequence body cache', {timeout:8000}, async t=>{
  const f=await nativeFixture(t,{holdUpgrade:true});f.start();await f.atIdle(1);await until(f.hasUpgrade);
  f.change();f.collector.enqueue('proj_a','thr_a',false,true);await f.atIdle(2);
  assert.deepEqual(f.hrefs(),['https://example.test/corrected'],'missing socket observations require a native timeline witness/fallback');
  f.open();await until(()=>f.frames.some(frame=>frame.type==='subscribe'&&frame.target.kind==='thread-detail'));
  assert.ok(f.connections.some(event=>event.state==='connected'&&event.reconnected===false));
  f.collector.enqueue('proj_a','thr_a',false,true);await f.atIdle(3);
  assert.deepEqual(f.hrefs(),['https://example.test/corrected']);assert.equal(f.pages(),3);
});

test('native same-sequence event before checkpoint persistence aborts old I/O and owns a successor', {timeout:8000},async t=>{
  const f=await nativeFixture(t,{holdFirstPage:true});f.start();await until(()=>!!f.firstSignal());
  assert.equal(f.db.prepare('SELECT 1 FROM assistant_link_checkpoints').get(),undefined);
  f.change();await f.deliverAppend();
  assert.equal(f.firstSignal()!.aborted,true,'actual SDK dispatch must fence the response before any checkpoint exists');
  const job=f.db.prepare('SELECT version FROM assistant_link_jobs').get() as {version:number};assert.equal(job.version,2);
  f.release();await f.atIdle(1);
  assert.deepEqual(f.hrefs(),['https://example.test/corrected'],'the durable successor repairs without another view request');
  f.collector.enqueue('proj_a','thr_a',false,true);await f.atIdle(2);assert.deepEqual(f.hrefs(),['https://example.test/corrected']);
});


test('native disconnected interval requires a timeline witness before body reuse', {timeout:8000},async t=>{
  const f=await nativeFixture(t);f.start();await f.atIdle(1);
  await until(()=>f.frames.some(frame=>frame.type==='subscribe'&&frame.target.kind==='thread-detail'));
  f.disconnect();await until(()=>f.connections.some(event=>event.state==='disconnected'));
  f.change();f.collector.enqueue('proj_a','thr_a',false,true);await f.atIdle(2);
  assert.deepEqual(f.hrefs(),['https://example.test/corrected']);assert.equal(f.pages(),2);
});

test('a native sent detail frame is not a server observation receipt', {timeout:8000},async t=>{
  const f=await nativeFixture(t);f.start();await f.atIdle(1);
  await until(()=>f.frames.some(frame=>frame.type==='subscribe'&&frame.target.kind==='thread-detail'));
  // No acknowledgement or replay exists for the interval around adding this
  // detail target. Only the following HTTP delta/full response can certify it.
  f.change();f.collector.enqueue('proj_a','thr_a',false,true);await f.atIdle(2);
  assert.deepEqual(f.hrefs(),['https://example.test/corrected']);assert.equal(f.pages(),2);
});
