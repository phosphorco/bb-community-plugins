import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement as h,act,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {installTestPluginRuntime} from '@get-bb/plugin-sdk/testing/app';
import {Markdown,MarkdownProvider,createMarkdownSurface} from '../dist/react.js';
import {createLiteralMarkdown,markdownRequestKey} from '../dist/index.js';
const source=(id='abcdefghij',revision='1')=>({kind:'thread-message',instance:'local',threadId:`thr_${id}`,messageId:'message',revision});
const request=(text='hello',frame=source())=>({source:frame,intent:'prose',content:text});
function model(r,phase='base',text=r.content) {return {...createLiteralMarkdown(r),format:'markdown',tree:{version:1,children:[{kind:'element',tag:'p',children:[{kind:'text',value:text}]}]},content:text,phase,status:'ready',diagnostics:[]};}
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

test('one surface batches repeated and distinct source demand without per-leaf sessions or idle polling',async()=>{
 const calls=[];const surface=createMarkdownSurface({async prepare(input){calls.push(input);return input.requests.map(r=>model(r,input.phase));}});
 const repeated=Array.from({length:150},()=>surface.acquire(request()));surface.start();await settle();
 assert.equal(calls.length,2);assert.equal(calls[0].requests.length,1);assert.equal(calls[1].phase,'enrich');
 repeated.forEach(x=>x.release());surface.stop();
 const next=[];let active=0,maxActive=0;
 const distinct=createMarkdownSurface({async prepare(input){active++;maxActive=Math.max(active,maxActive);await new Promise(resolve=>setImmediate(resolve));next.push(input);active--;return input.requests.map(r=>model(r,input.phase));}});
 const leases=Array.from({length:150},(_,i)=>distinct.acquire(request(`text${i}`,source('abcdefghij',String(i)))));distinct.start();await settle();await settle();
 assert.equal(next.filter(x=>x.phase==='base').reduce((n,x)=>n+x.requests.length,0),150);
 assert.equal(next.filter(x=>x.phase==='enrich').reduce((n,x)=>n+x.requests.length,0),150);
 assert.ok(next.every(x=>x.requests.length<=16));assert.ok(maxActive<=2);assert.ok(next.length<=22);
 const before=next.length;await settle();assert.equal(next.length,before,'no idle polling');leases.forEach(x=>x.release());distinct.stop();
});
test('cold fallback is immediate, hidden demand is paused, and stopped late responses are fenced',async()=>{
 const gate=deferred(),calls=[];const surface=createMarkdownSurface({async prepare(input){calls.push(input);await gate.promise;return input.requests.map(r=>model(r,input.phase,'late'));}});
 const lease=surface.acquire(request('**readable now**'),false);assert.equal(lease.store.get().model.original,'**readable now**');assert.equal(lease.store.get().model.format,'literal');surface.start();await settle();assert.equal(calls.length,0);
 lease.visibility(true);await settle();assert.equal(calls.length,1);surface.stop();gate.resolve();await settle();assert.equal(lease.store.get().model.format,'literal');lease.release();
});
test('unchanged-content failure recovers on shared refresh; stale revisions never overwrite current source',async()=>{
 let broken=true;const surface=createMarkdownSurface({async prepare(input){if(broken)throw Error('offline');return input.requests.map(r=>model(r,input.phase));}});
 const lease=surface.acquire(request());surface.start();await settle();assert.equal(lease.store.get().model.format,'literal');assert.match(lease.store.get().error,/offline/);broken=false;surface.refresh();await settle();assert.equal(lease.store.get().model.format,'markdown');assert.equal(lease.store.get().error,null);lease.release();surface.stop();
 const old=deferred();const s=createMarkdownSurface({async prepare(input){if(input.requests[0].source.revision==='old')await old.promise;return input.requests.map(r=>model(r,input.phase));}});
 const a=s.acquire(request('old',source('abcdefghij','old')));s.start();await settle();a.release();const b=s.acquire(request('new',source('abcdefghij','new')));await settle();old.resolve();await settle();assert.equal(b.store.get().model.original,'new');assert.equal(b.store.get().model.content,'new');b.release();s.stop();
});
test('selected/focused text is held stable until the interaction ends, with other keys updating',async()=>{
 let busy=true;const s=createMarkdownSurface({async prepare(input){return input.requests.map(r=>model(r,input.phase,input.phase));}});s.interaction(key=>busy&&key===markdownRequestKey(request()));
 const a=s.acquire(request()),b=s.acquire(request('other'));s.start();await settle();assert.equal(a.store.get().model.format,'literal');assert.equal(b.store.get().model.content,'enrich');busy=false;s.flushInteractions();assert.equal(a.store.get().model.content,'enrich');a.release();b.release();s.stop();
});
test('cross-source and malformed responses are atomically rejected before presentation',async()=>{
 const s=createMarkdownSurface({async prepare(input){return input.requests.map(r=>model({...r,source:source('abcdefghik')},input.phase));}});
 const lease=s.acquire(request());s.start();await settle();assert.equal(lease.store.get().model.format,'literal');assert.match(lease.store.get().error,/does not match/);lease.release();s.stop();
});
test('mounted StrictMode default rejects missing frames and preserves selection/focus/scroll through enrichment',async()=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://test.invalid'});
 const saved=new Map();for(const key of ['window','document','navigator','HTMLElement','Node','Element','IS_REACT_ACT_ENVIRONMENT','__bbPluginRuntime'])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 for(const key of ['window','document','navigator','HTMLElement','Node','Element'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});globalThis.IS_REACT_ACT_ENVIRONMENT=true;installTestPluginRuntime();
 const root=createRoot(document.getElementById('root')),calls=[],enrich=deferred();
 const transport={async prepare(input){calls.push(input);if(input.phase==='enrich')await enrich.promise;return input.requests.map(r=>model(r,input.phase,input.phase==='enrich'?'enriched':r.content));}};
 const stable=request('Selected base');
 try{
  await act(async()=>root.render(h(StrictMode,null,h(MarkdownProvider,{transport},h(Markdown,{...stable}),h(Markdown,{content:'missing source',intent:'prose'})))));
  await act(settle);assert.equal(document.querySelectorAll('.bb-md-literal').length,1);assert.equal(document.querySelector('.bb-md-literal').textContent,'missing source');
  assert.ok(calls.every(input=>input.requests.every(r=>r.source.threadId===stable.source.threadId)));
  const wrapper=document.querySelector('[data-layout]'),text=wrapper.querySelector('p').firstChild;
  wrapper.scrollTop=57;const range=document.createRange();range.selectNodeContents(text);document.getSelection().addRange(range);
  enrich.resolve();await act(settle);assert.equal(wrapper.querySelector('p').textContent,'Selected base');assert.equal(document.getSelection().toString(),'Selected base');assert.equal(wrapper.scrollTop,57);
  document.getSelection().removeAllRanges();await act(async()=>document.dispatchEvent(new dom.window.Event('selectionchange')));assert.equal(wrapper.querySelector('p').textContent,'enriched');assert.equal(wrapper.scrollTop,57);
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,descriptor]of saved)descriptor?Object.defineProperty(globalThis,key,descriptor):delete globalThis[key];}
});

test('in-flight enrichment completing offscreen is retained for visibility and remount',async()=>{
 const gate=deferred(),calls=[];const s=createMarkdownSurface({async prepare(input){calls.push(input.phase);if(input.phase==='enrich')await gate.promise;return input.requests.map(r=>model(r,input.phase,input.phase));}});
 const lease=s.acquire(request());s.start();await settle();assert.deepEqual(calls,['base','enrich']);lease.visibility(false);gate.resolve();await settle();assert.equal(lease.store.get().model.content,'base');lease.visibility(true);assert.equal(lease.store.get().model.content,'enrich');assert.deepEqual(calls,['base','enrich']);lease.release();
 const remounted=s.acquire(request());assert.equal(remounted.store.get().model.content,'enrich');remounted.release();s.stop();
});

test('cross-leaf selection whose endpoints are outside Markdown also fences updates',async()=>{
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://test.invalid'}),saved=new Map();
 for(const key of ['window','document','navigator','HTMLElement','Node','Element','IS_REACT_ACT_ENVIRONMENT','__bbPluginRuntime'])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 for(const key of ['window','document','navigator','HTMLElement','Node','Element'])Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});globalThis.IS_REACT_ACT_ENVIRONMENT=true;installTestPluginRuntime();
 const root=createRoot(document.getElementById('root')),gate=deferred();
 const transport={async prepare(input){if(input.phase==='enrich')await gate.promise;return input.requests.map(r=>model(r,input.phase,input.phase==='enrich'?'changed optional title':r.content));}};
 try{
  await act(async()=>root.render(h(MarkdownProvider,{transport},h('p',{id:'before'},'before'),h(Markdown,request('base text')),h('p',{id:'after'},'after'))));await act(settle);
  const range=document.createRange();range.setStart(document.getElementById('before').firstChild,0);range.setEnd(document.getElementById('after').firstChild,5);document.getSelection().addRange(range);
  const original=document.getSelection().toString();assert.equal(original,'beforebase textafter');gate.resolve();await act(settle);assert.equal(document.getSelection().toString(),original);
  document.getSelection().removeAllRanges();await act(async()=>document.dispatchEvent(new dom.window.Event('selectionchange')));assert.equal(document.querySelector('[data-layout] p').textContent,'changed optional title');
 }finally{await act(async()=>root.unmount());dom.window.close();for(const [key,d]of saved)d?Object.defineProperty(globalThis,key,d):delete globalThis[key];}
});
