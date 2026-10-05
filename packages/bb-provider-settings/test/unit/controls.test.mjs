import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {installTestPluginRuntime} from '@get-bb/plugin-sdk/testing/app';
import {RoleSettingsEditor} from '@phosphorco/bb-provider-settings/react';
import {descriptor,capability,provider,catalog} from '../integration/fixtures.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
const result=(choice={kind:'inherit'})=>({version:1,role:'expert',stored:{status:'valid-shape',choice,staticIssues:[]},fingerprint:'f',ownedFieldsDigest:null,ownedFieldsPresent:[],rule:'inherits invocation',eligibility:{status:'unverified'},destinationRoute:null,destinationPreview:false});
const valid={shapeIssues:[],eligibility:{status:'deferred',reason:'invocation'}};
async function mounted(props){
 const dom=new JSDOM('<div id="root"></div>',{url:'http://test-only.invalid'}),previous=new Map();
 for(const k of ['window','document','navigator','HTMLElement','MutationObserver','IS_REACT_ACT_ENVIRONMENT']){previous.set(k,Object.getOwnPropertyDescriptor(globalThis,k));Object.defineProperty(globalThis,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});}
 installTestPluginRuntime();const root=createRoot(dom.window.document.querySelector('#root'));
 async function render(p){await act(async()=>root.render(React.createElement(RoleSettingsEditor,p)));}
 async function click(label){const b=[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label);assert.ok(b,`Missing ${label}`);await act(async()=>b.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));}
 async function select(label,value){const s=dom.window.document.querySelector(`select[aria-label="${label}"]`);assert.ok(s);await act(async()=>{s.value=value;s.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});}
 await render(props);return{dom,render,click,select,async dispose(){await act(async()=>root.unmount());dom.window.close();for(const[k,d]of previous){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}};
}
function catalogSdk(calls){return{providers:{async list(args){calls.push(['list',args]);return[provider()]},async models(args){calls.push(['models',args]);return catalog()}}};}
test('malformed reset saves inherit without destination, catalog or picker',async()=>{
 const calls=[],read={...result(),stored:{status:'malformed',issues:[{code:'malformed',message:'Invalid saved model'}],raw:'bad'}};
 const client={pluginId:'b',read:async()=>read,validate:async()=>{throw Error('Must not validate reset in browser')},save:async(role,choice,fp)=>{calls.push(['save',role,choice,fp]);return{outcome:'saved',read:result(),eligibility:valid.eligibility}}};
 const m=await mounted({client,role:descriptor(),catalogSdk:catalogSdk(calls)});try{await m.click('Inherit');await m.click('Save');assert.deepEqual(calls,[['save','expert',{kind:'inherit'},'f']]);assert.equal(m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]'),null);}finally{await m.dispose();}
});
test('fixed provider entry selector can remove a blocked stored entry without browsing',async()=>{
 const calls=[],read=result({kind:'by-provider',entries:{q:{model:'retained'}}}),role=descriptor({choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:capability()});
 read.stored.staticIssues=[{code:'provider-blocked',message:'q is blocked'}];
 const client={pluginId:'b',read:async()=>read,validate:async()=>valid,save:async(_role,choice)=>{calls.push(choice);return{outcome:'saved',read:result(),eligibility:valid.eligibility}}};
 const m=await mounted({client,role,catalogSdk:catalogSdk(calls)});try{assert.match(m.dom.window.document.body.textContent,/Overrides aren’t available for Q; without an override the role follows its inherited execution\./);assert.doesNotMatch(m.dom.window.document.body.textContent,/q is blocked/);await m.select('Provider entry','q');await m.click('Remove entry');await m.click('Save');assert.deepEqual(calls,[{kind:'inherit'}]);}finally{await m.dispose();}
});
test('late Edit validation cannot browse after owner/context replacement',async()=>{
 const pending=deferred(),calls=[],old={pluginId:'a',read:async()=>result(),validate:()=>pending.promise};
 const sdk=catalogSdk(calls),role=descriptor(),m=await mounted({client:old,role,catalogSdk:sdk});
 try{await m.click('Edit');const next={pluginId:'b',read:async()=>({...result(),rule:'B owner'}),validate:async()=>valid};await m.render({client:next,role,catalogSdk:sdk});await act(async()=>pending.resolve(valid));assert.deepEqual(calls,[]);assert.match(m.dom.window.document.body.textContent,/B owner/);assert.equal(m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]'),null);}finally{await m.dispose();}
});
test('late catalog and seed responses cannot mount a picker for a replaced route',async()=>{
 for(const at of ['catalog','seed']){
  const pending=deferred(),calls=[],role=descriptor(),client={pluginId:'b',read:async()=>result(),validate:async()=>valid};
  const sdk={providers:{async list(args){calls.push(args);return[provider()]},async models(){return at==='catalog'?pending.promise:catalog()}}};
  const seed=at==='seed'?()=>pending.promise:undefined;
  const props={client,role,catalogSdk:sdk,sampleRoute:{kind:'host',hostId:'old'},...(seed?{seed}:{})};
  const m=await mounted(props);try{await m.click('Edit');await m.render({...props,sampleRoute:{kind:'environment',environmentId:'new'}});await act(async()=>pending.resolve(at==='catalog'?catalog():{selection:{providerId:'p',model:'exec-model',reasoningLevel:'low'},label:'old seed'}));assert.equal(m.dom.window.document.querySelector('[data-testid="bb-provider-model-picker"]'),null);assert.doesNotMatch(m.dom.window.document.body.textContent,/old seed/);}finally{await m.dispose();}
 }
});
test('dispatched save remains un-aborted but its late result cannot replace another owner display',async()=>{
 const pending=deferred(),calls=[],role=descriptor(),sdk=catalogSdk(calls);
 const a={pluginId:'a',read:async()=>result(),validate:async()=>valid,save:(...args)=>{calls.push(args);return pending.promise}};
 const m=await mounted({client:a,role,catalogSdk:sdk});try{await m.click('Inherit');await m.click('Save');const b={pluginId:'b',read:async()=>({...result(),rule:'B current'}),validate:async()=>valid};await m.render({client:b,role,catalogSdk:sdk});await act(async()=>pending.resolve({outcome:'saved',read:{...result(),rule:'A stale'},eligibility:valid.eligibility}));assert.equal(calls.length,1);assert.equal(calls[0][4],undefined);assert.match(m.dom.window.document.body.textContent,/B current/);assert.doesNotMatch(m.dom.window.document.body.textContent,/A stale/);}finally{await m.dispose();}
});
test('no-longer-offered Set field remains removable with Inherit',async()=>{
 const calls=[],cap=capability();cap.providers.p.perBoundary['fork-child'].model='unknown';
 const role=descriptor({choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:cap});
 const read=result({kind:'by-provider',entries:{p:{model:'retained'}}});read.stored.staticIssues=[{code:'field-not-offered',message:'model no longer offered'}];
 const client={pluginId:'b',read:async()=>read,validate:async()=>({shapeIssues:read.stored.staticIssues,eligibility:valid.eligibility}),save:async(_role,choice)=>{calls.push(choice);return{outcome:'saved',read:result(),eligibility:valid.eligibility}}};
 const m=await mounted({client,role,catalogSdk:catalogSdk(calls),providerEntry:'p'});try{await m.click('Replace');const select=m.dom.window.document.querySelector('select[aria-label="model"]');assert.equal(select.disabled,false);assert.equal(select.querySelector('option[value="set"]').disabled,true);assert.equal(select.querySelector('option[value="inherit"]').disabled,false);await m.select('model','inherit');await m.click('Save');assert.deepEqual(calls.at(-1),{kind:'inherit'});}finally{await m.dispose();}
});
test('equivalent inline role/catalog props preserve staged intent and avoid another Read',async()=>{
 let reads=0;const calls=[],sdk=catalogSdk(calls),client={pluginId:'a',read:async()=>{reads++;return result()},save:async()=>{throw Error('not dispatched')}};
 const m=await mounted({client,role:descriptor(),catalogSdk:{providers:{...sdk.providers}},seed:async()=>null});try{await m.click('Inherit');await m.render({client,role:descriptor(),catalogSdk:{providers:{...sdk.providers}},seed:async()=>null});assert.equal(reads,1);assert.equal([...m.dom.window.document.querySelectorAll('button')].find(b=>b.textContent==='Save').disabled,false);}finally{await m.dispose();}
});
test('definite native rejection avoids readback; output-invalid after write reconciles once',async()=>{
 const {OwnerCallError}=await import('@phosphorco/bb-provider-settings/bb');
 for(const [cause,expectedReads]of [[{status:400,body:{error:{code:'invalid_input'}}},1],[{status:503,body:{ok:false,error:'plugin "a" is not running (status: disabled)'}},1],[{status:500,body:{error:{code:'invalid_output'}}},2],[{name:'ZodError'},2]]){
 let reads=0,applied=false;const client={pluginId:'a',read:async()=>{reads++;return {...result(applied?{kind:'inherit'}:{kind:'fields',fields:{providerId:'p',model:'before'}}),fingerprint:applied?'after-write':'before-write'}},save:async()=>{if(expectedReads===2)applied=true;throw new OwnerCallError(cause)}};const m=await mounted({client,role:descriptor(),catalogSdk:catalogSdk([])});try{await m.click('Inherit');await m.click('Save');assert.equal(reads,expectedReads);assert.equal(applied,expectedReads===2);if(expectedReads===2)assert.match(m.dom.window.document.body.textContent,/Saved \(confirmed by re-read\)/);}finally{await m.dispose();}
 }
});
