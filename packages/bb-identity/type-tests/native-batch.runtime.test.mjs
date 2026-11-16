import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createNativeSourceAdapter, withNativeSourceBatch, NATIVE_SOURCE_LIMITS as LIMITS } from '@phosphorco/bb-identity/native';
import * as f from './native-review-fixtures.mjs';
const adapter = createNativeSourceAdapter();
const envelope = snapshot => {
  const base = Object.create(Object.getPrototypeOf(snapshot));
  for (const key of Reflect.ownKeys(snapshot)) if (key !== 'timeline')
    Object.defineProperty(base, key, Object.getOwnPropertyDescriptor(snapshot, key));
  return base;
};
function batched(snapshot) {
  return withNativeSourceBatch(batch => {
    const page = batch.captureTimeline(snapshot.timeline);
    return page.ok ? batch.resolve(envelope(snapshot), page.value) : page;
  });
}
function parity(snapshot) {
  const old = adapter.resolve(snapshot), next = batched(snapshot);
  assert.deepEqual(next, old); return next;
}

test('batch preserves exact evidence across references, closures, missing/empty pages and Unicode', () => {
  for (const text of ['Visible', '日本語 😃', String.fromCharCode(0xd800), String.fromCharCode(0xdc00), String.fromCharCode(0), String.fromCharCode(10,34,92)]) {
    const s = f.base(); s.timeline.rows[0].text = text; parity(s);
    parity({ ...s, source: { ...s.source, kind: 'assistant-item', itemId: 'item' } });
    parity({ ...s, source: f.requestSource });
    parity({ ...s, source: { kind: 'request-group', threadId: 'thread', eventId: 'e1', requestId: 'creq_a', groupIndex: 0 } });
    parity({ ...s, events: s.events.filter(event => event.type !== 'turn/input/accepted') });
    parity({ ...s, timeline: undefined });
    parity({ ...s, timeline: { ...s.timeline, rows: [] } });
  }
  const s=f.base();s.extra={unknown:'preserved in validation'};s.timeline.extra={unknown:'entire page remains included'};parity(s);
});

test('batch charges the whole source when page and event envelope each fit but their sum does not', () => {
  const s=f.base();s.timeline.extra='p'.repeat(1100000);s.events[0].data.extra='e'.repeat(1100000);
  assert.ok(JSON.stringify(s.timeline).length<LIMITS.bytes);assert.ok(JSON.stringify(envelope(s)).length<LIMITS.bytes);
  assert.equal(parity(s).ok,false);
});

test('combined raw and serialized escape budgets remain independent', () => {
  const escaped=f.base();escaped.timeline.extra=String.fromCharCode(0).repeat(190000);escaped.events[0].data.extra=String.fromCharCode(0).repeat(190000);
  assert.equal(parity(escaped).ok,false);
  const hidden=()=>{const object={};for(let i=0;i<3000;i++)Object.defineProperty(object,'k'.repeat(350)+i,{value:undefined});return object;};
  const raw=f.base();raw.timeline.extra=hidden();raw.extra=hidden();
  assert.ok(JSON.stringify(raw).length<10000);assert.equal(parity(raw).ok,false);
});

test('depth is charged at the original snapshot position, including the timeline property', () => {
  const results=[];
  for(let count=59;count<=65;count++){
    const s=f.base();let value=null;for(let n=0;n<count;n++)value={child:value};s.timeline.extra=value;
    results.push(parity(s).ok);
  }
  assert.ok(results.includes(true));assert.ok(results.includes(false));
});

test('whole-page row/depth bounds, non-enumerable data and unrelated malformed input still refuse', () => {
  const mutations=[
    s=>s.timeline.rows.push({...f.row(),id:'unrelated',turnId:'other',text:'x'.repeat(LIMITS.bytes+1)}),
    s=>Object.defineProperty(s.timeline,'hidden',{value:'x'.repeat(LIMITS.bytes+1),enumerable:false}),
    s=>{s.timeline.rows=Array.from({length:LIMITS.rows+1},()=>({kind:'other'}));},
    s=>{let row=f.row();for(let n=0;n<LIMITS.depth+2;n++)row={kind:'turn',turnId:'turn',children:[row]};s.timeline.rows=[row];},
    s=>{s.timeline.toJSON=()=>({});},
    s=>{s.timeline[Symbol('hidden')]='x';},
    s=>{s.timeline.circular=s.timeline;},
    s=>{s.timeline.rows.length=2;},
    s=>{Object.setPrototypeOf(s.timeline,{custom:true});},
    s=>{s.events.push(s.events[0]);},
    s=>{s.events[0].threadId='other';},
  ];
  for(const mutate of mutations){const s=f.base();mutate(s);assert.equal(parity(s).ok,false);}
});

test('page and envelope accessors refuse without invocation', () => {
  let invoked=0;
  for(const target of ['page','envelope']){
    const s=f.base();
    if(target==='page')Object.defineProperty(s.timeline,'hidden',{get(){invoked++;return 'x';}});
    else Object.defineProperty(s,'source',{get(){invoked++;return f.assistantSource;}});
    assert.equal(parity(s).ok,false);
  }
  assert.equal(invoked,0);
});

test('one batch copies a whole page once across N resolutions and fresh batches observe later mutations', () => {
  const s=f.base();let reads=0;
  const page=new Proxy(s.timeline,{ownKeys(value){reads++;return Reflect.ownKeys(value);}});
  const before=adapter.resolve(s);assert.equal(before.ok,true);
  withNativeSourceBatch(batch=>{
    const handle=batch.captureTimeline(page);assert.equal(handle.ok,true);
    s.timeline.rows[0].text='Changed after capture';
    for(let n=0;n<40;n++)assert.deepEqual(batch.resolve(envelope(s),handle.value),before);
    assert.equal(reads,1);
  });
  const after=adapter.resolve(s);assert.equal(after.ok,true);assert.notDeepEqual(after,before);
  withNativeSourceBatch(batch=>{
    const handle=batch.captureTimeline(page);assert.equal(handle.ok,true);
    assert.deepEqual(batch.resolve(envelope(s),handle.value),after);
  });
  assert.equal(reads,2);
});

test('escaped, foreign and forged handles refuse before touching an envelope; callback errors propagate', async () => {
  let saved,token,reads=0;const input={};Object.defineProperty(input,'source',{get(){reads++;throw Error('must not run');}});
  withNativeSourceBatch(batch=>{
    saved=batch;const handle=batch.captureTimeline(f.base().timeline);assert.equal(handle.ok,true);token=handle.value;
    assert.equal(batch.resolve(input,{}).ok,false);
    withNativeSourceBatch(other=>assert.equal(other.resolve(input,token).ok,false));
  });
  assert.equal(saved.resolve(input,token).ok,false);assert.equal(saved.captureTimeline(input).ok,false);
  const late=withNativeSourceBatch(async batch=>{const h=batch.captureTimeline(f.base().timeline);await Promise.resolve();return batch.resolve(input,h.value);});
  assert.equal((await late).ok,false);assert.equal(reads,0);
  const sentinel=Error('callback failure');assert.throws(()=>withNativeSourceBatch(()=>{throw sentinel;}),value=>value===sentinel);
});

test('two pages and differing reference event closures retain independent exact results', () => {
  const first=f.base(),second=f.base();second.timeline.rows[0].text='Different genuine page';second.timeline.timelinePage.historySnapshot='other-page';
  const inputs=[first,second,{...first,source:{...first.source,terminalEventId:'missing'}},{...second,events:second.events.filter(e=>e.id!=='e3')}];
  withNativeSourceBatch(batch=>{
    const a=batch.captureTimeline(first.timeline),b=batch.captureTimeline(second.timeline);assert.ok(a.ok&&b.ok);
    for(let i=0;i<inputs.length;i++)assert.deepEqual(batch.resolve(envelope(inputs[i]),i%2?b.value:a.value),adapter.resolve(inputs[i]));
  });
});


test('batch preserves the exact accepted/refused byte boundary, including escaped keys and omitted undefined', () => {
  const make = count => {
    const snapshot = f.base();
    snapshot.timeline.extra = 'x'.repeat(count);
    snapshot['quoted"key'] = { present: true, omitted: undefined };
    Object.defineProperty(snapshot, 'hidden', { value: undefined, enumerable: false });
    return snapshot;
  };
  let low = 0, high = LIMITS.bytes;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (adapter.resolve(make(middle)).ok) low = middle; else high = middle;
  }
  assert.equal(parity(make(low - 1)).ok, true);
  assert.equal(parity(make(low)).ok, true);
  assert.equal(parity(make(high)).ok, false);
});

test("noncovering maxSeq never hides invalid whole-page data or inherited properties", () => {
  const missing=f.base();missing.timeline.maxSeq=0;parity(missing);
  const oversized=f.base();oversized.timeline.maxSeq=0;
  Object.defineProperty(oversized.timeline,"unrelated",{value:"x".repeat(LIMITS.bytes+1),enumerable:false});
  assert.equal(parity(oversized).ok,false);
  let reads=0;const accessor=f.base();accessor.timeline.maxSeq=0;
  Object.defineProperty(accessor.timeline,"unrelated",{get(){reads++;return "ignored";}});
  assert.equal(parity(accessor).ok,false);assert.equal(reads,0);
  const inherited=f.base(),prototype={};Object.defineProperty(prototype,"inheritedHidden",{value:"hidden",enumerable:false});
  Object.setPrototypeOf(inherited.timeline,prototype);assert.equal(parity(inherited).ok,false);
  const inheritedEnvelope=f.base();Object.setPrototypeOf(inheritedEnvelope,prototype);assert.equal(parity(inheritedEnvelope).ok,false);
});
