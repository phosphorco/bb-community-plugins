import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import React,{act,useEffect,useState,StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {z} from 'zod';
import {PresentationHost,createOwnerPresentationClient,PresentationCallError} from '../dist/react.js';
import {registerPresentation,lookupPresentation} from '../dist/presentation.js';
import {createIsolatedPresentationRealm} from '../dist/testing.js';
import {runPresentationConformance,scanPresentationEntry} from '../dist/testing-react.js';
import {registerRecognitionSupplier,createSupplierClient} from '../dist/bb.js';
import {UnknownResultSchema} from '../dist/index.js';
const source={provider:'plan-graph',id:'env_x:x.plan.pkl',kind:'plan'};
const ref={schema:'plan-graph/plan@1',data:{id:source.id}};
const ctx=()=>({pluginId:'plan-graph',generation:1,signal:new AbortController().signal});
const registration={schema:ref.schema,methods:['scene'],decode:d=>d&&typeof d.id==='string'?d:null,load:async()=>()=>null};
const navigate={toThread(){},openUrl(){},openFile(){return true;}};
test('owner client target, method allowlist, raw result cap, abort and late-result fencing',async()=>{
 const realm=createIsolatedPresentationRealm();registerPresentation(ctx(),registration);const entry=lookupPresentation('plan-graph',ref.schema);
 try{
  let args;const sdk={plugins:{callRpc:async a=>{args=a;return {ready:true};}}};const owner=createOwnerPresentationClient(sdk,entry);
  assert.deepEqual(await owner.call('scene',{id:source.id}),{ready:true});assert.equal(args.pluginId,'plan-graph');assert.equal(args.outputSchema,UnknownResultSchema);assert.equal(args.signal.aborted,true);
  await assert.rejects(owner.call('write',{}),e=>e.kind==='not-allowed');
  const huge=createOwnerPresentationClient({plugins:{callRpc:async()=>({extra:'界'.repeat(22000)})}},entry);await assert.rejects(huge.call('scene',{}),e=>e.kind==='incompatible');huge.dispose();
  let signal,late;const held=createOwnerPresentationClient({plugins:{callRpc:a=>{signal=a.signal;return new Promise(r=>late=r);}}},entry);
  const pending=held.call('scene',{});await Promise.resolve();held.dispose();await assert.rejects(pending,e=>e.kind==='cancelled');assert.ok(signal.aborted);late({ready:true});
  await assert.rejects(held.call('scene',{}),e=>e.kind==='cancelled');
  const caller=new AbortController();const isolated=createOwnerPresentationClient({plugins:{callRpc:()=>new Promise(()=>{})}},entry);const call=isolated.call('scene',{},caller.signal);caller.abort();await assert.rejects(call,e=>e.kind==='cancelled');isolated.dispose();owner.dispose();
 }finally{realm.restore();}
});
test('owner call deadline bounds a noncooperative supplier',async()=>{
 const realm=createIsolatedPresentationRealm();registerPresentation(ctx(),registration);
 const client=createOwnerPresentationClient({plugins:{callRpc:()=>new Promise(()=>{})}},lookupPresentation('plan-graph',ref.schema));
 const start=performance.now();try{await assert.rejects(client.call('scene',{}),e=>e instanceof PresentationCallError&&e.kind==='transient');assert.ok(performance.now()-start<6500);}finally{client.dispose();realm.restore();}
});
async function mount(){
 const dom=new JSDOM('<div id="root"></div>');const saved=new Map();for(const k of ['window','document','navigator','HTMLElement','Element','Node','IS_REACT_ACT_ENVIRONMENT']){saved.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});}
 const root=createRoot(dom.window.document.getElementById('root'));
 return {root,dom,async dispose(){await act(async()=>root.unmount());dom.window.close();for(const [k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}};
}
const hostProps={sdk:{plugins:{callRpc:async()=>({ok:true})}},consumer:{pluginId:'thread-brief',surface:'brief'},stamp:{pluginId:'plan-graph',...ref},identity:source,readyPlugins:new Set(['plan-graph']),mode:'docked',size:{maxWidth:400,maxHeight:300,preferredHeight:240},navigate,fallback:React.createElement('span',null,'Card fallback')};
test('PresentationHost late registration, Suspense first card, owner scope, crash fallback and token recovery',async()=>{
 const realm=createIsolatedPresentationRealm(),m=await mount();let loaded=0,complete;const diagnostics=[];
 try{
  await act(async()=>m.root.render(React.createElement(PresentationHost,{...hostProps,onDiagnostic:d=>diagnostics.push(d)})));assert.match(m.dom.window.document.body.textContent,/Card fallback/);
  let dispose;await act(async()=>{dispose=registerPresentation(ctx(),{...registration,load:()=>{loaded++;return new Promise(r=>complete=r);}});});assert.match(m.dom.window.document.body.textContent,/Card fallback/);
  await act(async()=>complete(()=>React.createElement('p',null,'Real hosted graph')));assert.match(m.dom.window.document.body.textContent,/Real hosted graph/);assert.ok(m.dom.window.document.querySelector('[data-bb-plugin="plan-graph"][data-bb-plugin-root]'));
  await act(async()=>m.root.render(React.createElement(PresentationHost,{...hostProps,mode:'full',revision:'new'})));assert.equal(loaded,1);
  await act(async()=>registerPresentation({...ctx(),generation:2},{...registration,load:async()=>()=>{throw new Error('Hosted fault');}}));await act(async()=>new Promise(r=>setTimeout(r,10)));assert.match(m.dom.window.document.body.textContent,/Plan view failed/);assert.match(m.dom.window.document.body.textContent,/Card fallback/);
  await act(async()=>registerPresentation({...ctx(),generation:3},{...registration,load:async()=>()=>React.createElement('p',null,'Replacement graph')}));await act(async()=>new Promise(r=>setTimeout(r,10)));assert.match(m.dom.window.document.body.textContent,/Replacement graph/);
  dispose(); // Stale generation disposal cannot remove replacement.
  assert.ok(lookupPresentation('plan-graph',ref.schema));
  await act(async()=>m.root.render(React.createElement(PresentationHost,{...hostProps,readyPlugins:new Set()})));assert.match(m.dom.window.document.body.textContent,/Card fallback/);
 }finally{await m.dispose();realm.restore();}
});
test('PresentationHost StrictMode owner reads survive remount and unmount cancels',async()=>{
 const realm=createIsolatedPresentationRealm(),m=await mount();const calls=[];
 try{
  registerPresentation(ctx(),{...registration,load:async()=>function View({owner}){const [state,setState]=useState('waiting');useEffect(()=>{let live=true;owner.call('scene',{}).then(()=>{if(live)setState('owner ready');},()=>{});return()=>{live=false;};},[owner]);return React.createElement('p',null,state);}});
  const props={...hostProps,sdk:{plugins:{callRpc:async a=>{calls.push(a);return {};}}}};
  await act(async()=>m.root.render(React.createElement(StrictMode,null,React.createElement(PresentationHost,props))));await act(async()=>new Promise(r=>setTimeout(r,20)));assert.match(m.dom.window.document.body.textContent,/owner ready/);
  await act(async()=>m.root.render(null));assert.ok(calls.every(a=>a.signal.aborted));
 }finally{await m.dispose();realm.restore();}
});
function server(bb){
 registerRecognitionSupplier(bb,{revision:'presentation/1',resolve:{providers:[{provider:'plan-graph',kinds:['plan']}],handler:input=>({resolutions:input.sources.map(source=>({source,state:'ready',reasons:[],card:{title:'Plan'},presentation:ref}))})}});
 bb.rpc.register({scene:{input:z.strictObject({id:z.string()}),output:z.unknown()}},{scene:input=>({id:input.id,title:'Owner scene'})});
}
function content(ctx){return registerPresentation(ctx,{...registration,load:async()=>function View({owner,data,mode}){const [value,setValue]=useState('loading');useEffect(()=>{owner.call('scene',{id:data.id}).then(v=>setValue(v.title),()=>{});},[owner,data.id]);return React.createElement('p',null,value+' '+mode);}});}
test('presentation React conformance drives real registered server/content script in both modes',async()=>{
 const report=await runPresentationConformance({pluginId:'plan-graph',register:server,mountContentScript:content,cases:[{identity:source,detail:'card',expect:{schema:ref.schema}}]});assert.equal(report.passed,true,JSON.stringify(report));assert.ok(report.checks.some(c=>c.name.endsWith('mode:full')));
});
test('presentation React conformance rejects an actual slot hook in a hosted component',async()=>{
 const {useRpc}=await import('@get-bb/plugin-sdk/app');
 const report=await runPresentationConformance({pluginId:'plan-graph',register:server,mountContentScript:ctx=>registerPresentation(ctx,{...registration,load:async()=>function Bad(){useRpc('scene');return React.createElement('p',null,'bad');}}),cases:[{identity:source,detail:'card',expect:{schema:ref.schema}}]});assert.equal(report.passed,false);assert.ok(report.checks.some(c=>c.state==='failed'&&c.name.includes('mode:')));assert.ok(!report.checks.some(c=>c.name==='presentation:setup'));
});
test('hook scan bundles full graph, rejects new slot hooks, namespace hooks and DOM scanning',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'presentation-scan-'));
 try{
  await writeFile(join(scratch,'good.tsx'),"import { useBbContext, Markdown } from '@get-bb/plugin-sdk/app'; export default function Good(){useBbContext();return <Markdown content='ok'/>;}");
  assert.equal((await scanPresentationEntry({entry:join(scratch,'good.tsx')})).passed,true);
  await writeFile(join(scratch,'bad.tsx'),"import {useRpc as read} from '@get-bb/plugin-sdk/app'; export default function Bad(){read('scene');return null;}");assert.equal((await scanPresentationEntry({entry:join(scratch,'bad.tsx')})).passed,false);
  await writeFile(join(scratch,'nested.ts'),"export function scan(){return document.querySelector('div');}");await writeFile(join(scratch,'entry.ts'),"export {scan} from './nested';");const nested=await scanPresentationEntry({entry:join(scratch,'entry.ts')});assert.equal(nested.passed,false);assert.ok(nested.files>=2);
  await writeFile(join(scratch,'namespace.ts'),"import * as sdk from '@get-bb/plugin-sdk/app';export const x=sdk.useSdk;");assert.equal((await scanPresentationEntry({entry:join(scratch,'namespace.ts')})).passed,false);
  await writeFile(join(scratch,'escaped.ts'),String.raw`import {useRpc} from '@get-bb/plugin-sdk/\u0061pp';export const hook=useRpc;`);assert.equal((await scanPresentationEntry({entry:join(scratch,'escaped.ts')})).passed,false);
 }finally{await rm(scratch,{recursive:true,force:true});}
});
test('label resolve rejects a presentation before consumer admission',async()=>{
 const sdk={plugins:{callRpc:async()=>({resolutions:[{source,state:'ready',card:{title:'Plan'},presentation:ref,reasons:[]}]})}};
 await assert.rejects(createSupplierClient(sdk,'plan-graph').resolve({version:1,context:{consumer:{pluginId:'thread-brief'}},sources:[source],detail:'label'}),e=>e.kind==='incompatible');
});
