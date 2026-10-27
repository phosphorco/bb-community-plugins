import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {registerRecognitionSupplier} from '@phosphorco/bb-context-recognition/bb';
import {recognitionIdentity} from '@phosphorco/bb-cross-references';
import {collectConversationMentions} from '../mention-collection.ts';
import {AssistantLinkCollector} from '../assistant-link-collector.ts';
import {CrossReferenceStore,crossReferencesMigrations,enableForeignKeys} from '../store.ts';
import {canonicalizeResource,threadResource,projectionPayloadDigest,projectionPayloadJson,MAX_PROJECTION_PAYLOAD_BYTES} from '../canonical.ts';
import {MENTION_LIMITS,type MentionScan} from '../mention-evidence.ts';
import fileHostEntry from '../mention-file-host.ts';
import {MentionDiagnostics} from '../mention-file-contract.ts';
import {mentionFrame} from '../mention-markdown.ts';

const source=threadResource('proj_a','thr_source',{label:'Source',url:'/projects/proj_a/threads/thr_source'});
const sourceId={provider:source.provider,keys:source.keys};
const thread='thr_23456789ab';
const pr='https://github.com/owner/repo/pull/42';
const typed={provider:'github',id:'github.com/owner/repo#42',kind:'pull-request'};
const row=(id:string,text:string,role='assistant',extra:Record<string,unknown>={})=>({id,threadId:'thr_source',kind:'conversation',role,text,createdAt:Number(id.replace(/\D/g,''))||100,messageSeq:17,sourceSeqStart:21,sourceSeqEnd:29,initiator:'user',systemMessageKind:'unlabeled',...extra});
function open(path=':memory:',migrate=true){const db=new Database(path);enableForeignKeys(db);if(migrate)for(const m of crossReferencesMigrations)db.exec(m);return {db,store:new CrossReferenceStore(db)};}
function fixture(db:Database.Database,store:CrossReferenceStore,initial:any[]=[]){
 const state={rows:initial,plugins:[] as string[],fail:false,malformed:false,oversized:false,calls:0,lists:0,pages:0,partial:false,logs:[] as string[]};
 const handlers=new Map<string,Record<string,(input:any)=>any>>();
 for(const pluginId of ['typed-a','typed-b']){
  registerRecognitionSupplier({rpc:{register(_schemas:any,impl:any){handlers.set(pluginId,impl);}}} as any,{revision:'fixture/1',linkify:{providers:[{provider:'github',kinds:['pull-request']}],handler(input){
   state.calls++;if(state.fail && pluginId==='typed-a')throw new Error('supplier offline');
   if(state.malformed)return {candidates:[{bad:true}]} as any;
   if(state.oversized)return {candidates:[],padding:'x'.repeat(70_000)} as any;
   const candidates=[];
   for(const token of [pr,'owner/repo#42','#42']){
    let at=input.text.indexOf(token);
    while(at>=0){if(!input.excluded.some(s=>s.start<at+token.length&&at<s.end))candidates.push({span:{start:at,end:at+token.length},match:token,source:typed,confidence:'high' as const,provenance:{basis:'explicit' as const,explanation:'Fixture supplier.'}});at=input.text.indexOf(token,at+token.length);}
   }
   candidates.sort((a,b)=>a.span.start-b.span.start||a.span.end-b.span.end);
   return {candidates:candidates.slice(0,64)};
  }}});
 }
 const bb={sdk:{plugins:{list:async()=>{state.lists++;return {plugins:state.plugins.map(id=>({id,status:'running',name:id}))};},callRpc:async({pluginId,method,input}:any)=>handlers.get(pluginId)![method]!(input)},
  projects:{get:async()=>({gitRemoteUrl:'https://user:secret@github.com/owner/repo.git?token=secret'})},
  threads:{get:async({threadId}:any)=>({id:threadId,projectId:'proj_a',title:'Source'}),timeline:async()=>({rows:state.rows,timelinePage:{olderCursor:state.partial?{anchorSeq:++state.pages,anchorId:`page_${state.pages}`} : null}})}},
  server:{experimental_appUrl:'https://bb.test'},log:{warn:(message:string)=>state.logs.push(message)}} as any;
 const signals:any[]=[];
 const collector=new AssistantLinkCollector(bb,db,store,s=>signals.push(s));
 const scan=async()=>{collector.enqueue('proj_a','thr_source',false,true);assert.equal(await collector.processNext(new AbortController().signal),true);return store.mentionState(sourceId);};
 return {state,collector,scan,signals,bb};
}

test('actual collector: native mentions create one backlink with repeated durable locations and exact actual role/messageSeq',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const f=fixture(db,store,[row('msg1',`😀 @thread:${thread} and ${thread}`,'user',{initiator:'agent',senderThreadId:'thr_relay'}),row('msg2',`@thread:${thread}`)]);
 const result=await f.scan();
 assert.equal(store.listBacklinks({target:{provider:'bb',keys:{project:'proj_a',thread}}}).total,1);
 assert.equal(store.listForwardReferences({source:sourceId}).total,1);
 assert.equal(result.occurrences.length,3);assert.equal(f.state.lists,1);
 const first=result.occurrences.find(o=>o.span.start===3)!;assert.equal(first.locator.role,'user');assert.equal(first.locator.messageSeq,17);assert.equal(first.locator.anchorSeq,21);
 assert.equal(first.provenance.source.id,thread);
 assert.equal(f.state.rows[0].text.slice(first.span.start,first.span.end),`@thread:${thread}`);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM reference_occurrences').get() as any).n,1);
 f.state.rows=[row('msg1',`extra 😀 @thread:${thread} and ${thread}`,'user',{initiator:'agent'}),row('msg2',`@thread:${thread}`)];
 const graph=store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!;
 const next=await f.scan();assert.ok(next.revision>result.revision);
 assert.equal(store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!.revision,graph.revision);
 assert.equal(store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!.payloadDigest,graph.payloadDigest);
 const same=await f.scan();assert.equal(same.revision,next.revision);assert.equal(same.digest,next.digest);
});

test('actual collector verifies explicit prose thread routes without changing plain IDs or safe URL fallback',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const missing='thr_23456789ac';
 const route=`/projects/proj_a/threads/${thread}`;
 const wrong=`/projects/proj_wrong/threads/${thread}`;
 const unresolved=`/projects/proj_a/threads/${missing}`;
 const texts=[wrong,`https://bb.test${wrong}`,route,`https://bb.test${route}`,
  `@thread:${thread}`,thread,unresolved,`https://bb.test${unresolved}`];
 const f=fixture(db,store,texts.map((text,i)=>row(`msg${i+1}`,text)));
 const get=f.bb.sdk.threads.get;
 f.bb.sdk.threads.get=async(args:any)=>{
  if(args.threadId===missing)throw Object.assign(new Error('missing thread'),{status:404});
  return get(args);
 };
 const result=await f.scan();
 assert.equal(result.coverage!.timelineComplete,true);assert.deepEqual(result.coverage!.reasons,[]);
 assert.deepEqual(result.occurrences.map(o=>o.locator.messageId).sort(),['msg2','msg3','msg4','msg5','msg6','msg8']);
 const native=result.occurrences.filter(o=>o.target.provider==='bb');
 assert.deepEqual(native.map(o=>o.locator.messageId).sort(),['msg3','msg4','msg5','msg6']);
 assert.ok(native.every(o=>o.target.keys.project==='proj_a' && o.target.keys.thread===thread));
 assert.equal(native.find(o=>o.locator.messageId==='msg3')!.provenance.authoredHref,route);
 assert.equal(native.find(o=>o.locator.messageId==='msg4')!.provenance.authoredHref,`https://bb.test${route}`);
 assert.ok(native.filter(o=>['msg5','msg6'].includes(o.locator.messageId)).every(o=>o.provenance.authoredHref===undefined));
 const generic=result.occurrences.filter(o=>o.target.provider==='url');
 assert.deepEqual(generic.map(o=>o.target.keys.href).sort(),[`https://bb.test${wrong}`,`https://bb.test${unresolved}`].sort());
 assert.equal(store.listBacklinks({target:{provider:'bb',keys:{project:'proj_a',thread}}}).total,1);
 assert.equal(store.listBacklinks({target:{provider:'bb',keys:{project:'proj_wrong',thread}}}).total,0);
 assert.equal(store.listForwardReferences({source:sourceId}).total,3);
 for(const mention of result.occurrences){
  const text=texts[Number(mention.locator.messageId.slice(3))-1]!;
  assert.equal(text.slice(mention.span.start,mention.span.end),text);
 }
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
});

test('Markdown grammar excludes code, images, linked images, HTML; preserves nested markup and Unicode spans',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const text=`😀 [visible](${pr})\n\n> *owner/repo#42* and #42\n\n\`#42\`\n\n    ${pr}\n\n\`\`\`\n#42\n\`\`\`\n\n![standalone](${pr}) [![linked](https://image.test/i)](${pr})\n\n<span>#42 [hidden](${pr})</span>\n\n\\#42`;
 const f=fixture(db,store,[row('msg1',text)]);f.state.plugins=['typed-a'];
 const result=await f.scan();assert.equal(result.occurrences.length,3);
 assert.equal(store.listBacklinks({target:recognitionIdentity(typed)}).total,1);
 assert.ok(result.occurrences.every(o=>o.target.provider==='recognition'));
 const spans=result.occurrences.map(o=>text.slice(o.span.start,o.span.end));
 assert.deepEqual(spans.sort(),['#42','owner/repo#42',`[visible](${pr})`].sort());
 assert.ok(result.occurrences.find(o=>o.provenance.authoredHref===pr));
 const frame=mentionFrame('![image](https://a.test) [![x](https://b.test)](https://c.test)');assert.equal(frame.links.length,0);
});

test('zero/one/multiple/failed suppliers are isolated; typed upgrade replaces only observed generic claim',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const f=fixture(db,store,[row('msg1',pr),row('msg2',pr)]);
 let result=await f.scan();assert.equal(result.occurrences.length,2);assert.equal(result.occurrences[0]!.target.provider,'url');
 f.state.plugins=['typed-a','typed-b'];f.collector.invalidateSuppliers();f.state.rows=[row('msg2',pr)];f.state.partial=true;
 result=await f.scan();assert.equal(result.occurrences.length,2);
 assert.equal(result.occurrences.filter(o=>o.target.provider==='recognition').length,1);
 assert.equal(result.occurrences.filter(o=>o.target.provider==='url' && !o.confirmed).length,1);
 assert.equal(store.listForwardReferences({source:sourceId}).total,2); // unvisited URL claim is not historically aliased
 f.state.partial=false;f.state.rows=[row('msg2',`${pr} and #42`),row('msg3','owner/repo#42')];
 result=await f.scan();assert.equal(result.occurrences.length,3);assert.equal(store.listForwardReferences({source:sourceId}).total,1);
 f.state.plugins=['typed-a'];f.state.fail=true;f.collector.invalidateSuppliers();
 result=await f.scan();assert.equal(result.occurrences.length,3);assert.ok(result.occurrences.every(o=>!o.confirmed));assert.ok(result.coverage!.reasons.includes('supplier-failure'));
 // Authoritative supplier removal admits the native URL floor and retires typed observations.
 f.state.plugins=[];f.collector.invalidateSuppliers();result=await f.scan();assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0]!.target.provider,'url');
});

test('malformed/oversize supplier results cannot bypass validation, URL policy or native floor',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const f=fixture(db,store,[row('msg1',`${pr} [secret](https://example.test/?token=secret) [unsafe](javascript:alert) <https://user:secret@example.test/a>`) ]);
 f.state.plugins=['typed-a'];f.state.malformed=true;
 let result=await f.scan();assert.equal(result.occurrences.length,2);assert.ok(result.occurrences.every(o=>o.target.provider==='url'));
 assert.ok(!JSON.stringify(result).includes('token=secret'));assert.ok(!JSON.stringify(result).includes('user:secret'));
 f.state.malformed=false;f.state.oversized=true;f.collector.invalidateSuppliers();
 result=await f.scan();assert.ok(result.coverage!.reasons.includes('supplier-failure'));assert.ok(result.occurrences.every(o=>o.target.provider==='url'));
});

test('eligibility excludes native system notifications/tools/nested; relayed ordinary user text survives',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const f=fixture(db,store,[row('msg1',pr,'user',{initiator:'agent',senderThreadId:'thr_relay'}),
  row('msg2',pr,'user',{initiator:'system'}),row('msg3',pr,'user',{systemMessageKind:'child-completed'}),
  row('msg4',pr,'user',{systemMessageKind:'tool-result-delivered'}),row('msg5',pr,'user',{systemMessageKind:'ownership-assigned'}),
  row('msg6',pr,'tool'),row('msg7',pr,'assistant',{kind:'work'}),row('msg8',pr,'assistant',{threadId:'thr_nested'})]);
 const result=await f.scan();assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0]!.locator.messageId,'msg1');
});

test('partial scans remove only fully observed messages; missing sequence and text bounds retain prior evidence',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store,[row('msg1',pr),row('msg2',pr)]);
 await f.scan();f.state.rows=[row('msg2','removed')];f.state.partial=true;
 let result=await f.scan();assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0]!.locator.messageId,'msg1');assert.equal(result.occurrences[0]!.confirmed,false);
 f.state.partial=false;f.state.rows=[row('msg1',pr,'assistant',{messageSeq:undefined})];result=await f.scan();assert.equal(result.occurrences.length,1);assert.ok(result.coverage!.reasons.includes('missing-message-seq'));
 f.state.rows=[row('msg1','x'.repeat(MENTION_LIMITS.messageChars+1))];result=await f.scan();assert.equal(result.occurrences.length,1);assert.ok(result.coverage!.reasons.includes('source-text-budget'));
 f.state.rows=[];result=await f.scan();assert.equal(result.occurrences.length,0);
});

test('newest 100 per edge survive real SQLite reopen; location-only changes leave v1 graph stable',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mention-reopen-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'db.sqlite');
 const initial=open(path);const f=fixture(initial.db,initial.store,Array.from({length:105},(_,i)=>row(`msg${i+1}`,pr)));
 const state=await f.scan();assert.equal(state.occurrences.length,100);assert.equal(state.coverage!.retentionLimited,true);
 const graph=initial.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!;
 f.collector.enqueue('proj_a','thr_source',false,true);initial.db.close();
 const reopened=open(path,false);t.after(()=>reopened.db.close());
 assert.deepEqual(reopened.store.mentionState(sourceId),state);
 const f2=fixture(reopened.db,reopened.store,Array.from({length:105},(_,i)=>row(`msg${i+1}`,`prefix ${pr}`)));
 await f2.collector.processNext(new AbortController().signal);
 assert.ok(reopened.store.mentionState(sourceId).revision>state.revision);
 assert.equal(reopened.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!.payloadDigest,graph.payloadDigest);
 assert.equal((reopened.db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
});

test('generation fences abort/stale supplier scans before either evidence or graph can commit',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store,[row('msg1',pr)]);
 await f.scan();const before=store.mentionState(sourceId);const graph=store.getProjection({producerPluginId:'cross-references',source:sourceId});
 let release!:(v:any)=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 f.bb.sdk.threads.timeline=()=>{entered();return new Promise(r=>release=r);};
 f.collector.enqueue('proj_a','thr_source',false,true);const controller=new AbortController();const pending=f.collector.processNext(controller.signal);await started;
 f.collector.invalidateSuppliers();controller.abort();release({rows:[],timelinePage:{olderCursor:null}});await pending;
 assert.deepEqual(store.mentionState(sourceId),before);assert.deepEqual(store.getProjection({producerPluginId:'cross-references',source:sourceId}),graph);
 assert.ok(db.prepare('SELECT 1 FROM assistant_link_jobs').get());
});

test('legacy and independent producer claims survive native withdrawal; source tombstone clears native locations',async t=>{
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store,[row('msg1',pr)]);await f.scan();
 const target=store.listForwardReferences({source:sourceId}).rows[0]!.target;
 for(const producerPluginId of ['thread-links','external'])store.applyProjection({protocolVersion:1,producerPluginId,source,
  mutationId:'00000000-0000-4000-8000-000000000001',revision:1,expectedRevision:0,tombstone:false,targets:[target],
  payloadDigest:projectionPayloadDigest(producerPluginId,canonicalizeResource(source),false,[canonicalizeResource(target)])});
 f.state.rows=[];assert.equal((await f.scan()).occurrences.length,0);assert.equal(store.listForwardReferences({source:sourceId}).total,1);
 f.collector.enqueue('proj_a','thr_source',true,true);await f.collector.processNext(new AbortController().signal);
 assert.equal(store.mentionState(sourceId).occurrences.length,0);
 assert.equal(store.getProjection({producerPluginId:'thread-links',source:sourceId}).projection!.tombstone,true);
 assert.equal(store.getProjection({producerPluginId:'external',source:sourceId}).projection!.tombstone,false);
});


test('actual collector rejects sensitive root-relative destinations before native/typed admission and keeps safe authored routes',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const route=`/projects/proj_a/threads/${thread}`;
 const safe=`${route}?view=full#msg=17`;
 const sensitive=[`${route}?token=secret-query`,`${route}#sig=secret-fragment`,
  `${route}?access_token=secret-access#msg=17`,`${route}#TOKEN=secret-case`,
  `/plans/x.plan.pkl?token=secret-typed`];
 const f=fixture(db,store,[row('msg1',[...sensitive.map(href=>`[blocked](${href})`),`[safe](${safe})`].join('\n'))]);
 f.state.plugins=['typed-a'];
 const callRpc=f.bb.sdk.plugins.callRpc;
 f.bb.sdk.plugins.callRpc=async(args:any)=>{
  if(args.method==='contextRecognitionV1Linkify')assert.ok(!args.input.text.includes('secret-'),args.input.text);
  return callRpc(args);
 };
 const result=await f.scan();
 assert.equal(result.occurrences.length,1);
 const mention=result.occurrences[0]!;
 assert.equal(mention.target.provider,'bb');assert.equal(mention.target.keys.thread,thread);
 assert.equal(mention.provenance.authoredHref,safe);
 assert.equal(mention.target.presentation.url,route);
 assert.ok(!JSON.stringify(result).includes('secret-'));
 assert.equal(store.listBacklinks({target:{provider:'bb',keys:{project:'proj_a',thread}}}).total,1);
 f.state.plugins=[];f.collector.invalidateSuppliers();
 f.state.rows=[row('msg2',`${route}?token=secret-prose\n${route}#sig=secret-prose-fragment`)];
 const prose=await f.scan();assert.equal(prose.occurrences.length,0);
 assert.ok(!JSON.stringify(prose).includes('secret-prose'));
});

test('actual collector bounds large blank/excluded-prefix windows, preserves Unicode offsets and retains unvisited evidence',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const f=fixture(db,store,[row('msg1',pr)]);await f.scan();
 const blankPrefix='\n'.repeat(70_000);
 const visible=`😀 @thread:${thread}`;
 const content=blankPrefix+visible;
 f.state.rows=[row('msg1',content)];
 let result=await f.scan();
 assert.ok(result.coverage!.reasons.includes('message-window-budget'));
 assert.ok(result.occurrences.some(o=>!o.confirmed && o.target.provider==='url'));
 const native=result.occurrences.find(o=>o.target.provider==='bb')!;
 assert.equal(native.span.start,blankPrefix.length+3);
 assert.equal(content.slice(native.span.start,native.span.end),`@thread:${thread}`);
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
 assert.ok(mentionFrame(content).windows.every(w=>w.end-w.start<=65_536));
 const codePrefix='```\n'+'x'.repeat(70_000)+'\n```\n\n';
 f.state.rows=[row('msg1',codePrefix+visible)];result=await f.scan();
 const codeNative=result.occurrences.find(o=>o.confirmed && o.target.provider==='bb')!;
 assert.equal(codeNative.span.start,codePrefix.length+3);
 assert.equal((codePrefix+visible).slice(codeNative.span.start,codeNative.span.end),`@thread:${thread}`);
 assert.ok(result.coverage!.reasons.includes('message-window-budget'));
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
 f.state.rows=[row('msg1',blankPrefix+'hello')];result=await f.scan();
 assert.ok(result.coverage!.reasons.includes('message-window-budget'));
 assert.equal((db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
});


test('native verification shares source deadline, bounds an uncooperative wait and retains unvisited prior evidence',async t=>{
 const {db,store}=open();t.after(()=>db.close());
 const chars='23456789abcdefghijkmnpqrstuvwxyz';
 const ids=Array.from({length:26},(_,i)=>'thr_23456789a'+chars[i]);
 const text=ids.map(id=>'@thread:'+id).join(' ');
 const f=fixture(db,store,[row('msg1',text)]);await f.scan();
 let clock=0,calls=0,secondAborted=false;
 t.mock.method(performance,'now',()=>clock);
 const scan=await collectConversationMentions({messages:[{id:'msg1',text,createdAt:1,messageSeq:17,anchorSeq:21,role:'assistant'}],
  context:{consumer:{pluginId:'cross-references'},projectId:'proj_a',threadId:'thr_source',links:[]},clients:[],
  getThread:async(id,signal)=>{
    calls++;
    if(calls===1){clock=MENTION_LIMITS.sourceMs-15;return {id,projectId:'proj_a'};}
    signal.addEventListener('abort',()=>{secondAborted=true;},{once:true});
    return new Promise(()=>{});
  },signal:new AbortController().signal});
 assert.equal(calls,2);assert.equal(secondAborted,true);
 assert.equal(scan.occurrences.length,1);assert.ok(scan.coverage.reasons.includes('recognition-budget'));
 assert.deepEqual(scan.observedMessageIds,[]);
 store.replaceConversationMentions(source,scan);
 const state=store.mentionState(sourceId);
 assert.equal(state.occurrences.length,26);assert.equal(state.occurrences.filter(o=>!o.confirmed).length,25);
});


function fileCollector(t:any,body='note.txt note.txt plans/existing.txt 1.2 example.test missing.txt'){
 const dir=mkdtempSync(join(tmpdir(),'collector-files-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const storage=join(dir,'storage'),workspace=join(dir,'workspace');mkdirSync(storage);mkdirSync(workspace);mkdirSync(join(workspace,'plans'));
 writeFileSync(join(storage,'note.txt'),'fixture');writeFileSync(join(workspace,'plans/existing.txt'),'fixture');
 const {db,store}=open();t.after(()=>db.close());const f=fixture(db,store,[row('msg1',body)]);
 const originalGet=f.bb.sdk.threads.get;
 f.bb.sdk.threads.get=async(args:any)=>({...await originalGet(args),environmentId:'env_a',host:{id:'host_a'}});
 f.bb.sdk.threads.storageLocation=async()=>({hostId:'host_a',storageRootPath:storage});
 f.bb.sdk.environments={get:async()=>({id:'env_a',projectId:'proj_a',hostId:'host_a',path:workspace})};
 const checks:any[]=[];const io={transient:false,handler:undefined as undefined|((input:any,options:any)=>Promise<any>)};
 f.bb.hosts={experimental_client:()=>({call:async(method:string,input:any,options:any)=>{
  assert.equal(method,'mentionFileExists');checks.push(input);
  if(io.handler)return io.handler(input,options);
  if(io.transient)return {exists:false,retryable:true};
  return fileHostEntry.handlers.mentionFileExists(input,{signal:options.signal,lifecycle:{signal:options.signal}} as any);
 }})};
 return {...f,db,store,storage,workspace,checks,io};
}

test('actual collector verifies native file existence once per framed file and drops lexical false files',async t=>{
 const f=fileCollector(t);const result=await f.scan();
 assert.equal(result.occurrences.length,3);assert.equal(f.store.listForwardReferences({source:sourceId}).total,2);
 assert.deepEqual(result.occurrences.map(o=>o.provenance.source.id).sort(),['thr_source:note.txt','thr_source:note.txt','thr_source:plans/existing.txt'].sort());
 assert.equal(f.checks.filter(c=>c.path==='note.txt').length,1);
 assert.equal(f.checks.filter(c=>c.path==='plans/existing.txt').length,2); // storage absent, then workspace
 assert.ok(result.occurrences.every(o=>o.confirmed));
});

test('actual collector retains prior known files unconfirmed on transient verification, then removes authoritative missing files',async t=>{
 const f=fileCollector(t,'note.txt');await f.scan();f.io.transient=true;
 let result=await f.scan();assert.equal(result.occurrences.length,1);assert.equal(result.occurrences[0]!.confirmed,false);
 assert.ok(result.coverage!.reasons.includes('file-verification'));
 f.io.transient=false;unlinkSync(join(f.storage,'note.txt'));result=await f.scan();
 assert.equal(result.occurrences.length,0);assert.equal(f.store.listForwardReferences({source:sourceId}).total,0);
});

test('native file waits share source budget and cancelled late host responses cannot commit',async t=>{
 const f=fileCollector(t,'note.txt');await f.scan();const prior=f.store.mentionState(sourceId);
 let entered!:()=>void,release!:(value:any)=>void;
 const entry=new Promise<void>(r=>entered=r);
 f.io.handler=async()=>{entered();return new Promise(r=>release=r);};
 f.collector.enqueue('proj_a','thr_source',false,true);const controller=new AbortController();
 const pending=f.collector.processNext(controller.signal);await entry;controller.abort();release({exists:true});await pending;
 assert.deepEqual(f.store.mentionState(sourceId),prior);
 assert.ok(f.db.prepare('SELECT 1 FROM assistant_link_jobs').get());
 // Spend nearly all source time in the first file check and hold a second
 // noncooperating check. Shared deadline must abort it and retain prior facts.
 let clock=0,calls=0,aborted=false;t.mock.method(performance,'now',()=>clock);
 const diagnostics=new MentionDiagnostics();
 const scan=await collectConversationMentions({messages:[{id:'msg1',text:'note.txt second.txt',createdAt:1,messageSeq:17,anchorSeq:21,role:'assistant'}],
  context:{consumer:{pluginId:'cross-references'},projectId:'proj_a',threadId:'thr_source',environmentId:'env_a',links:[]},clients:[],
  diagnostics,getThread:async id=>({id,projectId:'proj_a'}),verifyFile:async(source,signal)=>{
   calls++;if(calls===1){clock=MENTION_LIMITS.sourceMs-15;return {kind:'thread-storage',threadId:'thr_source',path:'note.txt'};}
   signal.addEventListener('abort',()=>aborted=true,{once:true});return new Promise(()=>{});
  },signal:new AbortController().signal});
 assert.equal(calls,2);assert.equal(aborted,true);assert.ok(scan.coverage.reasons.includes('recognition-budget'));
 assert.deepEqual(scan.observedMessageIds,[]);assert.equal(scan.occurrences.length,1);
 const diagnostic=JSON.parse(diagnostics.encode()).groups[0];assert.equal(diagnostic.reason,'source-deadline');assert.equal(diagnostic.stage,'native-wait');assert.equal(diagnostic.remainingMsMin,15);
});


test('actual near-limit collection fits deterministic v1 payload, commits without retry, retains bounded partial truth and reopens',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'collector-payload-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'references.sqlite');let current=open(path);t.after(()=>{if(current.db.open)current.db.close();});
 const messages=Array.from({length:6},(_,m)=>row(`msg${m}`,Array.from({length:43},(_,i)=>`[link](https://example.test/${'a'.repeat(480)}/${m*43+i})`).join('\n'),'user',{createdAt:m+1,messageSeq:m+1}));
 const f=fixture(current.db,current.store,messages);
 const initial=await f.scan();
 const graph=current.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!;
 assert.ok(graph.targets.length>0 && graph.targets.length<256);
 assert.equal(initial.occurrences.length,graph.targets.length);
 assert.equal(initial.coverage!.timelineComplete,true);
 assert.ok(initial.coverage!.reasons.includes('projection-payload-budget'));
 assert.equal(initial.coverage!.retentionLimited,true);assert.equal(initial.coverage!.capHistoryUnknown,true);
 assert.ok(Buffer.byteLength(projectionPayloadJson('cross-references',canonicalizeResource(graph.source),false,graph.targets.map(canonicalizeResource)))<=MAX_PROJECTION_PAYLOAD_BYTES);
 assert.equal((current.db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
 assert.ok(!f.state.logs.some(message=>message.includes('Could not collect')));
 // Same source facts in a different input order choose the same bounded graph
 // and evidence snapshot instead of retrying the oversized projection forever.
 f.state.rows=[...messages].reverse();const repeat=await f.scan();
 assert.equal(repeat.digest,initial.digest);assert.equal(repeat.revision,initial.revision);
 assert.deepEqual(current.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection,graph);
 f.state.rows=[];f.state.partial=true;const partial=await f.scan();
 assert.equal(partial.coverage!.timelineComplete,false);assert.equal(partial.coverage!.retentionLimited,true);
 assert.equal(partial.occurrences.length,initial.occurrences.length);assert.ok(partial.occurrences.every(row=>!row.confirmed));
 assert.equal(current.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!.payloadDigest,graph.payloadDigest);
 current.db.close();current=open(path,false);assert.deepEqual(current.store.mentionState(sourceId),partial);
 const reloaded=fixture(current.db,current.store,messages);const fresh=await reloaded.scan();
 assert.equal(fresh.occurrences.length,initial.occurrences.length);assert.equal(fresh.coverage!.timelineComplete,true);
 assert.ok(fresh.coverage!.reasons.includes('projection-payload-budget'));
 assert.equal(current.store.getProjection({producerPluginId:'cross-references',source:sourceId}).projection!.payloadDigest,graph.payloadDigest);
 // A sufficient complete smaller source clears the bounded loss marker.
 reloaded.state.rows=[messages[5]];const smaller=await reloaded.scan();
 assert.equal(smaller.occurrences.length,43);assert.equal(smaller.coverage!.retentionLimited,false);
 assert.equal(smaller.coverage!.capHistoryUnknown,false);assert.ok(!smaller.coverage!.reasons.includes('projection-payload-budget'));
});

test('actual collector aggregates cached file failure once, retains prior evidence, and suppresses successful/missing-only logs',async t=>{
 const f=fileCollector(t,'note.txt note.txt second.txt');
 await f.scan();assert.equal(f.state.logs.length,0);
 const original=f.bb.sdk.threads.get;let metadata=0;
 const error=Object.assign(new Error('SECRET /private/root https://secret.test/?token=SECRET'),{status:503});
 f.bb.sdk.threads.get=async(args:any)=>{if(args.include==='host'){metadata++;throw error;}return original(args);};
 const result=await f.scan();assert.equal(metadata,1);assert.equal(result.occurrences[0]?.confirmed,false);
 assert.ok(result.coverage!.reasons.includes('file-verification'));assert.equal(f.state.logs.length,1);
 const envelope=JSON.parse(f.state.logs[0]!.split('Diagnostics: ')[1]!);
 assert.equal(envelope.groups.length,1);assert.equal(envelope.groups[0].count,1);assert.equal(envelope.groups[0].stage,'source-owner');
 assert.ok(Number.isInteger(envelope.groups[0].remainingMsMin));assert.doesNotMatch(f.state.logs[0]!,/SECRET|private|secret\.test|stack/);
 f.bb.sdk.threads.get=original;f.state.logs.length=0;await f.scan();assert.equal(f.state.logs.length,0);
 unlinkSync(join(f.storage,'note.txt'));await f.scan();assert.equal(f.state.logs.length,0);assert.equal(f.store.mentionState(sourceId).occurrences.length,0);
});

for(const seam of ['source-owner','thread-storage','environment','host-transport'] as const)test('actual native timeout reports entered '+seam+' and freezes before late rejection',async t=>{
 const f=fileCollector(t,'note.txt');await f.scan();
 let reject!:(error:unknown)=>void,portSignal!:AbortSignal;
 const held=new Promise<never>((_,fail)=>reject=fail);
 const port=(args:any)=>{portSignal=args.signal;return held;};
 if(seam==='source-owner'){const original=f.bb.sdk.threads.get;f.bb.sdk.threads.get=(args:any)=>args.include==='host'?port(args):original(args);}
 if(seam==='thread-storage')f.bb.sdk.threads.storageLocation=port;
 if(seam==='environment'){f.io.handler=async()=>({exists:false});f.bb.sdk.environments.get=port;}
 if(seam==='host-transport')f.io.handler=async(_input,options)=>port(options);
 const result=await f.scan();assert.equal(portSignal.aborted,true);
 assert.equal(result.occurrences[0]?.confirmed,false);assert.ok(result.coverage!.reasons.includes('file-verification'));
 const log=f.state.logs.at(-1)!,envelope=JSON.parse(log.split('Diagnostics: ')[1]!);
 assert.equal(envelope.groups.length,1);assert.equal(envelope.groups[0].stage,seam);assert.equal(envelope.groups[0].reason,'native-timeout');
 assert.equal(envelope.groups[0].frame,seam==='source-owner'?'unknown':seam==='environment'?'workspace':'thread-storage');
 assert.ok(envelope.groups[0].elapsedMsMax>=400);assert.ok(envelope.groups[0].remainingMsMin>0);
 const prior=f.store.mentionState(sourceId),logs=[...f.state.logs];
 reject(Object.assign(new Error('SECRET late failure'),{name:'AbortError'}));await new Promise<void>(resolve=>setImmediate(resolve));
 assert.deepEqual(f.state.logs,logs);assert.deepEqual(f.store.mentionState(sourceId),prior);
});

test('actual native race distinguishes arbitrary SDK errors, cleanup abort and caller cancellation with original cause',async t=>{
 const base={messages:[{id:'msg1',text:'note.txt',createdAt:1,messageSeq:1,anchorSeq:1,role:'assistant' as const}],
  context:{consumer:{pluginId:'cross-references'},projectId:'proj_a',threadId:'thr_source',links:[]},clients:[],getThread:async(id:string)=>({id,projectId:'proj_a'})};
 for(const name of ['TimeoutError','AbortError']){
  const diagnostics=new MentionDiagnostics();const error=Object.assign(new Error('SECRET'),{name});
  const scan=await collectConversationMentions({...base,diagnostics,signal:signalForTest(),verifyFile:async()=>{throw error;}});
  assert.ok(scan.coverage.reasons.includes('file-verification'));const rows=JSON.parse(diagnostics.encode()).groups;
  assert.equal(rows[0].reason,'unknown');assert.notEqual(rows[0].reason,'native-timeout');
 }
 const diagnostics=new MentionDiagnostics();let nativeSignal!:AbortSignal,operation:any;
 const scan=await collectConversationMentions({...base,diagnostics,signal:signalForTest(),verifyFile:async(_source,signal,diagnostic)=>{
  nativeSignal=signal;operation=diagnostic;return {kind:'thread-storage',threadId:'thr_source',path:'note.txt'};
 }});
 assert.equal(scan.occurrences.length,1);assert.equal(nativeSignal.aborted,true);assert.deepEqual(JSON.parse(diagnostics.encode()).groups,[]);
 operation.enter('host-open');operation.fail('host-io');assert.deepEqual(JSON.parse(diagnostics.encode()).groups,[]);
 const controller=new AbortController(),cause=new Error('original cancellation');let entered!:()=>void,release!:(value:any)=>void;
 const entry=new Promise<void>(resolve=>entered=resolve),held=new Promise<any>(resolve=>release=resolve);
 const cancelled=new MentionDiagnostics();const pending=collectConversationMentions({...base,diagnostics:cancelled,signal:controller.signal,verifyFile:async(_source,signal)=>{nativeSignal=signal;entered();return held;}});
 await entry;controller.abort(cause);const stopped=await pending;assert.equal(stopped.occurrences.length,0);assert.deepEqual(stopped.observedMessageIds,[]);assert.equal(nativeSignal.reason,cause);
 const before=cancelled.encode();release({kind:'thread-storage',threadId:'thr_source',path:'note.txt'});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(cancelled.encode(),before);
});
function signalForTest(){return new AbortController().signal;}

for(const kind of ['validated-invalid','bypass-invalid','valid3ms','missing-valid-host-time','old-no-detail'] as const)
 test('actual collector preserves server versus host timing for '+kind,async t=>{
  const f=fileCollector(t,'note.txt');await f.scan();assert.equal(f.state.logs.length,0);
  const beforeCalls=f.checks.length;let clock=0;
  t.mock.method(performance,'now',()=>clock);
  f.io.handler=async()=>{
   clock+=20; // Known entered transport duration, with no additional timer/I/O.
   const detail=kind==='validated-invalid'||kind==='bypass-invalid'?
    {stage:'source-owner',reason:'native-timeout',frame:'unknown',elapsedMs:999,extra:'SECRET /private/root https://private.test/?token=SECRET'}:
    {stage:'host-open',reason:'host-permission',frame:'unknown',...(kind==='valid3ms'?{elapsedMs:3}:{})};
   const response={exists:false,retryable:true,...(kind==='old-no-detail'?{}:{diagnostic:detail})};
   if(kind==='bypass-invalid')return response;
   const result=await fileHostEntry.contract.mentionFileExists.output['~standard'].validate(response);
   if(result.issues)assert.fail('Expected accepted private host response');
   return result.value;
  };
  const state=await f.scan();assert.equal(f.checks.length,beforeCalls+1);assert.equal(f.state.logs.length,1);
  assert.equal(state.occurrences.length,1);assert.equal(state.occurrences[0]!.confirmed,false);
  assert.deepEqual(state.coverage!.reasons,['file-verification']);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS n FROM assistant_link_jobs').get() as any).n,0);
  const warning=f.state.logs[0]!,envelope=JSON.parse(warning.split('Diagnostics: ')[1]!);
  assert.equal(envelope.groups.length,1);assert.equal(envelope.omittedCount,0);assert.equal(envelope.capped,false);
  const group=envelope.groups[0];assert.equal(group.count,1);assert.equal(group.frame,'thread-storage');
  assert.equal(group.remainingMsMin,9980);assert.equal(group.remainingMsMax,9980);
  if(kind==='valid3ms'||kind==='missing-valid-host-time'){
   assert.equal(group.stage,'host-open');assert.equal(group.reason,'host-permission');
   assert.equal(group.elapsedMsMin,kind==='valid3ms'?3:undefined);assert.equal(group.elapsedMsMax,kind==='valid3ms'?3:undefined);
  }else{
   assert.equal(group.stage,'host-transport');assert.equal(group.reason,kind==='old-no-detail'?'retryable-host-response':'host-unknown');
   assert.equal(group.elapsedMsMin,20);assert.equal(group.elapsedMsMax,20);
  }
  assert.ok(Buffer.byteLength(warning.split('Diagnostics: ')[1]!)<=4096);
  assert.doesNotMatch(warning,/SECRET|private|999|stack/);
 });
