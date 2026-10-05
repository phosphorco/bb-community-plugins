import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSelection,resolveByProvider} from '@phosphorco/bb-provider-settings';
import {readCatalog,registerProviderSettingsOwner,enumerateProviderSettingsOwners} from '@phosphorco/bb-provider-settings/bb';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {provider,catalog,policies,selection,capability,descriptor} from '../integration/fixtures.mjs';
test('Rosetta nondefault tier needs support only; RTD also needs listing',()=>{
 for(const tiers of [undefined,[]]){const p=provider();if(tiers===undefined)delete p.serviceTiers;else p.serviceTiers=tiers;
 assert.equal(validateSelection({...selection,serviceTier:'fast'},[p],catalog(),policies.rosetta).ok,true);
 assert.equal(validateSelection({...selection,serviceTier:'fast'},[p],catalog(),policies.rtd).issues[0].code,'service-tier-unsupported');}
});
test('both provider availability and model catalog use the explicit route; primary omits route keys',async()=>{
 const calls=[];const sdk={providers:{async list(args){calls.push(['list',args]);return[provider()]},async models(args){calls.push(['models',args]);return catalog()}}};
 for(const route of [null,{kind:'host',hostId:'h'},{kind:'environment',environmentId:'e'}]){calls.length=0;await readCatalog(sdk,route,'p');const r=route===null?{}:route.kind==='host'?{hostId:'h'}:{environmentId:'e'};assert.deepEqual(calls,[['list',r],['models',{providerId:'p',...r}]]);}
});
test('model-only first send does not validate or emit an unrequested inherited effort',()=>{
 const c=catalog();c.models[0].defaultReasoningEffort='unsupported-default';
 const r=resolveByProvider({kind:'by-provider',entries:{p:{model:'exec-model'}}},{providerId:'p',model:'old',reasoningLevel:'unsupported-inherited',boundary:'fork-child'},[provider()],c,policies.rosetta,capability());
 assert.deepEqual(r,{kind:'override',boundary:'first-send',fields:{model:'exec-model'}});
});
test('destination Read publishes routing/preview/unresolved cause without a catalog or write',async()=>{
 let destination={route:{kind:'environment',environmentId:'configured'},preview:true},catalogs=0;
 const host=createFakePluginHost({pluginId:'unit-owner'});
 try{registerProviderSettingsOwner(host.bb,[{descriptor:descriptor({saveValidation:'destination'}),policy:policies.rosetta,readValues:async()=>[''],decode:()=>({choice:{ok:true,value:{kind:'inherit'}},owned:null,rule:'native defaults'}),destination:async()=>destination,checkSampleRoute:async()=>[],catalog:async()=>{catalogs++;throw Error('Unexpected catalog')},write:async()=>{throw Error('Unexpected write')}}]);
 const read=()=>host.harness.behavior.callRpc('providerSettingsV1Read',{version:1,role:'expert'});
 let r=await read();assert.deepEqual(r.destinationRoute,destination.route);assert.equal(r.destinationPreview,true);
 destination={unresolved:'project missing'};r=await read();assert.equal(r.destinationUnresolved,'project missing');assert.equal(catalogs,0);
 }finally{await host.harness.lifecycle.dispose()}
});
test('one reasoning-only provider entry does not hide invalid explicit model in another entry',async()=>{
 const host=createFakePluginHost({pluginId:'unit-owner'}),calls=[];
 const cap=capability({providers:{p:capability().providers.p,q:capability().providers.p}});
 try{registerProviderSettingsOwner(host.bb,[{descriptor:descriptor({choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:cap}),policy:policies.rosetta,readValues:async()=>[''],decode:()=>({choice:{ok:true,value:{kind:'inherit'}},owned:null,rule:'native defaults'}),checkSampleRoute:async()=>[],catalog:async(route,p)=>{calls.push(p);return{providers:[provider(p)],catalog:catalog({providerId:p})}},write:async()=>{throw Error('Unexpected write')}}]);
 const r=await host.harness.behavior.callRpc('providerSettingsV1Validate',{version:1,role:'expert',sampleRoute:{kind:'host',hostId:'h'},choice:{kind:'by-provider',entries:{p:{reasoningLevel:'low'},q:{model:'missing'}}}});
 assert.deepEqual(calls,['q']);assert.equal(r.eligibility.status,'invalid');assert.equal(r.eligibility.issues[0].code,'model-unavailable');
 }finally{await host.harness.lifecycle.dispose()}
});
test('enumeration clamps concurrency, treats timeout as transient and discards parent cancellation',async()=>{
 let active=0,max=0;const controllers=[];const sdk={plugins:{list:async()=>({plugins:Array.from({length:9},(_,i)=>({id:String(i),status:'running'}))}),callRpc:args=>{active++;max=Math.max(max,active);controllers.push(args.signal);args.signal.addEventListener('abort',()=>active--,{once:true});return new Promise(()=>{})}}};
 const r=await enumerateProviderSettingsOwners({sdk,signal:new AbortController().signal,concurrency:99,timeoutMs:5,onRow:()=>{}});assert.ok(max<=4);assert.equal(r.rows.length,9);assert.ok(r.rows.every(r=>r.error==='transient'));assert.ok(controllers.every(c=>c.aborted));
 const c=new AbortController(),rows=[];setTimeout(()=>c.abort(),5);const cancelled=await enumerateProviderSettingsOwners({sdk,signal:c.signal,concurrency:NaN,timeoutMs:100,onRow:r=>rows.push(r)});assert.equal(cancelled.rows.length,0);assert.ok(rows.every(r=>r.state==='pending'));
});
test('generic 503 remains transient; the native disabled-owner message is unavailable',async()=>{
 const {classifyOwnerError}=await import('@phosphorco/bb-provider-settings');
 assert.equal(classifyOwnerError({status:503,body:'upstream temporarily busy'}),'transient');
 assert.equal(classifyOwnerError({status:503,body:'Plugin b is not running (status: disabled)'}),'unavailable');
});
test('root emitted declarations reference zod alone, never optional peers',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('../../dist/types/index.d.ts',import.meta.url),'utf8');
 assert.doesNotMatch(source,/from ['"](?:react|@get-bb\/plugin-sdk)/);
 assert.match(source,/from ['"]zod['"]/);
});
test('native object messages distinguish disabled and vanished from generic host failures',async()=>{
 const {classifyOwnerError}=await import('@phosphorco/bb-provider-settings');
 for(const [status,error,expected] of [[503,'plugin "b" is not running (status: disabled)','unavailable'],[404,'Unknown plugin "b"','vanished'],[503,'busy','transient'],[404,'Not found','host-incompatible']])assert.equal(classifyOwnerError({status,body:{ok:false,error}}),expected);
});
test('throwing destination is unresolved on Read, blocks tuple, permits catalog-free reset',async()=>{
 const host=createFakePluginHost({pluginId:'unit-owner'});let catalogs=0,writes=0;
 try{registerProviderSettingsOwner(host.bb,[{descriptor:descriptor({saveValidation:'destination',choiceKinds:['inherit','tuple']}),policy:policies.rosetta,readValues:async()=>[''],decode:()=>({choice:{ok:true,value:{kind:'inherit'}},owned:null,rule:'native defaults'}),destination:async()=>{throw Error('project unavailable')},checkSampleRoute:async()=>[],catalog:async()=>{catalogs++;throw Error('unexpected')},write:async()=>{writes++}}]);
 const r=await host.harness.behavior.callRpc('providerSettingsV1Read',{version:1,role:'expert'});assert.equal(r.destinationUnresolved,'project unavailable');assert.equal(writes,0);
 const save=choice=>host.harness.behavior.callRpc('providerSettingsV1Save',{version:1,role:'expert',expectedFingerprint:r.fingerprint,choice});
 assert.equal((await save({kind:'tuple',selection})).outcome,'rejected');assert.equal((await save({kind:'inherit'})).outcome,'saved');assert.equal(writes,1);assert.equal(catalogs,0);
 }finally{await host.harness.lifecycle.dispose()}
});
test('async validation cannot overwrite an intervening external writer',async()=>{
 const host=createFakePluginHost({pluginId:'unit-owner'});let values=['before'],writes=0;
 try{registerProviderSettingsOwner(host.bb,[{descriptor:descriptor({saveValidation:'destination',choiceKinds:['inherit','tuple']}),policy:policies.rosetta,readValues:async()=>[...values],decode:()=>({choice:{ok:true,value:{kind:'inherit'}},owned:null,rule:'native defaults'}),destination:async()=>({route:null,preview:false}),checkSampleRoute:async()=>[],catalog:async()=>{values=['external'];return{providers:[provider()],catalog:catalog({route:null})}},write:async()=>{writes++}}]);
 const r=await host.harness.behavior.callRpc('providerSettingsV1Read',{version:1,role:'expert'});const saved=await host.harness.behavior.callRpc('providerSettingsV1Save',{version:1,role:'expert',expectedFingerprint:r.fingerprint,choice:{kind:'tuple',selection}});assert.equal(saved.outcome,'conflict');assert.equal(writes,0);assert.deepEqual(values,['external']);
 }finally{await host.harness.lifecycle.dispose()}
});
