import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixture } from "../../contracts/fixture.ts";
import { previewFixturePlacement } from "../../evaluation/placement.ts";
import { assertResult } from "../../suites/runner.ts";
import { fixtureSource,placementCases } from "../suites/native-placement.helpers.ts";
import { VERSION, type Evaluation } from "../../contracts/model.ts";
const content=():Evaluation=>({version:VERSION,inputHash:"content",policy:"allow",rules:[],advice:[],errors:[],route:{action:"queue-batched",ruleIds:["queue"]}});
const signal=()=>new AbortController().signal;
test("native assertion grammar uses public strict DTOs and validates complete section/expectation",()=>{
  const scenario=placementCases()[0]!,source=fixtureSource(scenario.input,scenario.result),fixture=parseFixture(source);
  assert.deepEqual(fixture.nativePlacement!.input,scenario.input);
  assert.throws(()=>parseFixture(source.replace('"simulation": true','"simulation": false')));
  assert.throws(()=>parseFixture(source.replace('"status": "join"','"status": "join", "status": "join"')));
  assert.throws(()=>parseFixture(source+'\n# Native placement\n{}'));
});
test("wrong native status, target, ordering or reason codes cannot pass; missing result is unknown",async()=>{
  const scenario=placementCases()[0]!,fixture=parseFixture(fixtureSource(scenario.input,scenario.result)),evaluation=content();
  evaluation.nativePlacement=await previewFixturePlacement(fixture,evaluation,"project-test",async()=>scenario.result,signal());
  assert.equal(assertResult(fixture,evaluation).status,"pass");
  assert.equal(assertResult(fixture,content()).status,"unknown");
  for(const changed of [{...scenario.result,status:"singleton" as const},{...scenario.result,targetGroupId:null},{...scenario.result,orderedOriginalIds:["B","A"]},{...scenario.result,reasons:[{code:"unexpected",message:"extra"}]}]){
    assert.equal(assertResult(fixture,{...evaluation,nativePlacement:{state:"simulated",inputHash:"hash",result:changed}}).status,"fail");
  }
});
test("routing mismatch and rejected content do not invoke native port; cancelled ignored-abort response never becomes pass",async()=>{
  const scenario=placementCases()[0]!,fixture=parseFixture(fixtureSource(scenario.input,scenario.result));
  let calls=0;
  const wrong=parseFixture(fixtureSource(scenario.input,scenario.result));wrong.capture.message="different";
  assert.equal((await previewFixturePlacement(wrong,content(),"project-test",async()=>{calls++;return scenario.result;},signal())).state,"unknown");
  assert.equal((await previewFixturePlacement(fixture,{...content(),policy:"reject"},"project-test",async()=>{calls++;return scenario.result;},signal())).state,"not-run");
  assert.equal(calls,0);
  const abort=new AbortController();let release!:(value:typeof scenario.result)=>void;
  const pending=previewFixturePlacement(fixture,content(),"project-test",async()=>{calls++;return new Promise(resolve=>release=resolve);},abort.signal);
  // Fingerprinting is async; wait until the actual controlled port owns work.
  const {waitUntil}=await import("../helpers.ts");await waitUntil(()=>calls===1);abort.abort();
  const result=await pending;assert.equal(result.state,"unknown");release(scenario.result);
  assert.equal(assertResult(fixture,{...content(),nativePlacement:result}).status,"unknown");
});
