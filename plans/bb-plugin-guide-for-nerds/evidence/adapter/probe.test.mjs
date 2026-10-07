import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { OpenLifetime, clamp, innerLayer, pageArrow, scopeFrameEscape, contentEscape, releaseDrag, returnFocus } from './prototype.mjs';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { createPortal } = require('react-dom');
const rootPath = new URL('../../../../../', import.meta.url);
const donor = readFileSync(new URL('fork/build/bb/plugins/plugin-api-docs/src/product-map.tsx', rootPath), 'utf8');
const card = readFileSync(new URL('fork/build/bb/plugins/plugin-api-docs/src/surface-card.tsx', rootPath), 'utf8');
function fixture() {
  const dom = new JSDOM('<button id="footer">Guide</button><textarea id="composer">draft</textarea><div id="host"></div><div role="dialog" id="frame"><div id="content"><button id="map">Map</button><div role="dialog" id="card"><button id="card-button">Card</button></div><div role="menu" data-guide-inner-layer id="menu"><button id="menu-button">Menu</button></div><input id="input"></div></div>', { url:'https://fixture.invalid/projects/p/threads/t' });
  const doc = dom.window.document;
  return { dom, doc, frame: doc.querySelector('#frame'), el: id => doc.getElementById(id) };
}
function deferred() { let resolve, reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return { promise, resolve, reject }; }

test('actual donor dialog predicates suppress arrows and card dismissal under outer dialog', () => {
  assert.match(donor, /event\.target\.closest\('\[role="dialog"\]'\)/);
  assert.match(donor, /target\.closest\('\[role="dialog"\]'\)/);
  const {el,frame}=fixture();
  assert.equal(el('map').closest('[role="dialog"]'),frame);
  assert.equal(Boolean(el('map').closest('[role="dialog"]')),true);
  assert.equal(innerLayer(el('map'),frame),false);
  assert.equal(innerLayer(el('card-button'),frame),true);
});

test('scoped arrows work in outer dialog, skip card/menu/editable controls; route and draft remain', () => {
  const {dom,doc,el,frame}=fixture(); let page=0;
  el('content').addEventListener('keydown', e=>pageArrow(e,frame,d=>page+=d));
  const press=id=>el(id).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  press('map'); for(const id of ['card-button','menu-button','input','composer']) press(id);
  assert.equal(page,1); assert.equal(dom.window.location.pathname,'/projects/p/threads/t'); assert.equal(el('composer').value,'draft');
  // Dismissal uses actual card containment, not nearest outer dialog.
  let dismissed=0; el('content').addEventListener('pointerdown',e=>{if(!innerLayer(e.target,frame)) dismissed++;});
  el('card-button').dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));
  el('map').dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true})); assert.equal(dismissed,1);
});

test('menu then card then frame Escape precedence; underlying composer is unaffected', () => {
  const {dom,el,frame}=fixture(); let cardOpen=true,closed=0,menu=0;
  el('menu').addEventListener('keydown',e=>{if(e.key==='Escape'){menu++;e.preventDefault();e.stopPropagation();}});
  el('card').addEventListener('keydown',e=>{if(e.key==='Escape'){cardOpen=false;e.preventDefault();e.stopPropagation();}});
  el('content').addEventListener('keydown',e=>contentEscape(e,frame,()=>{if(!cardOpen)return false;cardOpen=false;return true;}));
  frame.addEventListener('keydown',e=>scopeFrameEscape(e,frame,()=>closed++));
  const esc=id=>el(id).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  esc('menu-button');assert.equal(menu,1);assert.equal(cardOpen,true);assert.equal(closed,0);
  esc('map');assert.equal(cardOpen,false);assert.equal(closed,0);
  esc('map');assert.equal(closed,1);esc('composer');assert.equal(closed,1);
  cardOpen=true;esc('card-button');assert.equal(cardOpen,false);assert.equal(closed,1);
});

test('actual donor global card Escape listener responds to underlying composer', () => {
  const callback = card.match(/const onKeyDown = \(event: KeyboardEvent\) => \{([\s\S]*?)\n    \};/)[1];
  let dismissed=0;const handler=new Function('onDismiss', 'return event => {'+callback+'}')( ()=>dismissed++ );
  const {dom,el}=fixture();dom.window.addEventListener('keydown',handler);
  el('composer').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(dismissed,1);
});

test('actual donor clipboard callback creates a new timer after unmount cleanup', async () => {
  const body=card.match(/const copyForAgent = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[copyState/)[1];
  const pending=deferred();let timers=0;const ref={current:null};const states=[];
  const callback=new Function('onCopyForAgent','copyState','setCopyState','surface','window','copyResetTimer','return async()=>{'+body+'}')(
    ()=>pending.promise,'idle',value=>states.push(value),{id:'x'},{setTimeout:()=>++timers},ref);
  const copying=callback();assert.equal(ref.current,null); // donor cleanup has no timer yet
  pending.resolve(true);await copying;assert.equal(timers,1);assert.deepEqual(states,['copying','copied']);
});

test('closed baseline does not call loader; close/reopen discards stale success and stale rejection', async () => {
  const life=new OpenLifetime();let calls=0,commits=[],failures=[];
  assert.equal(calls,0); const old=life.begin(), a=deferred();const loading=life.load(old,()=>{calls++;return a.promise;},x=>commits.push(x),x=>failures.push(x));
  life.end();const next=life.begin(),b=deferred();const reloading=life.load(next,()=>{calls++;return b.promise;},x=>commits.push(x),x=>failures.push(x));
  a.resolve('stale');b.resolve('current');await Promise.all([loading,reloading]);assert.deepEqual(commits,['current']);assert.equal(calls,2);
  const stale=life.begin(),c=deferred();const rejection=life.load(stale,()=>c.promise,x=>commits.push(x),x=>failures.push(x));life.end();c.reject(Error('stale'));await rejection;assert.equal(failures.length,0);
});

test('failure/retry works and plugin generation disposal prevents pending import commits', async () => {
  const life=new OpenLifetime();let state='loading';const a=life.begin();await life.load(a,()=>Promise.reject(Error('chunk')),()=>state='ready',()=>state='failed');assert.equal(state,'failed');
  const b=life.begin();await life.load(b,()=>Promise.resolve('module'),()=>state='ready',()=>state='failed');assert.equal(state,'ready');
  const old=life.begin(),pending=deferred();const loading=life.load(old,()=>pending.promise,()=>state='orphan',()=>state='failed');life.dispose();pending.resolve('module');await loading;assert.equal(state,'ready');
});

test('late clipboard resolve/reject cannot create feedback timers; pending work cannot affect next open', async () => {
  for (const mode of ['resolve','reject']) {
    const life=new OpenLifetime(),token=life.begin(),pending=deferred();let timers=0,updates=0;
    const copying=life.copy(token,()=>pending.promise,()=>updates++,()=>++timers);life.end();life.begin();
    pending[mode](mode==='resolve'?true:Error('clipboard'));await copying;assert.equal(timers,0);assert.equal(updates,0);
  }
  const life=new OpenLifetime(),token=life.begin();await life.copy(token,()=>Promise.resolve(true),()=>{});assert.equal(life.timers.size,1);life.dispose();assert.equal(life.timers.size,0);
});

test('focus returns only to connected invoker while owned, never steals composer focus', () => {
  const {doc,el,frame}=fixture();el('map').focus();returnFocus(el('footer'),frame,doc.activeElement);assert.equal(doc.activeElement,el('footer'));
  el('composer').focus();returnFocus(el('footer'),frame,doc.activeElement);assert.equal(doc.activeElement,el('composer'));
  el('footer').remove();el('map').focus();returnFocus(el('footer'),frame,doc.activeElement);assert.equal(doc.activeElement,el('map'));
});

test('pointer capture disposal releases on up/cancel/close/unmount and tolerates lost capture', () => {
  for(const reason of ['up','cancel','close','unmount']) {let captured=true,released=0;const element={hasPointerCapture:()=>captured,releasePointerCapture:()=>{captured=false;released++;}};assert.equal(releaseDrag({element,id:7}),null,reason);assert.equal(released,1);releaseDrag({element,id:7});assert.equal(released,1);}
});

test('geometry fits small/touch/offset visual viewports and reclamps on resize', () => {
  for(const v of [{x:0,y:0,w:1440,h:900},{x:0,y:0,w:320,h:568},{x:10,y:250,w:320,h:220},{x:0,y:0,w:12,h:12}]){
    const r=clamp({x:1400,y:-100,w:960,h:800},v);
    const m=Math.min(8,v.w/2,v.h/2);assert.ok(r.w<=v.w-m*2);assert.ok(r.h<=v.h-m*2);assert.ok(r.x>=v.x+m);assert.ok(r.y>=v.y+m);
    assert.ok(r.x+r.w<=v.x+v.w-m);assert.ok(r.y+r.h<=v.y+v.h-m);
  }
  const wide=clamp({x:800,y:100,w:600,h:500},{x:0,y:0,w:1440,h:900});const narrow=clamp(wide,{x:0,y:0,w:320,h:568});assert.equal(narrow.x,8);assert.equal(narrow.w,304);
});

test('React portal retains sentinel app context with injected content; single root disposal removes portal', async () => {
  const {dom,doc,el}=fixture();Object.assign(globalThis,{window:dom.window,document:doc,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
  const Context=React.createContext(null);let seen=null,mounts=0,unmounts=0;
  function Content(){seen=React.useContext(Context);React.useEffect(()=>{mounts++;return()=>unmounts++;},[]);return React.createElement('div',{id:'portaled-content'},'guide');}
  function Overlay({content:Content}){return createPortal(React.createElement(Content),doc.body);}
  const root=createRoot(el('host'));await React.act(async()=>root.render(React.createElement(Context.Provider,{value:'plugin/router/query/realtime-sentinel'},React.createElement(Overlay,{content:Content}))));
  assert.equal(seen,'plugin/router/query/realtime-sentinel');assert.equal(el('host').contains(el('portaled-content')),false);assert.equal(mounts,1);
  await React.act(async()=>root.unmount());assert.equal(el('portaled-content'),null);assert.equal(unmounts,1);
  dom.window.close();delete globalThis.window;delete globalThis.document;delete globalThis.HTMLElement;delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

// A card may unmount or change surfaces while the containing open session survives.
test('card disposal and surface supersession independently cancel late clipboard work',async()=>{
  for(const reason of ['unmount','surface-change']) {
    const life=new OpenLifetime(), token=life.begin(), pending=deferred();let timers=0,updates=0;
    const copying=life.copy(token,()=>pending.promise,()=>updates++,()=>++timers);
    if(reason==='unmount')life.dispose();else life.begin();
    pending.resolve(true);await copying;assert.equal(timers,0);assert.equal(updates,0);
  }
});

test('document-capture menu consumption precedes content and frame Escape handlers',()=>{
  const {dom,doc,el,frame}=fixture();let menu=true,cardOpen=true,closed=0;
  // Matches inspected Radix ordering; this remains a model, not vendored-menu proof.
  doc.addEventListener('keydown',e=>{if(menu&&e.key==='Escape'){menu=false;e.preventDefault();}},{capture:true});
  el('content').addEventListener('keydown',e=>contentEscape(e,frame,()=>{if(!cardOpen)return false;cardOpen=false;return true;}));
  frame.addEventListener('keydown',e=>scopeFrameEscape(e,frame,()=>closed++));
  el('map').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(menu,false);assert.equal(cardOpen,true);assert.equal(closed,0);
});
