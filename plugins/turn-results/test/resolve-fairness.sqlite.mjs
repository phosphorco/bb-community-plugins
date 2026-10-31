import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createRegisteredHandlerRpc } from '@phosphorco/bb-turn-results/testing';
import { createResultsSupplierClient, registerTurnResultsParticipant, ResultsCallError } from '@phosphorco/bb-turn-results/bb';
import { canonicalJson, claimKey, buildResolveOutput, identityDigest } from '@phosphorco/bb-turn-results';
import galleryPlugin from '../server.ts';
import { createGalleryIndex } from '../gallery/index.ts';
import { consumeTurnSource } from '../gallery/consume.ts';
import { GALLERY_METHODS, PendingGallerySchema, PendingGalleryOutputSchema } from '../gallery/rpc.ts';
const signal = new AbortController().signal;
const anchor = { threadId: 'thread', turnId: 'turn', turnSeqStart: 1, turnSeqEnd: 100 };
const id = (seq, owner='source-a', suffix='') => ({ version: 1,
  ref: { source: { threadId: 'thread', turnId: 'turn', eventId: `event-${String(seq).padStart(3,'0')}${suffix}`, seq,
    itemId: `item-${seq}${suffix}`, eventType: 'item/completed' }, member: 'image:0', kind: `${owner}/image` },
  artifact: { provider: owner, id: `image-${seq}${suffix}`, kind: 'image' }, specificity: 'typed',
  evidence: { basis: 'native-completion', sites: [], targetUrls: [], selectedDigest: 'a'.repeat(64) }, lookup: { path: `/images/${seq}.png` } });
const resolved = identity => ({ identity, proof: { kind: 'native-image', source: identity.ref.source, selectedDigest: identity.evidence.selectedDigest },
  revision: { epoch: 'epoch', sequence: 1 }, knowledge: 'confirmed',
  outcomeEvidence: { kind: 'observation', id: identity.ref.source.eventId, digest: 'b'.repeat(64), recordedAt: 100 },
  availability: { state: 'available', asOf: 100, expiresAt: 500 }, route: { kind: 'source', ...identity.ref.source },
  provenance: { originHost: { state: 'unknown', reason: 'not-recorded' }, artifactLocation: { state: 'unknown', reason: 'not-recorded' } },
  fallback: { kind: 'image', title: 'Image', alt: 'Image' }, spans: { width: 1, height: 1 } });
// Route is a strict public union, not the whole native source ref.
const value = identity => { const r=resolved(identity); r.route={kind:'source',threadId:'thread',eventId:identity.ref.source.eventId,seq:identity.ref.source.seq}; return r; };
async function fixture(t, options={}) {
  let host=createFakePluginHost({pluginId:'turn-results'}); galleryPlugin(host.bb);
  const supplierHosts=[], calls=[];
  const rpc=(method,input)=>host.harness.behavior.callRpc(method,JSON.parse(canonicalJson(input,262144)));
  const backend={pending:input=>rpc(GALLERY_METHODS.pending,input),read:(threadId,turnId)=>rpc(GALLERY_METHODS.read,{threadId,turnId}),
    stage:(threadId,owner,id)=>rpc(GALLERY_METHODS.stage,{threadId,owner,id}),knownIdentities:(threadId,owner,refs)=>rpc(GALLERY_METHODS.known,{threadId,owner,refs}),
    async apply(page){ const result=await rpc(GALLERY_METHODS.apply,page); if(!['committed','unchanged'].includes(result.state)) throw Error(JSON.stringify(result)); }};
  async function supplier(owner, handler=async request=>buildResolveOutput(request,request.items.map(identity=>({state:'resolved',value:value(identity)})))) {
    const h=createFakePluginHost({pluginId:owner}); supplierHosts.push(h);
    registerTurnResultsParticipant(h.bb,{pluginId:owner,capabilities:{revision:'v1',supplier:{kinds:[{kind:`${owner}/image`,namespace:owner,neutralLabel:'Image',confirmedLabel:'Image',specificity:'typed',memberVersion:'v1',equivalenceNamespaces:[]}],recognize:false,resolve:true,enumerate:false}},
      async resolve(request,bounded){calls.push({owner,items:request.items});return handler(request,bounded);}});
    const client=createResultsSupplierClient({plugins:createRegisteredHandlerRpc(h,owner)},owner);
    const d=await client.describe();assert.equal(d.state,'ready');return {pluginId:owner,capabilities:d.capabilities,client};
  }
  async function seed(owner, identities){for(let n=0;n<identities.length;n+=8) await backend.apply({threadId:'thread',owner,changes:identities.slice(n,n+8).map(identity=>({kind:'candidate',identity}))});}
  const query=(owner,extra={})=>({threadId:'thread',owner,turnId:'turn',fromSeq:1,throughSeq:100,after:null,limit:8,...extra});
  const run=(source,b=backend,s=signal,a=anchor)=>consumeTurnSource(b,{async list(){throw Error('No recognition capability');}},source,a,s);
  const snapshot=()=>canonicalJson({meta:host.bb.storage.database().prepare('SELECT * FROM gallery_meta').all(),rows:host.bb.storage.database().prepare('SELECT * FROM gallery_records ORDER BY kind,record_key').all()},1048576);
  t.after(async()=>{for(const h of supplierHosts) await h.harness.lifecycle.dispose();await host.harness.lifecycle.dispose();});
  return {backend,rpc,supplier,seed,query,run,calls,snapshot,get db(){return host.bb.storage.database();},async reopen(){host=await host.harness.lifecycle.reload(galleryPlugin);}};
}
test('registered owner keyset traverses parked first8, resolves suffix and other owner, retains explicit debt after reopen',async t=>{
  const f=await fixture(t);await f.seed('source-b',Array.from({length:9},(_,n)=>id(n+1,'source-b')));
  await f.seed('source-a',Array.from({length:20},(_,n)=>id(n+1)));
  const a=await f.supplier('source-a',request=>buildResolveOutput(request,request.items.map(i=>i.ref.source.seq<=8?{state:'unavailable',reason:'source offline'}:{state:'resolved',value:value(i)})));
  const b=await f.supplier('source-b');
  const first=await f.run(a);assert.deepEqual(first,{continued:true,reason:'Traversed source claims remain unresolved.'});
  await f.reopen(); assert.equal((await f.run(a)).continued,true);
  const end=await f.run(a);assert.equal(end.continued,false);assert.ok(end.reason);
  assert.deepEqual(f.calls.filter(c=>c.owner==='source-a').map(c=>c.items.map(i=>i.ref.source.seq)),[Array.from({length:8},(_,n)=>n+1),Array.from({length:8},(_,n)=>n+9),[17,18,19,20]]);
  const remaining=await f.backend.pending(f.query('source-a'));assert.equal(remaining.rows.length,8);assert.equal(remaining.next,null);
  assert.equal((await f.backend.stage('thread','source-a','resolve:turn')).value.status,'parked');
  assert.equal((await f.run(b)).continued,true);assert.equal((await f.run(b)).continued,false);
  assert.equal((await f.backend.pending(f.query('source-b'))).rows.length,0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM gallery_records WHERE kind='claim' AND json_extract(payload_json,'$.unresolved')=0").get().n,21);
});
test('retryable batch fault traverses once and suffix makes finite progress without falsely resolving first8',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));
  const a=await f.supplier('source-a',request=>{if(request.items[0].ref.source.seq===1) throw Error('source batch offline');return buildResolveOutput(request,request.items.map(i=>({state:'resolved',value:value(i)})));});
  assert.equal((await f.run(a)).continued,true);assert.equal((await f.run(a)).continued,false);
  assert.equal(f.calls.length,2);assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,8);
});
for(const kind of ['incompatible','unauthorized','unknown-method','unknown-plugin','disabled','not-running']) test(`${kind} quarantines owner until revision/invalidation changes`,async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));const a=await f.supplier('source-a');let calls=0;
  const broken={...a,client:{...a.client,async resolve(){calls++;throw new ResultsCallError(kind);}}};
  assert.equal((await f.run(broken)).continued,false);assert.equal((await f.run(broken)).continued,false);assert.equal(calls,1);
  await f.backend.apply({threadId:'thread',owner:'source-a',changes:[],stage:{id:'source-invalidation',expectedVersion:null,value:{stage:'feed',cursor:null,status:'ready',debt:null}}});
  assert.equal((await f.run(a)).continued,true);assert.equal((await f.run(a)).continued,false);
  assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,0);
});
test('actual SQLite query is indexed SEARCH with no temporary ordering and stable equal-seq keys',async t=>{
  const f=await fixture(t);const identities=Array.from({length:12},(_,n)=>id(3,'source-a',`-${String(n).padStart(2,'0')}`));await f.seed('source-a',identities);
  const plan=f.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM gallery_records INDEXED BY gallery_pending_read WHERE kind='claim' AND json_extract(payload_json,'$.unresolved')=1 AND json_type(payload_json,'$.retracted')='null' AND thread_id=? AND owner=? AND turn_id=? AND (seq,record_key)>(?,?) AND seq<=? ORDER BY seq,record_key LIMIT ?`).all('thread','source-a','turn',3,claimKey('source-a',identities[0].ref),100,9);
  t.diagnostic(JSON.stringify(plan));assert.match(JSON.stringify(plan),/SEARCH.*gallery_pending_read/);assert.doesNotMatch(JSON.stringify(plan),/TEMP B-TREE/);
  const one=await f.backend.pending(f.query('source-a')),two=await f.backend.pending(f.query('source-a',{after:one.next}));
  assert.equal(one.rows.length,8);assert.equal(two.rows.length,4);assert.equal(two.next,null);
  assert.equal(new Set([...one.rows,...two.rows].map(i=>claimKey('source-a',i.ref))).size,12);
});
test('stage CAS refusal and apply fault do not advance traversal or outcomes; reopen retries original prefix',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));const a=await f.supplier('source-a');
  const before=f.snapshot();
  await assert.rejects(f.run(a,{...f.backend,async apply(){throw Error('injected backend fault');}}),/backend fault/);assert.equal(f.snapshot(),before);
  await f.backend.apply({threadId:'thread',owner:'source-a',changes:[],stage:{id:'resolve:turn',expectedVersion:null,value:{stage:'resolve',cursor:null,status:'ready',debt:null}}});
  const concurrent=f.snapshot();
  await assert.rejects(f.run(a,{...f.backend,stage:async(threadId,owner,id)=>id==='resolve:turn'?null:f.backend.stage(threadId,owner,id)}),/conflict/);assert.equal(f.snapshot(),concurrent);
  await f.reopen();await f.run(a);assert.deepEqual(f.calls.map(c=>c.items[0].ref.source.seq),[1,1,1]);
});
for(const kind of ['aborted','stale'])test(`${kind} propagates with no outcome or stage mutation`,async t=>{
  const f=await fixture(t);await f.seed('source-a',[id(1)]);const a=await f.supplier('source-a'),before=f.snapshot();
  await assert.rejects(f.run({...a,client:{...a.client,async resolve(){throw new ResultsCallError(kind);}}}));assert.equal(f.snapshot(),before);
});
test('abort-ignoring source cannot commit late outcome or traversal',async t=>{
  const f=await fixture(t);await f.seed('source-a',[id(1)]);const a=await f.supplier('source-a'),before=f.snapshot(),controller=new AbortController();let release;
  const work=f.run({...a,client:{...a.client,resolve:request=>new Promise(resolve=>{release=async()=>resolve(await buildResolveOutput(request,[{state:'resolved',value:value(request.items[0])}]));})}},f.backend,controller.signal);
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));controller.abort();await assert.rejects(work);await release();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(f.snapshot(),before);
});
test('foreign/out-of-range/duplicate/over-limit pending rows and mismatched continuation fail before source or stage',async t=>{
  const f=await fixture(t);await f.seed('source-a',[id(1)]);const a=await f.supplier('source-a'),before=f.snapshot();
  const foreign=structuredClone(id(1));foreign.ref.source.threadId='foreign';
  const wrongTurn=structuredClone(id(1));wrongTurn.ref.source.turnId='foreign';
  const foreignOwner=id(1,'source-b');
  for(const page of [{rows:[foreign],next:null},{rows:[foreignOwner],next:null},{rows:[wrongTurn],next:null},{rows:[id(101)],next:null},{rows:[id(1),id(1)],next:null},{rows:Array.from({length:9},(_,n)=>id(n+1)),next:null},{rows:[id(1)],next:{seq:2,key:'foreign'}},{rows:[],next:{seq:1,key:'x'}}]){
    await assert.rejects(f.run(a,{...f.backend,pending:async()=>page}));assert.equal(f.snapshot(),before);
  }assert.equal(f.calls.length,0);
});
test('malformed correlated output quarantines without applying any uncorrelated resolution',async t=>{
  const f=await fixture(t);await f.seed('source-a',[id(1)]);const a=await f.supplier('source-a');let count=0;
  const bad={...a,client:{...a.client,async resolve(request){count++;const output=await buildResolveOutput(request,[{state:'resolved',value:value(request.items[0])}]);output.resolutions[0].identityDigest='f'.repeat(64);return output;}}};
  assert.equal((await f.run(bad)).continued,false);assert.equal((await f.run(bad)).continued,false);assert.equal(count,1);assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,1);
});
test('pending private schemas/raw index enforce all input and output bounds',async t=>{
  const f=await fixture(t),q=f.query('source-a');const index=createGalleryIndex(f.db);
  for(const extra of [{limit:0},{limit:9},{fromSeq:-1},{throughSeq:0},{fromSeq:1.5},{throughSeq:Number.MAX_SAFE_INTEGER+1},{owner:'foreign/owner'},{extra:1},{after:{seq:0,key:'x'}},{after:{seq:101,key:'x'}},{after:{seq:1,key:'é'.repeat(513)}}]){
    assert.equal(PendingGallerySchema.safeParse({...q,...extra}).success,false);assert.throws(()=>index.readPending({...q,...extra}));
  }
  assert.throws(()=>index.readPending({...q,after:{seq:1,key:canonicalJson(['other','thread','e','m','k'])}}));
  assert.throws(()=>index.readPending({...q,after:{seq:1,key:'['}}));
  for(const key of [canonicalJson(['source-a','thread']),canonicalJson(['source-a','thread',2,3,4])])assert.throws(()=>index.readPending({...q,after:{seq:1,key}}));
  assert.equal(PendingGalleryOutputSchema.safeParse({rows:Array(9).fill(id(1)),next:null}).success,false);
  assert.equal(PendingGalleryOutputSchema.safeParse({rows:[],next:null,extra:'x'.repeat(65536)}).success,false);
  const huge=id(1);huge.lookup={huge:'x'.repeat(65536)};assert.equal(PendingGalleryOutputSchema.safeParse({rows:[huge],next:null}).success,false);
});
test('range/owner/turn scope change restarts pending cursor and absent adapter fails closed',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));const a=await f.supplier('source-a',request=>buildResolveOutput(request,request.items.map(()=>({state:'unavailable',reason:'offline'}))));
  await f.run(a);await f.run(a,f.backend,signal,{...anchor,turnSeqStart:2});assert.deepEqual(f.calls.map(c=>c.items[0].ref.source.seq),[1,2]);
  const before=f.snapshot();await assert.rejects(f.run(a,{...f.backend,pending:undefined}),/adapter/);assert.equal(f.snapshot(),before);
});
test('deferred batches split finitely, singleton admission and terminal oversized debt preserve healthy suffix',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:10},(_,n)=>id(n+1)));
  const a=await f.supplier('source-a',request=>buildResolveOutput(request,request.items.map(i=>({state:'resolved',value:{...value(i),enrichment:'x'.repeat(i.ref.source.seq===1?100000:i.ref.source.seq<=3?55000:0)}}))));
  let result,demands=0;do{result=await f.run(a);demands++;assert.ok(demands<=20,'bounded splitting must terminate');}while(result.continued);
  assert.ok(f.calls.some(c=>c.items.length===1),'singleton split is exercised');
  assert.equal((await f.backend.pending(f.query('source-a'))).rows[0].ref.source.seq,1);
  assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM gallery_records WHERE kind='claim' AND json_extract(payload_json,'$.unresolved')=0").get().n,9);
  // Oversized proposals remain pending; no stored result exceeds index row cap.
  assert.equal((await f.backend.stage('thread','source-a','resolve:turn')).value.status,'parked');assert.ok(result.reason);
});
test('existing schema partial-index upgrade validates physical cap/counters first and rolls back SQLite FULL without data or stage movement',async t=>{
  const f=await fixture(t);await f.seed('source-a',[id(1),id(2)]);
  await f.backend.apply({threadId:'thread',owner:'source-a',changes:[],stage:{id:'resolve:turn',expectedVersion:null,value:{stage:'resolve',cursor:null,status:'ready',debt:{sentinel:'kept'}}}});
  f.db.exec('DROP INDEX gallery_pending_read');f.db.exec('VACUUM');const before=f.snapshot(),pages=f.db.pragma('page_count',{simple:true});
  assert.throws(()=>createGalleryIndex(f.db,{maxPhysicalBytes:(pages-1)*4096}),/physical page cap/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='gallery_pending_read'").get().n,0);assert.equal(f.snapshot(),before);
  assert.throws(()=>createGalleryIndex(f.db,{maxPhysicalBytes:pages*4096}),/Pending index initialization rolled back/);
  assert.equal(f.db.inTransaction,false);assert.equal(f.snapshot(),before);assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='gallery_pending_read'").get().n,0);
  const restored=createGalleryIndex(f.db);assert.equal(restored.readPending(f.query('source-a')).rows.length,2);assert.equal(f.snapshot(),before);
  f.db.exec('DROP INDEX gallery_pending_read');f.db.prepare('UPDATE gallery_meta SET metadata_bytes=0').run();const corrupt=f.snapshot();
  assert.throws(()=>createGalleryIndex(f.db),/Invalid gallery counters/);assert.equal(f.snapshot(),corrupt);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='gallery_pending_read'").get().n,0);
});
test('pending filters retractions/resolved/foreign turn and range before LIMIT and handles empty/deleted scope',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));
  const a=await f.supplier('source-a');await f.run(a);
  const pending=await f.backend.pending(f.query('source-a',{fromSeq:10,throughSeq:11}));assert.deepEqual(pending.rows.map(i=>i.ref.source.seq),[10,11]);
  const other=id(1);other.ref.source.turnId='other-turn';other.ref.source.eventId='other';await f.seed('source-a',[other]);
  assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,4);
  const index=createGalleryIndex(f.db);assert.equal(index.deleteThread('thread',32).state,'committed');assert.deepEqual(index.readPending(f.query('source-a')),{rows:[],next:null});
});
test('real SQLite mid-commit fault rolls all resolutions/cursor/counters back and reopen recovers',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));const a=await f.supplier('source-a'),before=f.snapshot();
  f.db.exec("CREATE TRIGGER fairness_abort BEFORE UPDATE ON gallery_meta BEGIN SELECT RAISE(ABORT,'fairness injected fault'); END");
  await assert.rejects(f.run(a),/fairness injected fault/);assert.equal(f.snapshot(),before);assert.equal(f.db.inTransaction,false);
  f.db.exec('DROP TRIGGER fairness_abort');await f.reopen();assert.equal((await f.run(a)).continued,true);assert.equal((await f.run(a)).continued,false);
  assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,0);
});
test('stage cursor is reused only for exact owner/thread/turn/range and same revision',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));
  const a=await f.supplier('source-a',request=>buildResolveOutput(request,request.items.map(()=>({state:'unavailable',reason:'offline'}))));
  await f.run(a);const retained=await f.backend.stage('thread','source-a','resolve:turn');
  for(const changed of [{owner:'source-b'},{threadId:'other'},{turnId:'other'},{fromSeq:0},{throughSeq:101},{sourceRevision:'old'}]){
    const altered={...retained,value:{...retained.value,debt:{...retained.value.debt,...changed}}};
    await f.run(a,{...f.backend,stage:async(threadId,owner,id)=>id==='resolve:turn'?{...altered,version:(await f.backend.stage(threadId,owner,id)).version}:f.backend.stage(threadId,owner,id)});
    assert.equal(f.calls.at(-1).items[0].ref.source.seq,1);
  }
});
test('retracted pending rows do not consume owner page slots',async t=>{
  const f=await fixture(t),identities=Array.from({length:12},(_,n)=>id(n+1));await f.seed('source-a',identities);
  // Retractions must cite the previous retained evidence; resolve eight first.
  const a=await f.supplier('source-a');await f.run(a);
  await f.backend.apply({threadId:'thread',owner:'source-a',changes:identities.slice(0,8).map(identity=>({kind:'retract',ref:identity.ref,revision:{epoch:'epoch',sequence:2},supersedesEvidenceDigest:'b'.repeat(64),reason:'source correction'}))});
  const page=await f.backend.pending(f.query('source-a'));assert.deepEqual(page.rows.map(i=>i.ref.source.seq),[9,10,11,12]);
});
test('quarantine fences every source method on later demand; retryable fault does not invent connected freshness',async t=>{
  const f=await fixture(t);await f.seed('source-a',Array.from({length:12},(_,n)=>id(n+1)));const a=await f.supplier('source-a');let enumerations=0,resolves=0;
  const broken={...a,capabilities:{...a.capabilities,supplier:{...a.capabilities.supplier,enumerate:true}},client:{...a.client,
    async enumerate(){enumerations++;return {state:'page',epoch:'epoch',phase:'snapshot',throughRevision:0,rows:[],nextCursor:'next',settled:false,coverage:{retainedFrom:null,unplaced:0,complete:false}};},
    async resolve(){resolves++;throw new ResultsCallError('unauthorized');}}};
  assert.equal((await f.run(broken)).continued,false);assert.equal((await f.run(broken)).continued,false);assert.equal(enumerations,1);assert.equal(resolves,1);
  const other=await fixture(t);await other.seed('source-a',[id(1)]);const source=await other.supplier('source-a');
  await other.run({...source,client:{...source.client,async resolve(){throw new ResultsCallError('transport-error');}}});
  assert.equal(other.db.prepare("SELECT count(*) AS n FROM gallery_records WHERE kind='supplier'").get().n,0);
});

// RF1: SQLite BINARY compares UTF8 bytes; JavaScript string operators compare
// UTF16 units. These real retained identifiers deliberately reverse that order.
const unicodeIdentity = (eventId, seq=3) => {
  const identity=id(seq);identity.ref.source.eventId=eventId;return identity;
};
test('RF1 registered equal-seq upper-BMP then supplementary page resolves within-page and after reopen',async t=>{
  const f=await fixture(t),identities=[unicodeIdentity('event-\uE000'),unicodeIdentity('event-\u{10000}')];
  await f.seed('source-a',identities);const a=await f.supplier('source-a'),errors=[],before=f.snapshot();
  assert.deepEqual((await f.backend.pending(f.query('source-a'))).rows,identities);
  const low=claimKey('source-a',identities[0].ref),high=claimKey('source-a',identities[1].ref);
  assert.equal(high<=low,true,'witness must distinguish UTF16 from SQL BINARY');
  assert.ok(Buffer.compare(Buffer.from(low),Buffer.from(high))<0);
  for(let attempt=0;attempt<2;attempt++){
    if(attempt)await f.reopen();
    try { assert.equal((await f.run(a)).continued,false); }
    catch(error){ errors.push(error.message);assert.equal(f.calls.length,0);assert.equal(f.snapshot(),before); }
  }
  t.diagnostic(JSON.stringify({errors,resolveCalls:f.calls.length}));assert.deepEqual(errors,[]);
  assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].items,identities);
  assert.deepEqual(await f.backend.knownIdentities('thread','source-a',identities.map(i=>i.ref)),identities);
  assert.deepEqual(await f.backend.pending(f.query('source-a')),{rows:[],next:null});
});
for(const reopen of [false,true])test(`RF1 equal-seq Unicode cursor crosses real eight-row boundary reopen=${reopen}`,async t=>{
  const f=await fixture(t),identities=[...Array.from({length:7},(_,n)=>unicodeIdentity(`event-${n}`)),unicodeIdentity('event-\uE000'),unicodeIdentity('event-\u{10000}')];
  await f.seed('source-a',identities);
  const a=await f.supplier('source-a',request=>buildResolveOutput(request,request.items.map(i=>i.ref.source.eventId==='event-\u{10000}'?{state:'resolved',value:value(i)}:{state:'unavailable',reason:'Parked prefix'})));
  const page=await f.backend.pending(f.query('source-a'));assert.deepEqual(page.rows,identities.slice(0,8));
  assert.deepEqual(page.next,{seq:3,key:claimKey('source-a',identities[7].ref)});
  assert.equal((await f.run(a)).continued,true);const stage=await f.backend.stage('thread','source-a','resolve:turn');assert.deepEqual(stage.value.debt.after,page.next);
  if(reopen)await f.reopen();
  assert.deepEqual((await f.backend.pending(f.query('source-a',{after:page.next}))).rows,[identities[8]]);
  const result=await f.run(a);assert.equal(result.continued,false);assert.ok(result.reason);
  assert.deepEqual(f.calls.map(c=>c.items),[identities.slice(0,8),identities.slice(8)]);
  assert.equal((await f.backend.pending(f.query('source-a'))).rows.length,8);
  assert.deepEqual(await f.backend.knownIdentities('thread','source-a',identities.map(i=>i.ref).slice(0,8)),identities.slice(0,8));
  assert.deepEqual(await f.backend.knownIdentities('thread','source-a',[identities[8].ref]),[identities[8]]);
});
test('RF1 numeric sequence sorts before UTF8 keys; mixed ASCII/escaped/Unicode IDs retain exact identity',async t=>{
  const f=await fixture(t),identities=[unicodeIdentity('zz-event-\u{10000}',2),...['event-"','event-A','event-\\','event-~','event-e\u0301','event-\u00E9','event-\uE000','event-\u{10000}'].map(event=>unicodeIdentity(event))];
  const expected=[...identities].sort((a,b)=>a.ref.source.seq-b.ref.source.seq||Buffer.compare(Buffer.from(claimKey('source-a',a.ref)),Buffer.from(claimKey('source-a',b.ref))));
  await f.seed('source-a',identities);const a=await f.supplier('source-a');
  assert.equal((await f.run(a)).continued,true);await f.reopen();assert.equal((await f.run(a)).continued,false);
  assert.deepEqual(f.calls.flatMap(c=>c.items),expected);
  for(let n=0;n<identities.length;n+=8)assert.deepEqual(await f.backend.knownIdentities('thread','source-a',identities.slice(n,n+8).map(i=>i.ref)),identities.slice(n,n+8));
});
test('RF1 strict UTF8 duplicate/backward/foreign/scope/control negatives fail before source or stage progress',async t=>{
  const f=await fixture(t),low=unicodeIdentity('event-\uE000'),high=unicodeIdentity('event-\u{10000}');
  await f.seed('source-a',[low,high]);const a=await f.supplier('source-a'),before=f.snapshot();
  const foreign=structuredClone(high);foreign.ref.source.threadId='foreign';
  const wrongTurn=structuredClone(high);wrongTurn.ref.source.turnId='foreign';
  const wrongKind=unicodeIdentity('event-foreign');wrongKind.ref.kind='source-b/image';
  const control=unicodeIdentity('event-\u0000');
  for(const page of [{rows:[high,low],next:null},{rows:[low,low],next:null},{rows:[foreign],next:null},{rows:[wrongTurn],next:null},{rows:[wrongKind],next:null},{rows:[control],next:null},
    {rows:[low],next:{seq:3,key:claimKey('source-b',low.ref)}},{rows:[low],next:{seq:3,key:claimKey('source-a',high.ref)}}]){
    await assert.rejects(f.run(a,{...f.backend,pending:async()=>page}));assert.equal(f.snapshot(),before);
  }
  // Force a fully scoped retained continuation, then reject duplicate/backward
  // rows against its previous-page cursor (rather than only within one page).
  const originalStage=f.backend.stage;
  const scopedStage={version:1,value:{stage:'resolve',cursor:null,status:'ready',debt:{threadId:'thread',owner:'source-a',turnId:'turn',fromSeq:1,throughSeq:100,
    sourceRevision:'v1',invalidationVersion:null,after:{seq:3,key:claimKey('source-a',high.ref)},batch:8}}};
  for(const row of [low,high])await assert.rejects(f.run(a,{...f.backend,stage:(thread,owner,id)=>id==='resolve:turn'?Promise.resolve(scopedStage):originalStage(thread,owner,id),pending:async()=>({rows:[row],next:null})}));
  for(const eventId of ['event-\u0000','event-\n','event-\u007F'])await assert.rejects(f.seed('source-a',[unicodeIdentity(eventId)]));
  assert.equal(f.snapshot(),before);assert.equal(f.calls.length,0);
});
