import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdmissionEvaluator } from "../../admission/evaluator.ts";
import { createAdmissionLedger } from "../../admission/ledger.ts";
import { policyBytes } from "../../admission/snapshot.ts";
import { savedBasis } from "../../suites/runner.ts";
import { captured, setup, jevRule, answer } from "../helpers.ts";
function seed() {
  const {store,db}=setup();
  const p=store.saveRule("project",store.get("project")!.revision,jevRule());
  return {db,store,bytes:policyBytes(p,savedBasis(p))};
}
test("frozen evaluation deduplicates native assessment, avoids suite lock, and never reads later catalog", async () => {
  const {db,store,bytes}=seed(), ledger=createAdmissionLedger(db,"one");
  let calls=0,captures=0;
  const evaluate=createAdmissionEvaluator(ledger,() => async wire => {calls++; return answer(wire);});
  const input={ assessmentId:"first",policyBytes:bytes,candidate:{...captured,projectId:"project"},signal:new AbortController().signal,captureEvidence:async () => {captures++; return captured;} };
  const a=evaluate(input),b=evaluate(input);
  const p=store.get("project")!; store.saveRule("project",p.revision,{...p.rules[0]!,enabled:false});
  const [one,two,other]=await Promise.all([a,b,evaluate({...input,assessmentId:"second"})]);
  assert.equal(one.policy,"reject"); assert.deepEqual(one,two); assert.equal(other.policy,"reject");
  assert.equal(calls,2); assert.equal(captures,2);
  assert.deepEqual(await evaluate(input),one); assert.equal(calls,2);
  ledger.dispose(); db.close();
});
test("native cancellation and generation replacement fence provider responses that ignore abort, without replay", async () => {
  for (const replace of [false,true]) {
    const {db,bytes}=seed(),ledger=createAdmissionLedger(db,"one");
    let release!:()=>void,started!:()=>void,calls=0;
    const invoked=new Promise<void>(r=>started=r),blocked=new Promise<void>(r=>release=r);
    const evaluate=createAdmissionEvaluator(ledger,()=>async wire=>{calls++;started();await blocked;return answer(wire);});
    const abort=new AbortController(),input={assessmentId:"assessment",policyBytes:bytes,candidate:{...captured,projectId:"project"},signal:abort.signal,captureEvidence:async()=>captured};
    const pending=evaluate(input); await invoked;
    const current=replace?createAdmissionLedger(db,"two"):ledger;
    if(!replace) abort.abort();
    if (!replace) assert.equal((await pending).policy,"unknown");
    release(); assert.equal((await pending).policy,"unknown");
    const again=createAdmissionEvaluator(current,()=>async()=>{throw Error("replayed");});
    assert.equal((await again({...input,signal:new AbortController().signal})).policy,"unknown");
    assert.equal(calls,1); assert.notEqual(current.get("assessment")!.state,"complete");
    current.dispose(); db.close();
  }
});
test("outside scope does not capture native evidence or invoke transport",async()=>{
  const {db,bytes}=seed(),ledger=createAdmissionLedger(db,"one");
  const evaluate=createAdmissionEvaluator(ledger,()=>async()=>{throw Error("outside transport");});
  const out=await evaluate({assessmentId:"outside",policyBytes:bytes,candidate:{...captured,projectId:"outside"},signal:new AbortController().signal,captureEvidence:async()=>{throw Error("outside capture");}});
  assert.equal(out.policy,"allow"); ledger.dispose(); db.close();
});
