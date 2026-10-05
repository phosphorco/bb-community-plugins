import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {installTestPluginRuntime} from '@get-bb/plugin-sdk/testing/app';
import {ProviderSettingsDirectory} from '@phosphorco/bb-provider-settings/react';
import {descriptor} from '../integration/fixtures.mjs';
// Directory-hosted editors: explicit refresh revalidates the open editor in
// place. Every owner Read/Save here is a manually released deferred promise.
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const tuple=model=>({kind:'tuple',selection:{providerId:'p',model,reasoningLevel:'low'}});
const result=(over={})=>({version:1,role:'expert',stored:{status:'valid-shape',choice:tuple('saved-model'),staticIssues:[]},fingerprint:'f',ownedFieldsDigest:null,ownedFieldsPresent:[],rule:'Rule initial',eligibility:{status:'unverified'},destinationRoute:null,destinationPreview:false,...over});
async function mounted(){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://test-only.invalid'}),previous=new Map();
 for(const k of ['window','document','navigator','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT']){previous.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});}
 installTestPluginRuntime();
 const reads=[],saves=[],catalogCalls=[];
 const sdk={
  plugins:{
   async list(){return{plugins:[{id:'owner',name:'Owner',status:'running'}]}},
   callRpc(args){
    if(args.method==='providerSettingsDescribe')return Promise.resolve({protocol:'bb-provider-settings',versions:[1],roles:[descriptor({label:'Expert role',choiceKinds:['inherit','tuple']})]});
    if(args.method==='providerSettingsV1Read'){const d=deferred();reads.push(d);return d.promise;}
    if(args.method==='providerSettingsV1Save'){const d=deferred();saves.push({args,...d});return d.promise;}
    throw Error('Unexpected '+args.method);
   },
  },
  providers:{async list(){catalogCalls.push('list');return[]},async models(){catalogCalls.push('models');return{models:[],selectedOnlyModels:[]}}},
 };
 const root=createRoot(dom.window.document.querySelector('#root'));
 await act(async()=>root.render(React.createElement(ProviderSettingsDirectory,{sdk,reconnectKey:0})));
 const doc=dom.window.document,text=()=>doc.body.textContent;
 const button=label=>[...doc.querySelectorAll('button')].find(b=>b.textContent.trim()===label&&!b.closest('[hidden]'));
 async function click(label){const b=typeof label==='string'?button(label):label;assert.ok(b,`Missing ${label}`);assert.equal(b.disabled,false,`${label} disabled`);await act(async()=>b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));}
 const trigger=()=>doc.querySelector('[data-bbps-trigger]');
 async function release(d,value){await act(async()=>{d.resolve(value);await d.promise.catch(()=>{});});}
 return{dom,doc,text,reads,saves,catalogCalls,button,click,trigger,release,async dispose(){await act(async()=>root.unmount());dom.window.close();for(const[k,d]of previous){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}};
}
async function opened(){
 const m=await mounted();
 await m.click(m.trigger());
 assert.equal(m.reads.length,1);
 await m.release(m.reads[0],result());
 assert.match(m.text(),/Current: p \/ saved-model/);
 return m;
}
test('an older refresh Read settling after a newer one cannot replace it',async()=>{
 const m=await opened();try{
  await m.click('Refresh');assert.equal(m.reads.length,2);
  await m.click('Refresh');assert.equal(m.reads.length,3);
  await m.release(m.reads[2],result({rule:'Rule newest'}));
  await m.release(m.reads[1],result({rule:'Rule older',fingerprint:'old',stored:{status:'valid-shape',choice:tuple('older-model'),staticIssues:[]}}));
  assert.match(m.text(),/Rule newest/);
  assert.doesNotMatch(m.text(),/Rule older|older-model/);
  assert.equal(m.button('Use current'),undefined);
  assert.equal(m.catalogCalls.length,0);
 }finally{await m.dispose();}
});
test('a refresh Read dispatched before Save cannot overwrite the confirmed save',async()=>{
 const m=await opened();try{
  await m.click('Inherit');
  await m.click('Refresh');assert.equal(m.reads.length,2);
  await m.click('Save');assert.equal(m.saves.length,1);
  assert.equal(m.saves[0].args.input.expectedFingerprint,'f');
  await m.release(m.saves[0],{outcome:'saved',read:result({fingerprint:'g',rule:'Rule after save',stored:{status:'valid-shape',choice:{kind:'inherit'},staticIssues:[]}}),eligibility:{status:'deferred',reason:'invocation'}});
  assert.match(m.text(),/Current: Inherit/);
  await m.release(m.reads[1],result({rule:'Rule before save'}));
  assert.match(m.text(),/Current: Inherit/);
  assert.match(m.text(),/Rule after save/);
  assert.doesNotMatch(m.text(),/Rule before save/);
  assert.equal(m.button('Use current'),undefined,'a pre-save Read surfaced a false conflict');
  assert.equal(m.saves.length,1,'no retry');
 }finally{await m.dispose();}
});
test('unchanged fingerprint still refreshes rule and destination metadata, keeping a dirty draft',async()=>{
 const m=await opened();try{
  await m.click('Inherit');
  await m.click('Refresh');
  await m.release(m.reads[1],result({rule:'Rule moved',destinationUnresolved:'Choose a project first'}));
  assert.match(m.text(),/Rule moved/);
  assert.match(m.text(),/Choose a project first/);
  assert.match(m.text(),/Draft: Inherit/);
  assert.equal(m.button('Save').disabled,false);
  assert.equal(m.button('Use current'),undefined);
 }finally{await m.dispose();}
});
test('a changed saved value during refresh surfaces a conflict instead of replacing a dirty draft',async()=>{
 const m=await opened();try{
  await m.click('Inherit');
  await m.click('Refresh');
  await m.release(m.reads[1],result({fingerprint:'h',stored:{status:'valid-shape',choice:tuple('external-model'),staticIssues:[]}}));
  assert.match(m.text(),/Draft: Inherit/);
  assert.match(m.text(),/Current: p \/ saved-model/,'the draft base fingerprint was replaced silently');
  assert.ok(m.button('Use current'));assert.ok(m.button('Overwrite'));
  await m.click('Overwrite');
  assert.equal(m.saves[0].args.input.expectedFingerprint,'h');
 }finally{await m.dispose();}
});
test('a clean editor adopts a changed saved value on refresh',async()=>{
 const m=await opened();try{
  await m.click('Refresh');
  await m.release(m.reads[1],result({fingerprint:'h',stored:{status:'valid-shape',choice:tuple('external-model'),staticIssues:[]}}));
  assert.match(m.text(),/Current: p \/ external-model/);
  assert.equal(m.button('Save').disabled,true);
 }finally{await m.dispose();}
});
test('collapsed editors stay mounted, are not re-read on refresh, and revalidate once when reopened',async()=>{
 const m=await opened();try{
  await m.click('Inherit');
  await m.click(m.trigger());
  assert.equal(m.trigger().getAttribute('aria-expanded'),'false');
  assert.match(m.trigger().textContent,/Unsaved changes/);
  await m.click('Refresh');await m.click('Refresh');
  assert.equal(m.reads.length,1,'hidden editor was re-read');
  await m.click(m.trigger());
  assert.equal(m.reads.length,2);
  await m.release(m.reads[1],result());
  assert.match(m.text(),/Draft: Inherit/,'reopening lost the draft');
  await m.click(m.trigger());await m.click(m.trigger());
  assert.equal(m.reads.length,2,'reopen without a refresh re-read');
 }finally{await m.dispose();}
});
test('a failed refresh keeps the shown value, and the next successful refresh clears only its own error',async()=>{
 const m=await opened();try{
  await m.click('Refresh');
  await act(async()=>{m.reads[1].reject(new Error('owner offline'));await m.reads[1].promise.catch(()=>{});});
  assert.match(m.text(),/Could not refresh/);
  assert.match(m.text(),/Current: p \/ saved-model/);
  await m.click('Refresh');
  await m.release(m.reads[2],result());
  assert.doesNotMatch(m.text(),/Could not refresh/);
 }finally{await m.dispose();}
});
test('a failed initial Read recovers only through an explicit refresh, and Edit stays gated until it succeeds',async()=>{
 const m=await mounted();try{
  await m.click(m.trigger());
  assert.equal(m.reads.length,1);
  await act(async()=>{m.reads[0].reject(new Error('owner starting'));await m.reads[0].promise.catch(()=>{});});
  const section=m.doc.querySelector('section[aria-label="Expert role"]');
  assert.match(m.text(),/Couldn’t read the saved choice/);
  assert.equal(section.getAttribute('aria-busy'),'false','a settled error stayed busy');
  assert.equal(m.button('Edit').disabled,true);
  await act(async()=>{await Promise.resolve();});
  assert.equal(m.reads.length,1,'failed Read retried automatically');
  await m.click(m.trigger());await m.click(m.trigger());
  assert.equal(m.reads.length,1,'reopen without refresh retried');
  await m.click('Refresh');
  assert.equal(m.reads.length,2);
  assert.equal(m.button('Edit').disabled,true,'Edit enabled before the recovery Read settled');
  assert.equal(section.getAttribute('aria-busy'),'true','the pending recovery Read is not reported busy');
  await m.release(m.reads[1],result());
  assert.match(m.text(),/Current: p \/ saved-model/);
  assert.doesNotMatch(m.text(),/Couldn’t read the saved choice/);
  assert.equal(m.button('Edit').disabled,false);
  assert.equal(m.reads.length,2);
  assert.equal(section.getAttribute('aria-busy'),'false');
 }finally{await m.dispose();}
});
