import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { loadPublic } from './public-entry.mjs';
import { descriptor,policies,provider,catalog,selection,capability } from './fixtures.mjs';
// The store below belongs only to a test owner adapter. It is not a resolver.
function port(extra={}) {
  let values=[''];const calls={writes:0,catalog:0,sample:0,destination:0};
  const role={descriptor:descriptor({choiceKinds:['inherit','tuple']}),policy:policies.rosetta,
    async readValues(){return structuredClone(values)},
    decode(raw){return {choice:{ok:true,value:raw[0]?JSON.parse(raw[0]):{kind:'inherit'}},owned:null,rule:'inherits the invocation'}},
    async checkSampleRoute(){calls.sample++;return[]},
    async catalog(){calls.catalog++;return{providers:[provider()],catalog:catalog()}},
    async write(choice){calls.writes++;values=[JSON.stringify(choice)]}, ...extra};
  return {role,calls,setRaw(next){values=next},raw(){return structuredClone(values)}};
}
async function registered(extra={}) {
  const api=await loadPublic('./bb');const owner=port(extra),host=createFakePluginHost({pluginId:'owner-test'});
  api.registerProviderSettingsOwner(host.bb,[owner.role]);return {...owner,host,call:(method,input)=>host.harness.behavior.callRpc(method,input)};
}
test('registered Read/Validate do not write; Read never loads catalog',async()=>{
  const o=await registered();try{
    const read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    assert.equal(read.eligibility.status,'unverified');assert.equal(o.calls.writes,0);assert.equal(o.calls.catalog,0);
    await o.call('providerSettingsV1Validate',{version:1,role:'expert',choice:{kind:'tuple',selection},sampleRoute:{kind:'host',hostId:'h'}});
    assert.equal(o.calls.writes,0);assert.equal(o.calls.catalog,1);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('tolerant multi-role describe and strict owner operations',async()=>{
  const api=await loadPublic('./bb'),host=createFakePluginHost({pluginId:'owner-test'}),a=port(),b=port();b.role.descriptor=descriptor({id:'planner',label:'Planner'});
  try {
    api.registerProviderSettingsOwner(host.bb,[a.role,b.role]);
    const call=(name,input)=>host.harness.behavior.callRpc(name,input);
    const describe=await call('providerSettingsDescribe',null);
    assert.equal(describe.protocol,'bb-provider-settings');assert.equal(describe.roles.length,2);
    for(const input of [{},{future:true}])assert.deepEqual(await call('providerSettingsDescribe',input),describe);
    for(const [name,input] of [['providerSettingsV1Read',{version:1,role:'expert'}],['providerSettingsV1Validate',{version:1,role:'expert',choice:{kind:'inherit'}}],['providerSettingsV1Save',{version:1,role:'expert',choice:{kind:'inherit'},expectedFingerprint:(await call('providerSettingsV1Read',{version:1,role:'expert'})).fingerprint}]]) await assert.rejects(()=>call(name,{...input,extra:true}));
    await assert.rejects(()=>call('providerSettingsV1Read',{version:2,role:'expert'}));
    assert.equal(a.calls.writes+b.calls.writes,0);
  }finally{await host.harness.lifecycle.dispose()}
});
test('save uses exact raw owner values and conflicts after intervening writer',async()=>{
  const o=await registered();try {
    const read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    o.setRaw([' {"kind":"inherit"} ']);
    const saved=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice:{kind:'tuple',selection},expectedFingerprint:read.fingerprint});
    assert.equal(saved.outcome,'conflict');assert.equal(o.calls.writes,0);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('invocation save defers without context; bad sample warns and does not choose storage',async()=>{
  const o=await registered({async catalog(){return {providers:[],catalog:catalog({models:[]})}}});try {
    let read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    const choice={kind:'tuple',selection};
    const save=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice,expectedFingerprint:read.fingerprint});
    assert.equal(save.outcome,'saved');assert.equal(save.eligibility.status,'deferred');assert.equal(o.calls.writes,1);
    read=save.read;
    const sample=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice,expectedFingerprint:read.fingerprint,sampleRoute:{kind:'environment',environmentId:'sample'}});
    assert.equal(sample.outcome,'saved');assert.equal(sample.eligibility.status,'invalid');assert.deepEqual(JSON.parse(o.raw()[0]),choice);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('destination reset succeeds with unavailable destination; owned fields can still veto reset',async()=>{
  let destinationCalls=0;let ownedIssues=[];
  const roleDescriptor=descriptor({choiceKinds:['inherit','tuple'],saveValidation:'destination'});
  const o=await registered({descriptor:roleDescriptor,async destination(){destinationCalls++;return{unresolved:'project missing'}},preserveOwned(){return ownedIssues}});
  try {
    const read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    const reset=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice:{kind:'inherit'},expectedFingerprint:read.fingerprint});
    assert.equal(reset.outcome,'saved');assert.equal(o.calls.catalog,0);
    ownedIssues=[{code:'owner-fields-would-be-lost',message:'instructions retained'}];
    const next=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice:{kind:'inherit'},expectedFingerprint:reset.read.fingerprint});
    assert.equal(next.outcome,'rejected');assert.equal(next.issues[0].code,'owner-fields-would-be-lost');assert.equal(o.calls.writes,1);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('static role capability rejects before deferred Save and Validate, retained Read reports issues',async()=>{
  const descriptorFixed=descriptor({choiceKinds:['inherit','by-provider'],providerPolicy:'fixed-to-source',capability:capability({providers:{}})});
  const o=await registered({descriptor:descriptorFixed});try {
    const choice={kind:'by-provider',entries:{p:{model:'exec-model'}}};
    o.setRaw([JSON.stringify(choice)]);
    const read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    assert.deepEqual(read.stored.choice,choice);assert.equal(read.stored.staticIssues[0].code,'provider-blocked');
    const v=await o.call('providerSettingsV1Validate',{version:1,role:'expert',choice});
    assert.ok(v.shapeIssues.some(i=>i.code==='provider-blocked'));
    const s=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice,expectedFingerprint:read.fingerprint});
    assert.equal(s.outcome,'rejected');assert.ok(s.issues.some(i=>i.code==='provider-blocked'));assert.equal(o.calls.writes,0);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('explicit owner client targets B; no save signal or automatic retry after response loss',async()=>{
  const api=await loadPublic('./bb'), calls=[];
  const sdk={plugins:{async callRpc(args){calls.push(args);if(args.method.endsWith('Save'))throw new Error('network response lost');return args.outputSchema.parse({version:1,role:'expert',stored:{status:'valid-shape',choice:{kind:'inherit'},staticIssues:[]},fingerprint:'a'.repeat(64),ownedFieldsDigest:null,eligibility:{status:'unverified'},ownedFieldsPresent:[],rule:'inherit',destinationRoute:null,destinationPreview:false})}}};
  const client=api.createOwnerClient(sdk,'b'),signal=new AbortController().signal;
  await client.read('expert',signal);assert.equal(calls[0].pluginId,'b');assert.equal(calls[0].signal,signal);
  await assert.rejects(()=>client.save('expert',{kind:'inherit'},'a'.repeat(64)));
  assert.equal(calls.filter(c=>c.method==='providerSettingsV1Save').length,1);
  assert.equal(calls.find(c=>c.method.endsWith('Save')).signal,undefined);
});
test('enumeration uses native list once, target keys, disabled omission and tolerant versions',async()=>{
  const api=await loadPublic('./bb'),calls=[],rows=[];
  const sdk={plugins:{async list(){calls.push('list');return{plugins:[{id:'a',name:'A',status:'running'},{id:'b',name:'B',status:'degraded'},{id:'off',name:'Off',status:'disabled'}]}},async callRpc(args){calls.push(args);return{protocol:'bb-provider-settings',versions:args.pluginId==='a'?[1,2]:[2],roles:args.pluginId==='a'?[descriptor()]:{future:true},owner:'wrong-owner'}}}};
  const result=await api.enumerateProviderSettingsOwners({sdk,signal:new AbortController().signal,concurrency:4,timeoutMs:5000,onRow:r=>rows.push(r)});
  assert.equal(calls.filter(c=>c==='list').length,1);
  assert.equal(result.omittedCount,1);assert.equal(result.rows.find(r=>r.pluginId==='a').state,'participant');assert.equal(result.rows.find(r=>r.pluginId==='b').state,'incompatible');
  assert.ok(calls.filter(c=>typeof c==='object').every(c=>c.method==='providerSettingsDescribe' && ['a','b'].includes(c.pluginId)));
  assert.equal(result.rows.some(r=>r.pluginId==='wrong-owner'),false);
});
test('unknown role never reads or writes a neighboring role',async()=>{
  let reads=0,writes=0;
  const o=await registered({async readValues(){reads++;return['']},async write(){writes++}});
  try {
    for(const [name,input] of [['providerSettingsV1Read',{version:1,role:'unknown'}],['providerSettingsV1Validate',{version:1,role:'unknown',choice:{kind:'inherit'}}],['providerSettingsV1Save',{version:1,role:'unknown',choice:{kind:'inherit'},expectedFingerprint:'x'}]]) {
      let result;
      try{result=await o.call(name,input)}catch{} // domain rejection or native input error; never a successful neighboring Read/Save
      assert.equal(result?.role==='expert' || result?.outcome==='saved',false);
    }
    assert.equal(reads,0);assert.equal(writes,0);
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('owner read cancellation is forwarded and never retries',async()=>{
  const api=await loadPublic('./bb'),controller=new AbortController();controller.abort();let calls=0;
  const client=api.createOwnerClient({plugins:{async callRpc(args){calls++;assert.equal(args.signal,controller.signal);throw Object.assign(new Error('aborted'),{name:'AbortError'})}}},'b');
  await assert.rejects(()=>client.read('expert',controller.signal),e=>e.kind==='cancelled');assert.equal(calls,1);
});
test('partial intent with no caller/provider basis stays deferred on a readable sample',async()=>{
  let modelCalls=0;
  const o=await registered({descriptor:descriptor(),async catalog(route,providerId){modelCalls++;assert.ok(providerId,'Empty providerId must never reach models');throw new Error('No execution basis at settings time')}});
  try{
    for(const choice of [{kind:'fields',fields:{model:'catalog-id'}},{kind:'fields',fields:{reasoningLevel:'medium'}}]) {
      const result=await o.call('providerSettingsV1Validate',{version:1,role:'expert',choice,sampleRoute:{kind:'host',hostId:'h'}});
      assert.equal(result.eligibility.status,'deferred');assert.equal(modelCalls,0);assert.equal(o.calls.writes,0);
    }
  }finally{await o.host.harness.lifecycle.dispose()}
});
test('read-only descriptor permits Read/Check but never invokes write on valid Save',async()=>{
  const o=await registered({descriptor:descriptor({choiceKinds:['inherit','tuple'],writable:false})});
  try{
    const read=await o.call('providerSettingsV1Read',{version:1,role:'expert'});
    await o.call('providerSettingsV1Validate',{version:1,role:'expert',choice:{kind:'inherit'}});
    const result=await o.call('providerSettingsV1Save',{version:1,role:'expert',choice:{kind:'inherit'},expectedFingerprint:read.fingerprint});
    assert.equal(result.outcome,'rejected');assert.ok(result.issues.some(i=>i.code==='field-not-offered' && /read.?only/i.test(i.message)));
    assert.equal(o.calls.writes,0);
  }finally{await o.host.harness.lifecycle.dispose()}
});
