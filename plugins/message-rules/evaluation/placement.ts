import { PreviewPlacementResultV1Schema, submissionFingerprint } from "@phosphorco/bb-message-admission/protocol";
import type { Fixture } from "../contracts/fixture.ts";
import type { Evaluation } from "../contracts/model.ts";
import { canonical, fingerprint } from "../contracts/hash.ts";
import { PlacementUnavailable, type PlacementPort, type NativePlacementObservation } from "../contracts/placement.ts";

// This adapts fixture data and policy preferences only. Placement itself belongs
// exclusively to the public native port; no selector or fallback lives here.
export async function previewFixturePlacement(
  fixture:Fixture,evaluation:Evaluation,projectId:string|null|undefined,
  port:PlacementPort|undefined,signal:AbortSignal,
):Promise<NativePlacementObservation> {
  if(!fixture.nativePlacement)throw Error("No native placement assertion in this fixture.");
  if(evaluation.policy!=="allow")return {state:"not-run",reason:"Native placement requires resolved content admission. No simulation ran."};
  if(!port)return {state:"unsupported",reason:"Native previewPlacement is unavailable; no local planner substitutes for this assertion."};
  try {
    const input=structuredClone(fixture.nativePlacement.input),candidate=input.candidate;
    const expectedContext={messageText:fixture.capture.message,projectTitle:fixture.capture.projectTitle??null,
      senderTitle:fixture.capture.senderTitle,destinationTitle:fixture.capture.destinationTitle};
    if(candidate.projectId!==(projectId??null)||candidate.threadId!==fixture.capture.provenance.destinationId||
      candidate.source.senderThreadId!==fixture.capture.provenance.senderId||
      canonical(candidate.policyContext)!==canonical(expectedContext))
      throw Error("Native placement candidate must match this fixture's message, routing IDs and titles. Supply explicit project_id, sender_id and destination_id where needed.");
    const action=evaluation.route?.action??"proceed";
    if(action==="steer")candidate.requestedIntent.mode="steer";
    if(action==="queue"||action==="queue-batched"){
      candidate.requestedIntent.mode="queue";
      candidate.requestedIntent.membership=action==="queue"?"separate":"join-next-ordinary";
    }
    // Preserve schedule, execution choices, source and original identity. The
    // public fingerprint covers the effective simulation candidate exactly.
    const {operation,requestFingerprint,...content}=candidate;
    candidate.requestFingerprint=await submissionFingerprint(content,Number.MAX_SAFE_INTEGER);
    if(signal.aborted)return {state:"unknown",reason:"Native placement simulation cancelled before invocation."};
    const work=Promise.resolve(port(input,signal));
    const result=await new Promise<Awaited<typeof work>>((resolve,reject)=>{
      const abort=()=>{cleanup();reject(Error("Native placement simulation cancelled; late response ignored."));};
      const cleanup=()=>signal.removeEventListener("abort",abort);
      signal.addEventListener("abort",abort,{once:true});
      work.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
      if(signal.aborted)abort();
    });
    if(signal.aborted)return {state:"unknown",reason:"Native placement response arrived after cancellation."};
    return {state:"simulated",inputHash:fingerprint(input),result:PreviewPlacementResultV1Schema.parse(result)};
  } catch(error) {
    return {state:error instanceof PlacementUnavailable?error.state:"unknown",reason:error instanceof Error?error.message:String(error)};
  }
}
