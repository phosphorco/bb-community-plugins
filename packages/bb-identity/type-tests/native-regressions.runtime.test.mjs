/** Independent reviewer semantic probes retained as source regressions; synthetic snapshots only. */
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import {createNativeSourceAdapter,NATIVE_SOURCE_LIMITS as LIMITS} from '@phosphorco/bb-identity/native';
import {defineNativeSourceConformance} from '@phosphorco/bb-identity/native/testing';
import * as f from './native-review-fixtures.mjs';
const adapter=createNativeSourceAdapter();
const value=r=>{assert.equal(r.ok,true,JSON.stringify(r));return r.value};
const refuses=r=>{assert.ok(!r.ok || (r.value.coverage.source.status!=='known' && r.value.text.length===0),JSON.stringify(r));};

test('valid many-group author/editor alignment and missing parallel arrays never borrow actors',()=>{
  const r=f.request(1,'creq_a',[[f.text('A')],[f.text('B')],[f.text('C')]]);r.data.p6rAuthors=[f.actor('A'),null,f.machine];r.data.p6rEditors=[null,f.actor('B'),f.actor('C')];
  for(let groupIndex=0;groupIndex<3;groupIndex++){
    const e=value(adapter.resolve({source:{kind:'request-group',threadId:'thread',eventId:'e1',requestId:'creq_a',groupIndex},events:[r,f.accept()]}));
    assert.deepEqual(e.author,r.data.p6rAuthors[groupIndex]);assert.deepEqual(e.latestEditor,r.data.p6rEditors[groupIndex]);assert.equal(e.origin,'user');assert.equal(e.initiatingPerson.status,'unknown');assert.equal(e.text[0].text,['A','B','C'][groupIndex]);
  }
  r.data.p6rAuthors=[f.actor('A')];const e=value(adapter.resolve({source:{kind:'request-group',threadId:'thread',eventId:'e1',requestId:'creq_a',groupIndex:2},events:[r]}));assert.equal(e.author,null);
});
test('assistant never inherits input identity, mentions, delegation or fake attempt',()=>{
  const snap=f.base();snap.events[0].data.initiator='agent';const e=value(adapter.resolve(snap));
  assert.equal(e.origin,'assistant');assert.equal(e.author,null);assert.equal(e.latestEditor,null);assert.deepEqual(e.mentionedTargets,[]);assert.equal(e.agentId,null);assert.equal(e.carriedPerson.status,'unknown');assert.equal(e.delegation.status,'unknown');assert.equal('attemptId' in e.source,false);assert.equal('reference' in e,false);
});
test('commentary and interrupted/failed unfinished delta text retained through exact terminal',()=>{
 for(const status of ['failed','interrupted']) {const snap=f.base();snap.events=[f.request(),f.accept(),f.completed(3,'comment','Comment','commentary'),f.delta(4,'unfinished','Partial'),f.terminal(9,status)];snap.timeline=f.timeline([f.row(3,3,'Comment','comment'),f.row(4,4,'Partial','partial')]);const e=value(adapter.resolve(snap));assert.deepEqual(e.text.map(t=>t.text),['Comment','Partial']);assert.deepEqual(e.text.map(t=>t.phase),['commentary',null]);assert.equal(e.terminal.status,status);}
});
test('same item ID in unrelated turn and future rows never joins selected terminal',()=>{
 const snap=f.base();snap.events.push(f.delta(10,'item','Other','other'),f.completed(11,'item','Other','final_answer','other'),f.delta(12,'item','Future'));
 snap.timeline=f.timeline([f.row(),f.row(10,11,'Other','other-row','other'),f.row(12,12,'Future','future')]);const e=value(adapter.resolve(snap));assert.deepEqual(e.text.map(t=>t.text),['Visible']);assert.deepEqual(e.text[0].eventIds,['e3','e4']);
});
test('cross-item range, wrong scope, cross-terminal, empty and deferred rows disclose gaps',()=>{
 for(const change of [s=>s.events[3].data.item.id='different',s=>s.events[3].scope.turnId='other',s=>s.timeline.rows[0].sourceSeqEnd=10,s=>s.timeline.rows[0].text='',s=>s.timeline.rows=[{kind:'turn',turnId:'turn',children:null}]]){const s=f.base();change(s);const e=value(adapter.resolve(s));assert.equal(e.text.length,0);assert.notEqual(e.coverage.source.status,'known');}
});
test('missing terminal and unsupported event do not borrow unrelated native sources',()=>{
 for(const source of [{...f.assistantSource,terminalEventId:'absent'},{kind:'event',threadId:'thread',eventId:'e3'}]){const e=value(adapter.resolve({...f.base(),source}));assert.equal(e.text.length,0);assert.equal(e.inputs.length,0);assert.equal(e.origin,'unknown');}
});
test('all accepted requests are ordered, exact-turn bounded, and ambiguous ids remain unresolved',()=>{
 const s=f.base();s.events=[f.request(),f.accept(),f.request(3,'creq_b'),f.accept(4,'creq_b'),f.accept(5,'missing'),f.accept(6,'creq_a','other'),f.terminal(),f.request(10,'future'),f.accept(11,'future')].reverse();s.timeline=f.timeline([]);
 const e=value(adapter.resolve(s));assert.deepEqual(e.inputs.map(i=>i.requestId),['creq_a','creq_b']);assert.ok(e.coverage.execution.reasons.includes('unresolved-accepted-request'));assert.equal(e.coverage.execution.status,'partial');
 s.events.push(f.request(0));const e2=value(adapter.resolve(s));assert.deepEqual(e2.inputs.map(i=>i.requestId),['creq_b']);
});
test('regression: selected later request event cannot inherit earlier same-request-id acceptance',()=>{
 const result=adapter.resolve({source:{kind:'event',threadId:'thread',eventId:'e10'},events:[f.request(),f.accept(),f.request(10)]});
 const e=value(result);assert.equal(e.inputs.length,0,JSON.stringify(e.inputs));
});
for(const [label,text] of [['omitted',undefined],['number',47],['object',{data:'not text'}],['null',null]])test(`regression: request ${label} text cannot be coerced into known native text`,()=>{const s=f.reqBase();s.events[0].data.inputGroups[0][0].text=text;refuses(adapter.resolve(s));});
test('regression: omitted item IDs do not establish native item join',()=>{
 const s=f.base();delete s.events[2].data.itemId;delete s.events[3].data.item.id;refuses(adapter.resolve(s));
});
test('regression: blank or oversized native item IDs do not establish native item join',()=>{
 for(const id of ['', 'x'.repeat(LIMITS.identifier+1)]){const s=f.base();s.events[2].data.itemId=id;s.events[3].data.item.id=id;refuses(adapter.resolve(s));}
});
test('regression: retained projection row IDs are required for source evidence',()=>{const s=f.base();delete s.timeline.rows[0].id;refuses(adapter.resolve(s));});
test('malformed timeline text fails without claiming any source bytes',()=>{for(const text of [null,undefined,47,{}]){const s=f.base();s.timeline.rows[0].text=text;assert.equal(adapter.resolve(s).ok,false);}});
test('regression: omitted text endpoint bytes cannot claim a text-bearing event join',()=>{
 const s=f.base();delete s.events[2].data.delta;delete s.events[3].data.item.text;refuses(adapter.resolve(s));
});
test('regression: invalid phase cannot escape public NativeTextEvidence type',()=>{
 const s=f.base();s.events[3].data.item.phase='reasoning';const r=adapter.resolve(s);assert.ok(!r.ok || (r.value.text.length===0 || r.value.text[0].phase===null),JSON.stringify(r));
});
test('event count, byte, row count and nested depth bounds enforced',()=>{
 const s=f.base();assert.equal(adapter.resolve({...s,events:Array.from({length:LIMITS.events+1},(_,i)=>f.terminal(i))}).ok,false);
 assert.equal(adapter.resolve({...s,timeline:f.timeline([f.row(3,4,'x'.repeat(LIMITS.bytes))])}).ok,false);
 assert.equal(adapter.resolve({...s,timeline:f.timeline(Array.from({length:LIMITS.rows+1},()=>({kind:'other'})))}).ok,false);
 let nested=f.row();for(let i=0;i<LIMITS.depth+2;i++)nested={kind:'turn',turnId:'turn',children:[nested]};assert.equal(adapter.resolve({...s,timeline:f.timeline([nested])}).ok,false);
});
test('throwing getters and circular snapshots return invalid-input',()=>{
 const a=f.base();Object.defineProperty(a.events[0],'id',{get(){throw Error('getter')}});assert.equal(adapter.resolve(a).ok,false);
 const b=f.base();b.circular=b;assert.equal(adapter.resolve(b).ok,false);
});
test('regression: non-enumerable text cannot bypass documented serialized byte cap',()=>{
 const s=f.base();Object.defineProperty(s.timeline.rows[0],'text',{value:'x'.repeat(LIMITS.bytes+1),enumerable:false});const result=adapter.resolve(s);assert.equal(result.ok,false,`accepted ${result.value?.text[0]?.text.length} bytes`);
});
test('regression: serialization hooks cannot bypass snapshot byte cap',()=>{
 const s=f.base();s.timeline.rows[0].text='x'.repeat(LIMITS.bytes+1);s.toJSON=()=>({});const result=adapter.resolve(s);assert.equal(result.ok,false,`accepted ${result.value?.text[0]?.text.length} bytes`);
});
test('immutable evidence is independent of source snapshot mutations',()=>{
 const s=f.reqBase();const e=value(adapter.resolve(s));s.events[0].data.p6rAuthors[0].presentation.displayName='changed';assert.equal(e.author.presentation.displayName,'author');
});
test('enrichment preserves Results, cursors and partial coverage; no false correlated execution',async()=>{
 const c=f.contribution();const attempt={status:'known',correlation:{threadId:'thread',turnId:'other-turn',attemptId:'real-attempt',toolCallId:null},inputGroups:[{sources:[{kind:'contribution',reference:c.reference}]}],contributions:[c]};
 const results=[{ok:true,value:{status:'pending'}},{ok:true,value:{status:'unavailable',reason:'unsupported'}},{ok:false,error:{code:'unavailable',message:'outage',retry:'after-reconnect'}},{ok:true,value:{status:'partial',items:[c],missing:['scope'],nextCursor:'actual-cursor',traversal:'continued'}}];
 for(const result of results){const calls=[];const a=createNativeSourceAdapter({history:{async contributions(q){calls.push(q);return result},async attempts(q){calls.push(q);return f.known([attempt])}}});const initial=value(a.resolve(f.base()));const e=value(await a.enrich(initial));assert.equal(e.history[0].result,result);assert.deepEqual(e.coverage,initial.coverage);assert.equal(e.author,null);assert.equal(e.agentId,null);assert.equal('attemptId' in e.source,false);if(result.value?.status==='partial'){assert.equal(calls.length,2);assert.equal(e.history[1].result.value.items[0],attempt);assert.equal(e.history[0].result.value.nextCursor,'actual-cursor');}else assert.equal(calls.length,1);}
});
test('enrichment only queries genuine same-thread references, deduplicates and caps total calls',async()=>{
 const calls=[];const refs=[f.contribution('same','other'),f.contribution('a'),f.contribution('a'),...Array.from({length:30},(_,i)=>f.contribution(`c${i}`))];const a=createNativeSourceAdapter({history:{async contributions(q){calls.push(q);return f.known(refs)},async attempts(q){calls.push(q);return f.known([])}}});const e=value(await a.enrich(value(a.resolve(f.base()))));assert.equal(calls.length,LIMITS.historyReads);assert.equal(e.history.length,LIMITS.historyReads);assert.ok(calls.every(q=>q.kind!=='contribution'||q.reference.threadId==='thread'));assert.equal(calls.filter(q=>q.reference?.contributionId==='a').length,1);
});
test('enrichment pre-abort, mid-read abort, throwing reader and no-reader outcomes are honest',async()=>{
 const e=value(adapter.resolve(f.base()));assert.equal(value(await adapter.enrich(e)),e);
 let calls=0;const abort=new AbortController();const a=createNativeSourceAdapter({history:{async contributions(){calls++;abort.abort();return f.known([f.contribution()])},async attempts(){throw Error('must not run')}}});const r=await a.enrich(e,{signal:abort.signal});assert.equal(r.ok,false);assert.equal(r.error.code,'cancelled');assert.equal(calls,1);
 const b=createNativeSourceAdapter({history:{async contributions(){throw Error('reader programmer error')},async attempts(){throw Error('never')}}});await assert.rejects(b.enrich(e),/reader programmer error/);
});
test('conformance entry executes actual supplied function and refuses empty fixtures',async()=>{
 const runs=[];let calls=0;defineNativeSourceConformance({test:(_n,run)=>runs.push(run),resolve:s=>{calls++;return adapter.resolve(s)},cases:[{name:'independent source check',snapshot:f.base(),verify:r=>assert.equal(value(r).author,null)}]});await Promise.all(runs.map(r=>r()));assert.equal(calls,1);assert.throws(()=>defineNativeSourceConformance({test(){},resolve:adapter.resolve,cases:[]}),/requires explicit semantic cases/);
});
test('regression: same-turn same-item child event contaminates root row phase and source IDs',()=>{
 const s=f.base();const child=f.completed(4,'item','Child commentary','commentary');child.data.item.parentToolCallId='delegation-child';
 s.events=[f.request(),f.accept(),f.delta(3,'item','Root answer'),child,f.completed(5,'item','Root answer','final_answer'),f.terminal()];s.timeline=f.timeline([f.row(3,5,'Root answer')]);
 const e=value(adapter.resolve(s));assert.deepEqual(e.text[0].eventIds,['e3','e5']);assert.equal(e.text[0].phase,'final_answer');
});
test('regression: endpoints sharing item ID but different parent scope cannot join',()=>{
 const s=f.base();s.events[3].data.item.parentToolCallId='other-parent';refuses(adapter.resolve(s));
});

test('same item selector with multiple recorded parents stays ambiguous', () => {
  const s=f.base();
  const child=f.completed(5,'item','Child','commentary');child.data.item.parentToolCallId='child';
  s.events.splice(4,0,child);s.timeline.rows.push(f.row(5,5,'Child','child-row'));
  s.source={...s.source,kind:'assistant-item',itemId:'item'};
  const e=value(adapter.resolve(s));assert.deepEqual(e.text,[]);assert.ok(e.coverage.source.reasons.includes('assistant-item-parent-ambiguous'));
});
test('recorded parent scope survives admitted terminal evidence', () => {
  const s=f.base();s.events[2].data.parentToolCallId='child';s.events[3].data.item.parentToolCallId='child';
  const e=value(adapter.resolve(s));assert.equal(e.text[0].parentToolCallId,'child');
});
test('invalid visibility cannot admit text or silently coerce hidden content', () => {
  for(const visibility of [null,4,'visible']) {const s=f.reqBase();s.events[0].data.inputGroups[0][0].visibility=visibility;assert.equal(adapter.resolve(s).ok,false);}
});
test('stable bounded copy never invokes getters or serialization hooks', () => {
  let invoked=0;
  const accessor=f.base();Object.defineProperty(accessor.timeline.rows[0],'text',{get(){invoked++;return 'Visible';}});
  const serialized=f.base();serialized.toJSON=()=>{invoked++;return {};};
  for(const s of [accessor,serialized])assert.equal(adapter.resolve(s).ok,false);
  assert.equal(invoked,0);
  const hidden=f.base();Object.defineProperty(hidden.timeline.rows[0],'text',{value:'Actual hidden data',enumerable:false});
  assert.equal(value(adapter.resolve(hidden)).text[0].text,'Actual hidden data');
});

test('JSON escape expansion also respects the stable serialized byte limit', () => {
  const s=f.base();s.timeline.rows[0].text='\u0000'.repeat(500000);
  assert.ok(JSON.stringify(s).length>LIMITS.bytes);assert.equal(adapter.resolve(s).ok,false);
});
