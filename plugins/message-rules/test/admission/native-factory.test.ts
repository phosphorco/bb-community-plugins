import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  publicationFingerprint, canonicalJson,
  type NativeAdmissionProtocolV1, type EvaluatorV1, type PublicationV1,
  type PublishInputV1, type OperationRecordV1, type EvaluatorInputV1,
  type EvidenceRequestV1, type EvidenceV1, type PreviewPlacementInputV1, type PreviewPlacementResultV1,
} from "@phosphorco/bb-message-admission/protocol";
import { createMessageRules } from "../../ui-suite-server.ts";
import { GLOBAL_CATALOG as G } from "../../contracts/catalog.ts";
import { newGroup, newRule } from "../../contracts/model.ts";
import type { Transport } from "../../evaluation/evaluator.ts";
import { answer } from "../helpers.ts";

// Controlled public host boundary, not native admission implementation proof.
function capablePort(placement?: (input:PreviewPlacementInputV1)=>Promise<PreviewPlacementResultV1>|PreviewPlacementResultV1) {
  let active: PublicationV1|null=null,evaluator:EvaluatorV1|null=null,serial=0,generation=0,boundGeneration=0;
  let lookupMissing=false;
  let beforeReplay:(()=>Promise<void>|void)|null=null;
  const publishedInputs=new Map<string,PublishInputV1>();
  let activeOffline=false,lostAck=false,publications=0,registrations=0,unregistrations=0,captures=0;
  const operations=new Map<string,OperationRecordV1>();
  const maxBytes=4*1024*1024;
  const native: NativeAdmissionProtocolV1={
    ...(placement?{previewPlacement:placement}:{}),
    describe:()=>({protocol:"bb-message-admission",versions:[1],capabilities:{admission:true,publication:true,operations:true,placement:!!placement,originalManifest:false,activity:false,feedback:false,limits:{requestBytes:maxBytes,responseBytes:maxBytes,snapshotBytes:maxBytes,evidenceBytes:maxBytes,manifestBytes:maxBytes,evaluationMs:60000,concurrentEvaluations:32}}}),
    registerEvaluator:(input,callback)=>{registrations++;generation++;boundGeneration=0;evaluator=callback;return {version:1,registrationId:"registration-"+generation,generation:"generation-"+generation,evaluatorVersion:input.evaluatorVersion};},
    unregisterEvaluator:input=>{unregistrations++;const current=input.generation==="generation-"+generation;if(current){evaluator=null;boundGeneration=0;}return {version:1,removed:current};},
    readActivePublication:()=>{if(activeOffline)throw Error("native pointer read offline");return active;},
    async publish(input:PublishInputV1){
      publications++;
      const previous=operations.get(input.operation.operationId);
      if(previous?.publication){
        if(beforeReplay){const before=beforeReplay;beforeReplay=null;await before();}
        assert.deepEqual(input,publishedInputs.get(input.operation.operationId),"Recovery must reuse the exact original input, including operation and prior CAS pointer.");
        if(active?.publication.publicationId===previous.publication.publication.publicationId)boundGeneration=generation;
        if(lostAck){lostAck=false;throw Error("response lost after native generation bind");}
        return {version:1,status:"published",operation:input.operation,publication:previous.publication,activePublication:active?.publication??null,reasons:[]};
      }
      if(canonicalJson(input.expectedActivePublication,maxBytes)!==canonicalJson(active?.publication??null,maxBytes))
        return {version:1,status:"conflict",operation:input.operation,publication:null,activePublication:active?.publication??null,reasons:[{code:"publication-cas",message:"pointer changed"}]};
      const {operation,expectedActivePublication,...content}=input;
      active={version:1,publication:{providerId:input.providerId,publicationId:"publication-"+(++serial),fingerprint:await publicationFingerprint(content,maxBytes)},operation,snapshotBytes:input.snapshotBytes,configurationVersion:input.configurationVersion,evaluatorVersion:input.evaluatorVersion,enrollment:input.enrollment,publishedAt:new Date().toISOString()};
      publishedInputs.set(operation.operationId,structuredClone(input));boundGeneration=generation;
      operations.set(operation.operationId,{version:1,operation,requestFingerprint:active.publication.fingerprint,kind:"publication",status:"accepted",original:null,assessments:[],acceptedOriginal:null,publication:active,feedback:null,delivery:{state:"none",queueId:null,requestId:null,groupIndex:null,details:null},reasons:[]});
      if(lostAck){lostAck=false;throw Error("response lost after native commit");}
      return {version:1,status:"published",operation,publication:active,activePublication:active.publication,reasons:[]};
    },
    lookupOperation:input=>{const record=lookupMissing?null:operations.get(input.operation.operationId)??null;return {version:1,status:record?"found":"missing",record};},
    recheckOperation:input=>{const record=operations.get(input.operation.operationId)??null;return {version:1,status:record?"found":"missing",record};},
  };
  async function invoke(assessmentId:string,options:{projectId?:string;captureError?:boolean;signal?:AbortSignal;feedbackProvider?:string}={}) {
    assert.ok(evaluator&&active);assert.equal(boundGeneration,generation,"Persisted publication alone does not bind a new native generation.");
    const policyContext={messageText:"Original content",projectTitle:"Testing",senderTitle:"Sender",destinationTitle:"Receiver"};
    const input:EvaluatorInputV1={version:1,assessmentId,generation:"generation-"+generation,cancellationGeneration:"cancel-1",deadlineAt:new Date(Date.now()+10000).toISOString(),publication:active,submission:{version:1,operation:{namespace:"native",operationId:assessmentId},requestFingerprint:"sha256:"+"a".repeat(64),original:{originalId:assessmentId,revision:1},threadId:"destination",projectId:options.projectId??"project-test",policyContext,rawInput:{opaque:"preserved native input"},requestedIntent:{mode:"queue",schedule:{kind:"scheduled",notBefore:"2026-12-01T00:00:00Z"},membership:"preserve",execution:{provider:null,model:null,reasoning:null,serviceTier:null,permissionMode:null,canAsk:false,configuration:{}}},source:{senderThreadId:"sender",initiator:"agent",author:null,editor:null,origin:null,externalOperation:null,visibleHumanActivity:false},kind:"message",override:"none",expectedPlacementWitness:null}};
    if(options.feedbackProvider) input.submission.feedbackBinding={providerId:options.feedbackProvider,obligationId:"native-obligation",original:{originalId:"rejected-original",revision:1},rejectionAssessmentId:"rejected-assessment",recipientThreadId:"destination",adviceFingerprint:"sha256:"+"c".repeat(64)};
    const result=await evaluator(input,{signal:options.signal??new AbortController().signal,captureEvidence:async(request:EvidenceRequestV1):Promise<EvidenceV1>=>{
      captures++;if(options.captureError)throw Error("native evidence unavailable");
      return {version:1,token:"token-"+assessmentId,operation:input.submission.operation,original:input.submission.original,assessmentId,capturedAt:new Date().toISOString(),metadata:{projectId:input.submission.projectId,threadId:"destination",senderThreadId:"sender",policyContext},windows:request.windows.map(window=>({...window,threadId:window.side==="sender"?"sender":"destination",coverage:"complete",asOfCursor:"cursor",latestClear:null,missingReason:null,events:[]})),readSetFingerprint:"sha256:"+"b".repeat(64),prefixMode:"native-candidate"};
    }});
    return {result,input};
  }
  return {native,invoke,beforeReplay:(action:()=>Promise<void>|void)=>beforeReplay=action,setLookupMissing:(value:boolean)=>lookupMissing=value,inputs:()=>[...publishedInputs.values()].map(input=>structuredClone(input)),setActiveOffline:(value:boolean)=>activeOffline=value,loseNextAck:()=>lostAck=true,counts:()=>({publications,publicationRows:serial,registrations,unregistrations,captures,generation,boundGeneration})};
}
function setup(native?:unknown,transport?:Transport,existingDb?:Database.Database) {
  const fake=createFakePluginHost({pluginId:"message-rules"}),db=existingDb??new Database(":memory:");
  fake.bb.storage.database=()=>db;
  if(native!==undefined)Object.assign(fake.bb,{experimental_messageAdmission:native});
  const product=createMessageRules(fake.bb,{admissionTransportFor:()=>transport??(async wire=>answer(wire))});
  const rpc=(method:string,input:object)=>fake.harness.behavior.callRpc(method,input) as Promise<any>;
  const snapshot=()=>rpc("snapshot",{projectId:G,discoverFiles:false});
  return {fake,db,product,rpc,snapshot,close:async()=>{await fake.harness.lifecycle.dispose();db.close();}};
}
async function saveRule(app:ReturnType<typeof setup>,scope="project-test") {
  let snapshot=await app.snapshot();
  snapshot=await app.rpc("saveGroup",{projectId:G,revision:snapshot.project.revision,group:{...newGroup("test"),enabled:true,match:{kind:"condition",field:"project_id",operator:"equals",value:scope,insensitive:false}}});
  return app.rpc("saveRule",{projectId:G,revision:snapshot.project.revision,rule:{...newRule("reject","test"),enabled:true,advice:"Correct the request."}});
}
const request=(snapshot:any,id:string,expected:unknown=null)=>({testProjectId:"project-test",scope:"test-project",requestId:id,basis:snapshot.basis,expectedActivePublication:expected});

test("actual registry SDK factory retains unsupported preview for absent/incompatible host and never publishes from save",async()=>{
  for(const native of [undefined,{describe:()=>({protocol:"bb-message-admission",versions:[99],capabilities:{}})}]) {
    const app=setup(native);
    try {
      const saved=await saveRule(app);
      assert.equal(saved.delivery.state,"unsupported");assert.equal(saved.delivery.activeKnown,false);
      await assert.rejects(()=>app.rpc("publishTestPolicy",request(saved,"attempt")),/absent|supported wire version/);
      assert.equal(app.product.store.get(G)!.rules[0]!.enabled,true);
      assert.equal((app.db.prepare("SELECT count(*) n FROM mr_admission_publications").get() as any).n,0);
      assert.ok(Object.values(app.fake.harness.inspection.registrations.hooks).every(h=>h===null));
    } finally {await app.close();}
  }
});
test("actual factory/RPC publishes only explicit project; callback uses exact native snapshot after saved edits; deactivation scoped",async()=>{
  const port=capablePort(),app=setup(port.native);
  try {
    let saved=await saveRule(app);
    assert.equal(port.counts().publications,0);
    await assert.rejects(()=>app.rpc("publishTestPolicy",{...request(saved,"invalid"),scope:"global"}));
    const published=await app.rpc("publishTestPolicy",request(saved,"publish"));
    const pointer=published.publication.publication.publication;
    assert.deepEqual(published.admission.activePublication.enrollment,{mode:"enforce",projectIds:["project-test"]});
    saved=await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...saved.project.rules[0],enabled:false}});
    assert.equal(port.counts().publications,1);
    const {result,input}=await port.invoke("native-first");
    assert.equal(result.verdict,"rejected");assert.deepEqual(result.advice,["Correct the request."]);
    assert.equal(input.submission.requestedIntent.schedule.kind,"scheduled");
    assert.equal(result.evidenceTokens.length,1);
    const outside=await port.invoke("outside",{projectId:"unrelated"});
    assert.equal(outside.result.verdict,"accepted");assert.equal(port.counts().captures,1);
    const unknown=await port.invoke("native-unknown",{captureError:true});
    assert.equal(unknown.result.verdict,"unresolved");assert.deepEqual(unknown.result.advice,["Correct the request."]);
    await assert.rejects(()=>app.rpc("deactivateTestPolicy",{...request(saved,"wrong-project",pointer),testProjectId:"another"}),/another project/);
    await app.rpc("deactivateTestPolicy",request(saved,"deactivate",pointer));
    assert.equal((await app.snapshot()).delivery.activePublication.enrollment.mode,"disabled");
  } finally {await app.close();}
  assert.equal(port.counts().registrations,1);assert.equal(port.counts().unregistrations,1);
});
test("publication response loss reconciles native operation without republishing changed saved inputs",async()=>{
  const port=capablePort(),app=setup(port.native);
  try {
    const saved=await saveRule(app),input=request(saved,"lost");port.loseNextAck();
    await assert.rejects(()=>app.rpc("publishTestPolicy",input),/lookup.*same request ID/);
    await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...saved.project.rules[0],enabled:false}});
    const lookup=await app.rpc("lookupTestPublication",{testProjectId:"project-test",scope:"test-project",requestId:"lost"});
    assert.equal(lookup.reconciliation.status,"found");assert.equal(lookup.admission.activeKnown,true);
    const same=await app.rpc("publishTestPolicy",input);
    assert.equal(same.reconciliation.status,"found");assert.equal(port.counts().publications,1);
  } finally {await app.close();}
});


test("actual callback exempts only native-bound MR feedback; ordinary neighbor and other provider remain checked",async()=>{
  const port=capablePort(),app=setup(port.native);
  try {
    const saved=await saveRule(app);await app.rpc("publishTestPolicy",request(saved,"feedback-policy"));
    assert.equal((await port.invoke("feedback",{feedbackProvider:"message-rules"})).result.verdict,"accepted");
    assert.equal(port.counts().captures,0);
    assert.equal((await port.invoke("neighbor")).result.verdict,"rejected");
    assert.equal((await port.invoke("other-provider",{feedbackProvider:"other-policy"})).result.verdict,"rejected");
    assert.equal(port.counts().captures,2);
  } finally {await app.close();}
});
test("actual callback cancellation fences an ignored-abort transport and same assessment never invokes it again",async()=>{
  const port=capablePort();let calls=0,started!:()=>void,release!:()=>void;
  const invoked=new Promise<void>(resolve=>started=resolve),blocked=new Promise<void>(resolve=>release=resolve);
  const app=setup(port.native,async wire=>{calls++;started();await blocked;return answer(wire);});
  try {
    let saved=await saveRule(app);
    const {jevRule}=await import("../helpers.ts");
    saved=await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...jevRule("semantic"),groupId:"test"}});
    await app.rpc("publishTestPolicy",request(saved,"cancel-policy"));
    const abort=new AbortController(),pending=port.invoke("cancelled",{signal:abort.signal});
    const rejected=assert.rejects(()=>pending,/cancelled/i);
    await invoked;abort.abort();await rejected;
    release();
    assert.equal((await port.invoke("cancelled")).result.verdict,"unresolved");assert.equal(calls,1);
  } finally {release?.();await app.close();}
});

test("native pointer read failure retains last publication and same-content recovery clears the failure without writes",async()=>{
  const port=capablePort(),app=setup(port.native);
  try {
    const saved=await saveRule(app);await app.rpc("publishTestPolicy",request(saved,"read-recovery"));
    const before=await app.snapshot();port.setActiveOffline(true);
    const failed=await app.snapshot();assert.equal(failed.delivery.state,"unavailable");assert.equal(failed.delivery.activeKnown,false);
    assert.deepEqual(failed.delivery.activePublication,before.delivery.activePublication);
    assert.match(failed.delivery.reason,/native pointer read offline/);
    port.setActiveOffline(false);
    const recovered=await app.snapshot();assert.equal(recovered.delivery.state,"available");assert.equal(recovered.delivery.activeKnown,true);
    assert.deepEqual(recovered.delivery.activePublication,before.delivery.activePublication);assert.equal(port.counts().publications,1);
    assert.equal(recovered.project.revision,before.project.revision);
  } finally {await app.close();}
});

test("actual adapter retains known ANY cause/advice under missing sibling, remains incomplete and never replays assessment",async()=>{
  for(const reduction of ["any","all"] as const){
    const port=capablePort();let calls=0;
    const app=setup(port.native,async wire=>{calls++;const response=answer(wire);delete response.answers[Object.keys(wire.questions)[1]!];return response;});
    try {
      let saved=await saveRule(app);
      const {jevRule}=await import("../helpers.ts"),rule=jevRule("reject");
      rule.groupId="test";rule.revision=saved.project.rules[0].revision;rule.reduction=reduction;
      rule.advice="Repair the known cause.";
      rule.criteria=[rule.criteria[0]!,{...rule.criteria[0]!,id:"missing-sibling"}];
      saved=await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule});
      await app.rpc("publishTestPolicy",request(saved,"partial-"+reduction));
      const {result}=await port.invoke("partial-"+reduction);
      assert.equal(result.verdict,"unresolved");assert.equal(result.complete,false);
      assert.equal(result.observations[0]!.status,"unresolved");
      assert.deepEqual(result.advice,reduction==="any"?[rule.advice]:[]);
      assert.deepEqual(result.causes.map(cause=>({groupId:cause.groupId,ruleId:cause.ruleId})),reduction==="any"?[{groupId:"test",ruleId:"reject"}]:[]);
      const replay=await port.invoke("partial-"+reduction);
      assert.equal(replay.result.verdict,"unresolved");assert.equal(replay.result.complete,false);
      assert.deepEqual(replay.result.advice,result.advice);assert.deepEqual(replay.result.causes,result.causes);
      assert.deepEqual(replay.result.evidenceTokens,[]);
      assert.ok(replay.result.unresolved.some(reason=>reason.code==="prior-assessment-evidence"));
      assert.equal(calls,1);
    } finally {await app.close();}
  }
});

test("unexpected duplicate callback cannot return a fresh final result using evidence captured by its prior context",async()=>{
  const port=capablePort(),app=setup(port.native);
  try {
    const saved=await saveRule(app);await app.rpc("publishTestPolicy",request(saved,"final-duplicate"));
    const first=await port.invoke("completed-assessment");
    assert.equal(first.result.verdict,"rejected");assert.equal(first.result.complete,true);
    const duplicate=await port.invoke("completed-assessment");
    assert.equal(duplicate.result.verdict,"unresolved");assert.equal(duplicate.result.complete,false);
    assert.deepEqual(duplicate.result.causes,first.result.causes);assert.deepEqual(duplicate.result.advice,first.result.advice);
    assert.deepEqual(duplicate.result.evidenceTokens,[]);assert.equal(port.counts().captures,1);
    assert.ok(duplicate.result.unresolved.some(reason=>reason.code==="prior-assessment-evidence"));
  } finally {await app.close();}
});

test("actual saved-suite RPC uses public placement port for Q(A),S(T),B and boundary fixtures; no publication or inference",async()=>{
  const {placementCases,fixtureSource}=await import("../suites/native-placement.helpers.ts");
  const cases=placementCases(),seen:PreviewPlacementInputV1[]=[];
  const port=capablePort(input=>{
    seen.push(structuredClone(input));
    const scenario=cases.find(item=>item.input.candidate.operation.operationId===input.candidate.operation.operationId)!;
    assert.ok(scenario);return structuredClone(scenario.result);
  }),app=setup(port.native);
  try {
    let saved=await saveRule(app);
    saved=await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...saved.project.rules[0],action:"queue-batched",advice:""}});
    const occurrences=cases.map(({input,result})=>({occurrenceId:input.candidate.operation.operationId,path:input.candidate.operation.operationId+".md",logicalId:input.candidate.operation.operationId,hash:null,enabled:true,missing:false,error:null,source:fixtureSource(input,result),groupId:"test",projectId:"project-test"}));
    app.product.store.discover(G,saved.project.revision,occurrences);
    saved=await app.rpc("snapshot",{projectId:G,discoverFiles:true});
    const started=await app.rpc("startSuite",{projectId:G,requestId:"native-fixtures",basis:saved.basis,hasRelevantDrafts:false});
    const {waitUntil}=await import("../helpers.ts");
    await waitUntil(()=>!!app.product.store.run(started.run.id)?.quiescent);
    const done=await app.snapshot();
    assert.equal(done.run.results.length,cases.length);
    assert.ok(done.run.results.every((row:any)=>row.status==="pass"));
    assert.equal(seen.length,cases.length);
    for(const [index,input] of seen.entries()){
      assert.deepEqual(input.queue,cases[index]!.input.queue,"scheduled originals, sources, claims and order unchanged");
      assert.equal(input.candidate.requestedIntent.membership,"join-next-ordinary");
      assert.equal(input.candidate.requestedIntent.mode,"queue");
      assert.deepEqual(input.candidate.requestedIntent.schedule,cases[index]!.input.candidate.requestedIntent.schedule);
      assert.deepEqual(input.candidate.requestedIntent.execution,cases[index]!.input.candidate.requestedIntent.execution);
      assert.equal(done.run.results[index].evaluation.nativePlacement.state,"simulated");
      assert.equal(done.run.results[index].evaluation.nativePlacement.result.simulation,true);
      assert.equal(done.run.frozen.occurrences[index].source,occurrences[index]!.source);
    }
    assert.equal(port.counts().publications,0);assert.equal(port.counts().captures,0);
    assert.equal((app.db.prepare("SELECT count(*) n FROM mr_attempts").get() as any).n,0);
    const again=await app.rpc("startSuite",{projectId:G,requestId:"native-fixtures",basis:saved.basis,hasRelevantDrafts:false});
    assert.equal(again.acknowledgedRun.id,done.run.id);assert.equal(seen.length,cases.length);
  } finally {await app.close();}
});

test("absent optional placement yields unknown only for native assertions, ordinary content fixture remains usable",async()=>{
  const {placementCases,fixtureSource}=await import("../suites/native-placement.helpers.ts");
  for(const native of [undefined,capablePort().native]){
    const app=setup(native);
    try {
      let saved=await saveRule(app);
      saved=await app.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...saved.project.rules[0],action:"queue-batched",advice:""}});
      const sample=placementCases()[0]!,nativeSource=fixtureSource(sample.input,sample.result);
      const plainSource=nativeSource.slice(0,nativeSource.indexOf("# Native placement"));
      app.product.store.discover(G,saved.project.revision,[nativeSource,plainSource].map((source,index)=>({occurrenceId:"placement-"+index,path:"placement-"+index+".md",logicalId:"fixture-"+index,hash:null,enabled:true,missing:false,error:null,source,groupId:"test",projectId:"project-test"})));
      saved=await app.rpc("snapshot",{projectId:G,discoverFiles:true});
      const started=await app.rpc("startSuite",{projectId:G,requestId:"optional-missing",basis:saved.basis,hasRelevantDrafts:false});
      const {waitUntil}=await import("../helpers.ts");await waitUntil(()=>!!app.product.store.run(started.run.id)?.quiescent);
      const done=await app.snapshot();
      assert.equal(done.run.results[0].status,"unknown");
      assert.equal(done.run.results[0].evaluation.nativePlacement.state,"unsupported");
      assert.equal(done.run.results[1].status,"pass");assert.equal(done.run.results[1].evaluation.nativePlacement,undefined);
    } finally {await app.close();}
  }
});

test("v1.6 intended-batch historical run stays byte-identical and stale after native-oracle version advance",async()=>{
  let previews=0;const port=capablePort(()=>{previews++;throw Error("historical simulation replayed");}),app=setup(port.native);
  try {
    const saved=await saveRule(app),p=app.product.store.get(G)!;
    const {fingerprint}=await import("../../contracts/hash.ts");
    const basis=fingerprint({version:"message-rules-v1.6",config:p.config,rules:p.rules,groups:p.groups,occurrences:p.occurrences});
    const old=app.product.store.start("historical-placement",{version:"message-rules-v1.6",projectId:G,config:p.config,rules:p.rules,groups:p.groups,occurrences:[],denominator:1,basis,actor:{historical:true}},"historical");
    app.product.store.append(old.id,old.owner,{occurrenceId:"legacy",path:"legacy.md",status:"pass",reason:"Historical intended membership",evaluation:{version:"message-rules-v1.6",inputHash:"historical",policy:"allow",rules:[],advice:[],errors:[],plannedBatch:["A","B"]}});
    app.product.store.finish(old.id,old.owner,"complete");app.product.store.quiesce(old.id,old.owner);
    const before=app.db.prepare("SELECT * FROM mr_runs WHERE id=?").get(old.id);
    const read=await app.snapshot();assert.notEqual(read.basis,basis);assert.equal(read.run.frozen.version,"message-rules-v1.6");
    assert.deepEqual(read.run.results[0].evaluation.plannedBatch,["A","B"]);assert.equal(read.run.results[0].evaluation.nativePlacement,undefined);
    const again=await app.rpc("startSuite",{projectId:G,requestId:"historical-placement",basis,hasRelevantDrafts:false});
    assert.equal(again.acknowledgedRun.id,old.id);assert.equal(previews,0);
    assert.deepEqual(app.db.prepare("SELECT * FROM mr_runs WHERE id=?").get(old.id),before);
    assert.equal(saved.project.rules[0].enabled,true);
  } finally {await app.close();}
});

async function waitAdmission(app:ReturnType<typeof setup>,predicate:(state:Awaited<ReturnType<typeof app.product.admission.state>>)=>boolean){
  for(let attempt=0;attempt<200;attempt++){
    const state=await app.product.admission.state();if(predicate(state))return state;
    await new Promise(resolve=>setTimeout(resolve,1));
  }
  throw Error("Timed out waiting for the actual activated recovery state");
}
const recoveryService="message-rules-admission-recovery";
test("activated reload recovery reuses exact prior explicit input, not changed saved policy; no JEV replay or new publication",async()=>{
  const port=capablePort(),first=setup(port.native);let second:ReturnType<typeof setup>|undefined;
  try {
    let saved=await saveRule(first);
    const published=await first.rpc("publishTestPolicy",request(saved,"original-explicit"));
    const oldInput=port.inputs()[0]!,oldPublication=published.admission.activePublication;
    saved=await first.rpc("saveRule",{projectId:G,revision:saved.project.revision,rule:{...saved.project.rules[0],enabled:false,advice:"Later saved rules"}});
    const originalRunCount=(first.db.prepare("SELECT count(*) n FROM mr_runs").get() as any).n;
    await first.fake.harness.lifecycle.dispose();
    second=setup(port.native,async()=>{throw Error("recovery must not invoke JEV");},first.db);
    await second.product.admission.ready;
    let state=await second.product.admission.state();
    assert.equal(state.activeKnown,true);assert.equal(state.generationReady,false);assert.equal(state.state,"unavailable");
    assert.equal(port.counts().publications,1,"staged factory does not recover before activated service start");
    second.fake.harness.behavior.runService(recoveryService);
    state=await waitAdmission(second,state=>state.generationReady===true);
    assert.deepEqual(state.activePublication,oldPublication);
    assert.deepEqual(port.inputs(),[oldInput]);assert.equal(port.counts().publications,2);assert.equal(port.counts().publicationRows,1);
    assert.equal(port.counts().captures,0);
    assert.equal(second.product.store.get(G)!.rules[0]!.enabled,false);
    assert.equal((second.db.prepare("SELECT count(*) n FROM mr_runs").get() as any).n,originalRunCount);
  } finally {if(second)await second.close();else await first.close();}
});
test("activation never invents publication from saved/unpublished config or a persisted pointer without exact local intent",async()=>{
  for(const orphanPointer of [false,true]){
    const port=capablePort(),app=setup(port.native);
    try {
      const saved=await saveRule(app);
      if(orphanPointer){
        await app.rpc("publishTestPolicy",request(saved,"orphan"));
        app.db.prepare("DELETE FROM mr_admission_publications").run();
      }
      const before=port.counts().publications;
      // A new registration is the controlled stand-in for plugin reload.
      await app.fake.harness.lifecycle.dispose();const reloaded=setup(port.native,undefined,app.db);
      try {
        reloaded.fake.harness.behavior.runService(recoveryService);
        await waitAdmission(reloaded,state=>orphanPointer?/original explicit publication input is unavailable/.test(state.reason):state.activeKnown);
        const state=await reloaded.product.admission.state();
        assert.equal(state.generationReady,false);assert.equal(port.counts().publications,before);
        if(orphanPointer)assert.equal(state.state,"unavailable");
      } finally {await reloaded.fake.harness.lifecycle.dispose();}
    } finally {app.db.close();}
  }
});
test("lost original publication acknowledgement reconciles first; unproved lookup never rebinds",async()=>{
  for(const missing of [false,true]){
    const port=capablePort(),first=setup(port.native);let second:ReturnType<typeof setup>|undefined;
    try {
      const saved=await saveRule(first);port.loseNextAck();
      await assert.rejects(()=>first.rpc("publishTestPolicy",request(saved,"lost-original")),/lookup/);
      await first.fake.harness.lifecycle.dispose();port.setLookupMissing(missing);
      second=setup(port.native,undefined,first.db);second.fake.harness.behavior.runService(recoveryService);
      const state=await waitAdmission(second,state=>missing?/outcome is unproved/.test(state.reason):state.generationReady===true);
      assert.equal(state.generationReady,!missing);assert.equal(port.counts().publications,missing?1:2);
      assert.equal(port.counts().publicationRows,1);
    } finally {if(second)await second.close();else await first.close();}
  }
});
test("recovery refuses a newer native pointer and an old evaluator version, without publishing changed saved bytes",async()=>{
  for(const newer of [false,true]){
    const port=capablePort(),first=setup(port.native);let second:ReturnType<typeof setup>|undefined;
    try {
      const saved=await saveRule(first);await first.rpc("publishTestPolicy",request(saved,"older-explicit"));
      if(newer){const input=port.inputs()[0]!;const active=await port.native.readActivePublication({version:1,providerId:"message-rules"});
        await port.native.publish({...input,operation:{namespace:"external-explicit",operationId:"newer"},expectedActivePublication:active!.publication});
      } else first.db.prepare("UPDATE mr_admission_publications SET input=json_set(input,'$.evaluatorVersion','message-rules-v1.6')").run();
      const before=port.counts().publications;await first.fake.harness.lifecycle.dispose();
      second=setup(port.native,undefined,first.db);second.fake.harness.behavior.runService(recoveryService);
      const state=await waitAdmission(second,state=>newer?/input is unavailable/.test(state.reason):/does not match/.test(state.reason));
      assert.equal(state.generationReady,false);assert.equal(port.counts().publications,before);
      if(newer)assert.equal(state.activePublication!.operation.operationId,"newer");
    } finally {if(second)await second.close();else await first.close();}
  }
});
test("lost rebind acknowledgement remains truthfully unavailable and service restart cannot blindly replay it",async()=>{
  const port=capablePort(),first=setup(port.native);let second:ReturnType<typeof setup>|undefined;
  try {
    const saved=await saveRule(first);await first.rpc("publishTestPolicy",request(saved,"known-original"));
    await first.fake.harness.lifecycle.dispose();port.loseNextAck();
    second=setup(port.native,undefined,first.db);const worker=second.fake.harness.behavior.runService(recoveryService);
    let state=await waitAdmission(second,state=>/recovery is uncertain/.test(state.reason));
    assert.equal(state.activeKnown,true);assert.equal(state.generationReady,false);assert.equal(state.state,"unavailable");
    assert.equal(port.counts().publications,2);worker.controller.abort();await worker.done;
    second.fake.harness.behavior.runService(recoveryService);
    state=await second.product.admission.state();assert.equal(state.generationReady,false);assert.equal(port.counts().publications,2);
    assert.match(String((second.db.prepare("SELECT value FROM mr_metadata WHERE key=?").get("admission-rebind/generation-2") as any).value),/unknown/);
  } finally {if(second)await second.close();else await first.close();}
});


test("pointer replacement racing exact recovery is not overwritten or reported current-generation ready",async()=>{
  const port=capablePort(),first=setup(port.native);let second:ReturnType<typeof setup>|undefined;
  try {
    const saved=await saveRule(first);await first.rpc("publishTestPolicy",request(saved,"race-original"));
    const input=port.inputs()[0]!;await first.fake.harness.lifecycle.dispose();
    port.beforeReplay(async()=>{
      const active=await port.native.readActivePublication({version:1,providerId:"message-rules"});
      await port.native.publish({...input,operation:{namespace:"external-explicit",operationId:"newer-race"},expectedActivePublication:active!.publication});
    });
    second=setup(port.native,undefined,first.db);second.fake.harness.behavior.runService(recoveryService);
    const state=await waitAdmission(second,state=>/publication changed/.test(state.reason));
    assert.equal(state.generationReady,false);assert.equal(state.activePublication!.operation.operationId,"newer-race");
    assert.equal(port.counts().publicationRows,2);assert.equal(port.counts().publications,3);
    assert.equal((await port.native.readActivePublication({version:1,providerId:"message-rules"}))!.operation.operationId,"newer-race");
  } finally {if(second)await second.close();else await first.close();}
});
