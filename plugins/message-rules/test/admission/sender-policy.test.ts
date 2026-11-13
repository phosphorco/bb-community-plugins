import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../../state/store.ts";
import { createGlobalCatalog } from "../../state/global.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { newGroup, newRule } from "../../contracts/model.ts";
import { savedBasis } from "../../suites/runner.ts";
import { createNativeAdmission } from "../../admission/native.ts";

function open(path:string) {
  const db=new Database(path),store=createStore(db);createGlobalCatalog(store);
  const fake=createFakePluginHost({pluginId:"message-rules"});
  const feature=createNativeAdmission(fake.bb,store,()=>async()=>{throw Error("No paid work may run in a native hook");});
  const context=makeMessageDispatchHookContext({project:{id:"project-test"},input:{text:"Still working",blocks:[]},senderThreadId:"thr_sender",initiator:"agent"});
  const hook=fake.harness.inspection.registrations.hooks["message.dispatch"]!;
  return {db,store,feature,context,hook};
}
test("activation is explicit, frozen and retained across a real database reopen",async()=>{
  const root=mkdtempSync(join(tmpdir(),"mr-sender-policy-"));const path=join(root,"rules.db");
  try {
    let app=open(path),project=app.store.get(G)!;
    project=app.store.saveGroup(G,project.revision,{...newGroup("g"),enabled:true,match:{kind:"all",children:[]}});
    project=app.store.saveRule(G,project.revision,{...newRule("r","g"),enabled:true,title:"Give result",advice:"Send a completed result."});
    assert.deepEqual(await app.hook(app.context),{action:"proceed"},"saved rules cannot activate themselves");
    const request={testProjectId:"project-test",scope:"test-project" as const,requestId:"activate-1",basis:savedBasis(project),expectedActivePolicy:null};
    const activated=await app.feature.publishTestPolicy(request);
    assert.deepEqual(await app.hook(app.context),{action:"reject",message:"Give result: Send a completed result."});
    assert.deepEqual((await app.feature.publishTestPolicy(request)).policy,activated.policy,"same intent reuses its recorded result");
    await assert.rejects(()=>app.feature.publishTestPolicy({...request,basis:"different"}),/different policy intent/);
    await app.feature.dispose();app.db.close();
    app=open(path);
    assert.deepEqual(await app.hook(app.context),{action:"reject",message:"Give result: Send a completed result."});
    const state=await app.feature.state();assert.equal(state.activePolicy?.ref.policyId,activated.policy.ref.policyId);assert.equal(state.recentSenderDecisions.length,2);
    assert.deepEqual(await app.hook({...app.context,project:{...app.context.project,id:"unrelated"}}),{action:"proceed"});
    app.db.close();
  } finally {rmSync(root,{recursive:true,force:true});}
});
test("old native publication receipts are retained but never silently activated",async()=>{
  const app=open(":memory:");
  app.db.exec("CREATE TABLE mr_admission_publications(operation_id TEXT PRIMARY KEY,input TEXT);INSERT INTO mr_admission_publications VALUES('old-operation','old immutable bytes')");
  assert.deepEqual(await app.hook(app.context),{action:"proceed"});
  assert.equal((await app.feature.state()).activePolicy,null);
  assert.deepEqual(app.db.prepare("SELECT * FROM mr_admission_publications").all(),[{operation_id:"old-operation",input:"old immutable bytes"}]);
  app.db.close();
});
