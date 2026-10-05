import assert from "node:assert/strict";import test from "node:test";
import {createFakePluginHost} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import {decodePhase} from "../execution-settings.ts";
const input={version:1,role:"planner"};
async function fixture(settings: Record<string,string>,fn:(host:ReturnType<typeof createFakePluginHost>,calls:string[],handle:any)=>Promise<void>, routeReadable=false){
 const calls:string[]=[];const host=createFakePluginHost({pluginId:"perspectives",settings,sdk:{providers:{list:async()=>{calls.push("catalog");throw Error("must not browse")},models:async()=>{throw Error("must not browse")}},hosts:{get:async()=>{calls.push("route");if(routeReadable)return {id:"sample-host"} as any;throw Error("unreadable")}}}});
 let handle:any;const define=host.bb.settings.define;host.bb.settings.define=((descriptors:any)=>{handle=define(descriptors);return handle;}) as typeof define;
 try{plugin(host.bb);await fn(host,calls,handle);}finally{await host.harness.lifecycle.dispose();}
}
test("actual owner retains exact IDs; read/check/reset never seed or rewrite permissions",async()=>{
 await fixture({plannerModel:" catalog-id ",plannerPermission:"full",workerModel:"expert"},async(host,calls,handle)=>{
  const read=await host.harness.behavior.callRpc("providerSettingsV1Read",input) as any;
  assert.equal(read.stored.choice.fields.model," catalog-id ");assert.equal(read.eligibility.status,"unverified");assert.deepEqual(calls,[]);
  const checked=await host.harness.behavior.callRpc("providerSettingsV1Validate",{...input,choice:{kind:"fields",fields:{reasoningLevel:"high"}}}) as any;
  assert.equal(checked.eligibility.status,"deferred");assert.deepEqual(calls,[]);
  const saved=await host.harness.behavior.callRpc("providerSettingsV1Save",{...input,choice:{kind:"inherit"},expectedFingerprint:read.fingerprint,sampleRoute:{kind:"host",hostId:"unreadable"}}) as any;
  assert.equal(saved.outcome,"saved");assert.deepEqual(calls,[]);
  const values=await handle.get();
  assert.equal(values.plannerModel,"");assert.equal(values.plannerPermission,"full");assert.equal(values.workerModel,"expert");
 });
});
test("three-key raw fingerprint conflicts, other-role/permission writers do not contaminate it",async()=>{
 await fixture({plannerModel:"catalog-id"},async(host)=>{
  const read=await host.harness.behavior.callRpc("providerSettingsV1Read",input) as any;
  await host.harness.behavior.setSettings({workerModel:"other",plannerPermission:"full"});
  assert.equal((await host.harness.behavior.callRpc("providerSettingsV1Read",input) as any).fingerprint,read.fingerprint);
  await host.harness.behavior.setSettings({plannerReasoning:"high"});
  const saved=await host.harness.behavior.callRpc("providerSettingsV1Save",{...input,choice:{kind:"inherit"},expectedFingerprint:read.fingerprint}) as any;
  assert.equal(saved.outcome,"conflict");
 });
});
test("unknown role cannot read neighboring values; unavailable saved model can be explicitly reset",async()=>{
 await fixture({plannerModel:"unavailable-saved-model"},async(host)=>{
  await assert.rejects(host.harness.behavior.callRpc("providerSettingsV1Read",{version:1,role:"neighbor"}),/Unknown role/);
  const read=await host.harness.behavior.callRpc("providerSettingsV1Read",input) as any;
  assert.equal(read.stored.choice.fields.model,"unavailable-saved-model");
  assert.equal(decodePhase("","","").ok,false);
  const saved=await host.harness.behavior.callRpc("providerSettingsV1Save",{...input,choice:{kind:"inherit"},expectedFingerprint:read.fingerprint}) as any;
  assert.equal(saved.outcome,"saved");
 });
});
test("partial sample cannot invent caller model/provider; optional unreadable sample warns",async()=>{
 await fixture({},async(host,calls)=>{
  const result=await host.harness.behavior.callRpc("providerSettingsV1Validate",{...input,choice:{kind:"fields",fields:{model:"retained"}},sampleRoute:{kind:"host",hostId:"sample"}}) as any;
  assert.equal(result.eligibility.status,"invalid");assert.equal(result.eligibility.issues[0].code,"sample-route-unreadable");assert.deepEqual(calls,["route"]);
 });
});

test("readable sample leaves model-only/reasoning-only caller intent deferred without an invented provider",async()=>{
 await fixture({},async(host,calls)=>{
  for(const fields of [{model:"catalog-id"},{reasoningLevel:"high"}]){
   const result=await host.harness.behavior.callRpc("providerSettingsV1Validate",{...input,choice:{kind:"fields",fields},sampleRoute:{kind:"host",hostId:"sample-host"}}) as any;
   assert.equal(result.eligibility.status,"deferred");
  }
  assert.deepEqual(calls,["route","route"]);
 },true);
});
