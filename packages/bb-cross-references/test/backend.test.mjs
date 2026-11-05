import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as contract from "../dist/index.js";
import { createCrossReferencesClient } from "../dist/bb.js";
import { runCrossReferencesConformance } from "../dist/testing.js";

const source = contract.threadResource("proj_test", "thr_source", { label: "Source" });
const targets = [contract.threadResource("proj_test", "thr_target", { label: "Target" })];
const command = {
  protocolVersion: 1, producerPluginId: "fixture-owner",
  mutationId: "00000000-0000-4000-8000-000000000001",
  source, revision: 1, expectedRevision: 0, tombstone: false, targets,
  payloadDigest: contract.projectionPayloadDigest("fixture-owner", contract.canonicalizeResource(source), false, targets.map(contract.canonicalizeResource)),
};
const sdkFor = callRpc => ({ plugins: { callRpc } });

test("canonical SHA256 and Unicode remain byte-identical to Node central v1", () => {
  for (const value of ["", "abc", "é", "e\u0301", "🧪", "\ud800", "\udfff", "prefix\ud800"])
    assert.equal(contract.sha256Hex(value), createHash("sha256").update(value, "utf8").digest("hex"));
  const a = contract.canonicalizeIdentity({ provider: "test", keys: { z: "🧪", a: "e\u0301" } });
  const b = contract.canonicalizeIdentity({ provider: "test", keys: { a: "é", z: "🧪" } });
  assert.equal(a.canonicalIdentityJson, '{"provider":"test","keys":{"a":"é","z":"🧪"}}');
  assert.equal(a.identityDigest, b.identityDigest);
  // Preserve the existing terminal high-surrogate behavior, without broadening it.
  assert.doesNotThrow(() => contract.canonicalizeIdentity({ provider: "test", keys: { key: "\ud800" } }));
  assert.throws(() => contract.canonicalizeIdentity({ provider: "test", keys: { key: "\ud800x" } }), /malformed Unicode/);
  assert.throws(() => contract.canonicalizeIdentity({ provider: "test", keys: { key: "\udfff" } }), /malformed Unicode/);
});

test("v1 projection digest and strict inputs retain byte and target bounds", () => {
  const normalized = contract.normalizeProjectionCommand(command);
  assert.equal(normalized.payloadJson, JSON.stringify({protocolVersion: 1, producerPluginId: command.producerPluginId, source, tombstone: false, targets}));
  assert.equal(normalized.computedPayloadDigest, createHash("sha256").update(normalized.payloadJson).digest("hex"));
  assert.throws(() => contract.applyProjectionInputSchema.parse({...command, extra: true}));
  assert.throws(() => contract.applyProjectionInputSchema.parse({...command, targets: [...targets, ...targets]}), /duplicate/);
  assert.throws(() => contract.applyProjectionInputSchema.parse({...command, tombstone: true}), /tombstone/);
  assert.throws(() => contract.applyProjectionInputSchema.parse({...command, payloadDigest: "0".repeat(64)}), /digest/i);
  assert.throws(() => contract.canonicalizeResource(contract.urlResource("https://example.test/"+"a".repeat(512), {label:"Large"})), /512-byte/);
  assert.throws(() => contract.canonicalizeResource({...source,presentation:{label:"é".repeat(129)}}), /256-byte/);
});

test("shared thread/URL policy and picker helpers preserve local validation", () => {
  assert.equal(contract.normalizeThreadOrUrlReference(source).provider, "bb");
  assert.doesNotThrow(() => contract.normalizeThreadOrUrlReference({...source,presentation:{label:"Source",url:"/threads/thr_source"}}));
  assert.throws(() => contract.normalizeThreadOrUrlReference({...source,presentation:{label:"Source",url:"/threads/thr_wrong"}}), /match its thread identity/);
  assert.equal(contract.normalizeThreadOrUrlReference(contract.urlResource("https://example.test", {label:"Site"})).keys.href, "https://example.test/");
  assert.throws(() => contract.normalizeThreadOrUrlReference(contract.machineMonitorResource()), /exact BB threads/);
  assert.throws(() => contract.normalizeThreadOrUrlReference(contract.urlResource("https://example.test/?TOKEN=x",{label:"Unsafe"})), /credential-shaped/);
  assert.equal(contract.hasSensitiveUrlParameter(new URL("https://example.test/#secret=x")), true);
  assert.equal(contract.referenceLabelError("  "), "Give this external reference a name.");
  assert.equal(contract.referenceLabelError("é".repeat(129)), "Reference names are limited to 256 UTF-8 bytes.");
  assert.equal(contract.referenceLabelError("é".repeat(128)), null);
});

test("describe negotiates v1 and only unknown_method permits legacy fallback", async () => {
  for (const versions of [[1], [1,2]]) {
    const client = createCrossReferencesClient(sdkFor(async ({pluginId,method,input,signal}) => {
      assert.equal(pluginId, "alternative-owner"); assert.equal(method, "crossReferences.describe"); assert.equal(input,null); assert.ok(signal);
      return {protocol:"cross-references",versions,extra:true};
    }), "alternative-owner");
    assert.deepEqual(await client.describe(), {protocol:"cross-references",version:1,legacy:false});
  }
  const legacy = createCrossReferencesClient(sdkFor(async () => {throw {code:"unknown_method",status:404};}));
  assert.equal((await legacy.describe()).legacy, true);
  for (const response of [{protocol:"wrong",versions:[1]}, {protocol:"cross-references",versions:[]}, {protocol:"cross-references",versions:[2]}, {protocol:"cross-references",versions:[1.5]}, {protocol:"cross-references",versions:Array(17).fill(1)}])
    await assert.rejects(createCrossReferencesClient(sdkFor(async () => response)).describe());
  for (const error of [{code:"plugin_not_found",status:404}, {code:"plugin_disabled",status:503}, {status:404}])
    await assert.rejects(createCrossReferencesClient(sdkFor(async () => {throw error;})).describe(), e => e === error);
});

test("client validates before transport and independently parses malformed/oversized output", async () => {
  let calls = 0;
  const client = createCrossReferencesClient(sdkFor(async () => {calls++;return {outcome:"applied",currentRevision:1,currentDigest:command.payloadDigest};}));
  await assert.rejects(client.applyProjection({...command,payloadDigest:"0".repeat(64)}));
  assert.equal(calls,0);
  assert.equal((await client.applyProjection(command)).outcome,"applied");
  await assert.rejects(createCrossReferencesClient(sdkFor(async () => ({projection:"bad"}))).getProjection({producerPluginId:"fixture-owner",source:{provider:source.provider,keys:source.keys}}));
  await assert.rejects(createCrossReferencesClient(sdkFor(async () => ({protocol:"cross-references",versions:[1],extra:"a".repeat(contract.LIMITS.responseBytes)}))).describe(), /byte limit/);
});

test("calls enforce deadlines against uncooperative transports and cancel without retry", async () => {
  let calls = 0; let transportSignal;
  const client = createCrossReferencesClient(sdkFor(({signal}) => {calls++;transportSignal=signal;return new Promise(() => {});}),undefined,{callMs:10,describeMs:10});
  await assert.rejects(client.applyProjection(command), error => error.code === "timeout");
  assert.equal(transportSignal.aborted,true); assert.equal(calls,1);
  const abort = new AbortController();
  const request = client.describe(abort.signal); abort.abort();
  await assert.rejects(request, error => error.name === "AbortError");
  assert.equal(transportSignal.aborted,true); assert.equal(calls,2);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(client.describe(alreadyAborted.signal), error => error.name === "AbortError");
  assert.equal(calls,2);
  assert.throws(() => createCrossReferencesClient(sdkFor(async () => null),undefined,{callMs:5001}), /Budget/);
});

// Kit self-proof checks the acceptance assertions; adopter proof separately
// passes actual central plugin registration into the same production client.
function fixtureSdk({badGet=false,badBacklink=false}={}) {
  let applied = false;
  return sdkFor(async ({method}) => {
    if (method === "crossReferences.describe") return {protocol:"cross-references",versions:[1]};
    if (method === "applyProjection") {const outcome=applied?"duplicate":"applied";applied=true;return {outcome,currentRevision:1,currentDigest:command.payloadDigest};}
    if (method === "getProjection") return {projection:badGet?null:{producerPluginId:command.producerPluginId,source,revision:1,mutationId:command.mutationId,payloadDigest:command.payloadDigest,tombstone:false,targets}};
    if (method === "listBacklinks") return {rows:badBacklink?[]:[{source,producerPluginId:command.producerPluginId,revision:1,targetPresentation:targets[0].presentation,position:0}],total:badBacklink?0:1,nextCursor:null};
    throw Error("Unexpected fixture RPC");
  });
}
test("conformance kit drives apply/duplicate/get/backlinks and detects broken acceptance", async () => {
  const result = await runCrossReferencesConformance({sdk:fixtureSdk(),command});
  assert.equal(result.level,"source-conformance");
  assert.deepEqual(result.checks,["describe-or-legacy-v1","apply-acceptance","duplicate-acceptance","get-acceptance","backlinks-acceptance"]);
  await assert.rejects(runCrossReferencesConformance({sdk:fixtureSdk({badGet:true}),command}), /getProjection/);
  await assert.rejects(runCrossReferencesConformance({sdk:fixtureSdk({badBacklink:true}),command}), /listBacklinks/);
});

test('emitted V2 client negotiates2, targets owner explicitly and admits bytes before tolerant decoding',async()=>{
 const {createCrossReferencesV2Client}=await import('../dist/bb.js');let calls=0;
 const client=createCrossReferencesV2Client(sdkFor(async({pluginId,method,input,outputSchema})=>{calls++;assert.equal(pluginId,'fixture-owner');
  if(method==='crossReferences.describe')return outputSchema.parse({protocol:'cross-references',versions:[1,2],extra:true});
  return outputSchema.parse({version:2,status:'unavailable',reason:'read-budget',retryable:true,extra:true});
 }),'fixture-owner');assert.equal((await client.describe()).version,2);
 const page=await client.listMentions({version:2,query:{kind:'authored-url',href:'https://example.test/a'}});assert.equal(page.status,'unavailable');assert.equal(calls,2);
 const bad=createCrossReferencesV2Client(sdkFor(async()=>({version:2,status:'unavailable',reason:'read-budget',retryable:true,padding:'x'.repeat(1048576)})));await assert.rejects(bad.listMentions({version:2,query:{kind:'authored-url',href:'https://example.test/a'}}),/byte bound/);
 const v1=createCrossReferencesV2Client(sdkFor(async()=>({protocol:'cross-references',versions:[1]})));await assert.rejects(v1.describe(),/V2 unavailable/);
});

test('V2 registration preserves schema validation and exact SDK issue paths',async()=>{
 const {crossReferencesV2RpcContract,registerCrossReferencesV2}=await import('../dist/bb.js');
 const method=crossReferencesV2RpcContract.crossReferencesV2ListMentions;
 const input={version:2,query:{kind:'authored-url',href:'https://example.test/a'}};
 const valid=await method.input['~standard'].validate(input);
 assert.deepEqual(valid,{value:input});
 for(const invalid of [{...input,extra:true},{...input,query:{kind:'authored-url',href:'javascript:alert(1)'}}]){
  const result=await method.input['~standard'].validate(invalid);
  assert.ok(result.issues.length>0);assert.equal('value' in result,false);
  for(const issue of result.issues){assert.equal(typeof issue.message,'string');assert.ok(Array.isArray(issue.path));}
 }
 const output={version:2,status:'unavailable',reason:'read-budget',retryable:true,added:{value:true}};
 assert.deepEqual(await method.output['~standard'].validate(output),{value:output});
 assert.ok((await method.output['~standard'].validate({...output,retryable:'yes'})).issues.length>0);
 const handlers={crossReferencesV2ListMentions:()=>output,crossReferencesV2ResolveLookup:()=>({version:2,state:'unrecognized',options:[],reasons:[]})};
 let registrations=0;
 registerCrossReferencesV2({rpc:{register(contract,registered){registrations++;assert.equal(contract,crossReferencesV2RpcContract);assert.equal(registered,handlers);}}},handlers);
 assert.equal(registrations,1);
});

test('producer SDK boundary is strict before handlers, tolerant on outputs and byte admitted before decode',async()=>{
 const {crossReferencesProducerRpcContract,createCrossReferencesProducerClient,registerCrossReferencesProducer}=await import('../dist/bb.js');
 const method=crossReferencesProducerRpcContract[contract.PRODUCER_METHODS.getState],source=contract.verifiedFileIdentity({kind:'thread-storage',threadId:'thr_client',path:'BRIEF.md'}),input={version:1,producerPluginId:'thread-brief',source};
 assert.deepEqual(await method.input['~standard'].validate(input),{value:input});assert.ok((await method.input['~standard'].validate({...input,extra:true})).issues.length);assert.ok((await method.input['~standard'].validate({...input,padding:'x'.repeat(16384)})).issues.length);
 const state={version:1,projection:null,evidence:null,status:null,revisionHighWater:0,future:true};assert.deepEqual(await method.output['~standard'].validate(state),{value:state});let calls=0;
 const client=createCrossReferencesProducerClient(sdkFor(async({method,pluginId})=>{calls++;assert.equal(pluginId,'fixture-owner');return method===contract.PRODUCER_METHODS.describe?{...contract.producerDescribe(),future:true}:state;}),'fixture-owner');await client.describe();assert.equal((await client.getState(input)).future,true);assert.equal(calls,2);
 await assert.rejects(createCrossReferencesProducerClient(sdkFor(async()=>{throw {code:'unknown_method'};})).describe(),e=>e.code==='unknown_method');
 const tooBig=createCrossReferencesProducerClient(sdkFor(async()=>({...state,padding:'x'.repeat(1048576)})));await assert.rejects(tooBig.getState(input),/byte bound/);
 let registered;const handlers={'crossReferencesProducer.describe':contract.producerDescribe,crossReferencesProducerV1GetState:()=>state,crossReferencesProducerV1Apply:()=>{throw Error('not invoked');},crossReferencesProducerV1ReportStatus:()=>{throw Error('not invoked');}};registerCrossReferencesProducer({rpc:{register:(schema,h)=>{assert.equal(schema,crossReferencesProducerRpcContract);registered=h;}}},handlers);assert.equal(registered,handlers);
});
test('producer write timeout/cancellation is one transport attempt, without legacy fallback',async()=>{
 const {createCrossReferencesProducerClient}=await import('../dist/bb.js');let calls=0,signal;
 const client=createCrossReferencesProducerClient(sdkFor(request=>{calls++;signal=request.signal;return new Promise(()=>{});}),undefined,{callMs:10});
 const file={kind:'thread-storage',threadId:'thr_client',path:'BRIEF.md'},source=contract.verifiedFileIdentity(file),status={state:'over-limit',sourceContentRevision:contract.sha256Hex('new'),limits:['target-count']};
 const input={version:1,producerPluginId:'thread-brief',source,sourceFile:file,attemptRevision:2,expectedRevision:0,status,statusDigest:contract.briefStatusDigest('thread-brief',source,file,status)};await assert.rejects(client.reportStatus(input),e=>e.code==='timeout');assert.equal(calls,1);assert.equal(signal.aborted,true);
});
