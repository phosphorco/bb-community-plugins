import { bindMessageAdmission, type AdmissionClientV1, type AdmissionBindingV1 } from "@phosphorco/bb-message-admission/bb";
import { PublishInputV1Schema, publicationFingerprint, type PublicationV1, type PublicationRef, type PublishInputV1, type RegistrationV1 } from "@phosphorco/bb-message-admission/protocol";
import type { PreviewPlacementInputV1 } from "@phosphorco/bb-message-admission/protocol";
import { PlacementUnavailable } from "../contracts/placement.ts";
import { GLOBAL_CATALOG } from "../contracts/catalog.ts";
import { VERSION } from "../contracts/model.ts";
import { canonical, fingerprint } from "../contracts/hash.ts";
import type { Transport, TokenCounter } from "../evaluation/evaluator.ts";
import type { Store } from "../state/store.ts";
import { savedBasis } from "../suites/runner.ts";
import { createAdmissionLedger } from "./ledger.ts";
import { createAdmissionEvaluator } from "./evaluator.ts";
import { nativeEvaluator } from "./native-evaluator.ts";
import { policyBytes, type AdmissionSnapshot } from "./snapshot.ts";
import { listRecentDecisions } from "./decisions.ts";
import type { RecentDecisionsInput } from "./decisions-contract.ts";
export const ADMISSION_PROVIDER = "message-rules";
export type TestPublicationRequest = {
  testProjectId: string;
  scope: "test-project";
  requestId: string;
  basis: string;
  expectedActivePublication: PublicationRef | null;
};
export function createNativeAdmission(
  bb: unknown,store: Store,
  transportFor: (snapshot: AdmissionSnapshot) => Transport,
  countTokens?: TokenCounter,
  onStateChange?:()=>void,
) {
  const lifecycle=new AbortController();
  let ledger: ReturnType<typeof createAdmissionLedger> | null=null;
  let evaluator: ReturnType<typeof nativeEvaluator> | null=null;
  let binding: AdmissionBindingV1 | null=null, registration: RegistrationV1 | null=null;
  let generationProof: PublicationRef | null=null;
  let recoveryReason="Native generation has no confirmed publication binding.";
  let activated=false;
  let disposed=false, registrationError: string | null=null, lastPublication: PublicationV1 | null=null;
  const errorText=(error: unknown)=>error instanceof Error?error.message:String(error);
  // The native journal owns publication identity/effects. This table keeps the
  // exact first submitted bytes across lost acknowledgements; it is not an
  // active pointer and never authorizes publication from save/migration/startup.
  store.db.exec(`CREATE TABLE IF NOT EXISTS mr_admission_publications(
    operation_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_basis TEXT NOT NULL,
    input TEXT NOT NULL,state TEXT NOT NULL,result TEXT,error TEXT);`);
  const ready=(async()=>{
    binding=await bindMessageAdmission(bb);
    if (binding.status!=="available"||disposed) return;
    const client=binding.client;
    try {
      registration=await client.registerEvaluator({version:1,evaluatorVersion:VERSION},(input,context)=> {
        if(lifecycle.signal.aborted) throw Error("Message Rules evaluator generation retired.");
        // Staging a new plugin instance must not retire the still-active old
        // generation's paid work. Native invokes this only after activation;
        // recover/fence the feature journal at the first active assessment.
        if(!ledger) ledger=createAdmissionLedger(store.db);
        if(!evaluator) evaluator=nativeEvaluator(createAdmissionEvaluator(ledger,transportFor,countTokens),ADMISSION_PROVIDER);
        return evaluator(input,{...context,signal:AbortSignal.any([context.signal,lifecycle.signal])});
      });
    } catch(error) {registrationError=errorText(error);}
  })();
  const client=async():Promise<AdmissionClientV1>=>{
    await ready;
    if(disposed||binding?.status!=="available"||!registration||registrationError)
      throw Error(registrationError??(binding?.status!=="available"?binding?.detail:"Admission evaluator is disposed or unregistered.")??"Native admission is unavailable.");
    return binding.client;
  };
  async function state() {
    await ready;
    if(binding?.status!=="available")
      return {state:binding?.status??"unavailable",reason:binding?.detail??"Admission negotiation unavailable.",activePublication:null,activeKnown:false,generationReady:false};
    if(registrationError||!registration||disposed)
      return {state:"unavailable",reason:registrationError??"Admission evaluator is not registered.",activePublication:lastPublication,activeKnown:false,generationReady:false};
    try {
      lastPublication=await binding.client.readActivePublication({version:1,providerId:ADMISSION_PROVIDER});
      const generationReady=!!lastPublication&&canonical(lastPublication.publication)===canonical(generationProof);
      const enrolled=lastPublication?.enrollment.mode==="enforce";
      return {state:enrolled&&!generationReady?"unavailable":"available",
        reason:enrolled?(generationReady?"Exact prior explicit policy is bound to this active evaluator generation. Saved edits do not update it.":generationProof?"Persisted publication differs from this generation's confirmed binding. No newer publication was rebound or overwritten.":recoveryReason):"Native admission is available. Saved rules are inactive until explicit testing-project publication.",
        activePublication:lastPublication,activeKnown:true,generationReady};
    } catch(error) {
      return {state:"unavailable",reason:errorText(error),activePublication:lastPublication,activeKnown:false,generationReady:false};
    }
  }
  const operationId=(projectId: string,requestId: string)=>fingerprint({projectId,requestId});
  const operation=(projectId: string,requestId: string)=>({namespace:ADMISSION_PROVIDER+"/test/"+projectId,operationId:operationId(projectId,requestId)});
  async function lookup(input: Pick<TestPublicationRequest,"testProjectId"|"scope"|"requestId">) {
    if(input.scope!=="test-project"||input.testProjectId===GLOBAL_CATALOG) throw Error("An explicit BB testing project is required.");
    const c=await client(),op=operation(input.testProjectId,input.requestId);
    const result=await c.lookupOperation({version:1,operation:op});
    if(result.record?.kind==="publication")
      store.db.prepare("UPDATE mr_admission_publications SET state='reconciled',result=?,error=NULL WHERE operation_id=?").run(canonical(result),op.operationId);
    return {operation:op,reconciliation:result,admission:await state()};
  }
  async function publish(input: TestPublicationRequest,disable=false) {
    if(input.scope!=="test-project"||input.testProjectId===GLOBAL_CATALOG)
      throw Error("Publication requires one explicit BB testing project.");
    const c=await client(),op=operation(input.testProjectId,input.requestId);
    const requestBasis=fingerprint({...input,disable});
    const previous=store.db.prepare("SELECT request_basis FROM mr_admission_publications WHERE operation_id=?").get(op.operationId) as {request_basis:string}|undefined;
    if(previous) {
      if(previous.request_basis!==requestBasis) throw Error("Publication request ID was reused with different intent; preserve the original and reconcile it.");
      // A retry is a read of the same native operation, even if the saved
      // catalogue changed. It cannot republish newly fetched mutable rules.
      return lookup(input);
    }
    const project=store.get(GLOBAL_CATALOG);
    if(!project||savedBasis(project)!==input.basis) throw Error("Saved catalog changed. Refresh and preserve your intended publication.");
    const active=await c.readActivePublication({version:1,providerId:ADMISSION_PROVIDER});
    if(canonical(active?.publication??null)!==canonical(input.expectedActivePublication))
      throw Error("Active native publication changed. Read its authoritative pointer before publishing.");
    // Deactivation is scoped too: a test operation must not disable another
    // project's publication after an unrelated enrollment change.
    if(active?.enrollment.mode==="enforce"&&active.enrollment.projectIds.some(id=>id!==input.testProjectId))
      throw Error("Active publication includes another project. This testing-project operation cannot replace or disable it.");
    const value: PublishInputV1={version:1,operation:op,providerId:ADMISSION_PROVIDER,
      expectedActivePublication:input.expectedActivePublication,snapshotBytes:policyBytes(project,input.basis),
      configurationVersion:String(project.revision),evaluatorVersion:VERSION,
      enrollment:disable?{mode:"disabled",projectIds:[]}:{mode:"enforce",projectIds:[input.testProjectId]}};
    store.db.prepare("INSERT INTO mr_admission_publications(operation_id,project_id,request_basis,input,state) VALUES(?,?,?,?,'invoking')").run(op.operationId,input.testProjectId,requestBasis,canonical(value));
    try {
      const result=await c.publish(value);
      if(result.status==="published"&&result.publication&&canonical(result.activePublication)===canonical(result.publication.publication)) {
        generationProof=result.publication.publication;
        recoveryReason="Explicit publication confirmed for this evaluator generation.";
      }
      store.db.prepare("UPDATE mr_admission_publications SET state='observed',result=?,error=NULL WHERE operation_id=?").run(canonical(result),op.operationId);
      return {operation:op,publication:result,admission:await state()};
    } catch(error) {
      store.db.prepare("UPDATE mr_admission_publications SET state='unknown',error=? WHERE operation_id=?").run(errorText(error),op.operationId);
      throw Error("Publication outcome requires lookup of the same request ID. "+errorText(error));
    }
  }
  async function recoverPublication(signal:AbortSignal) {
    const c=await client();
    if(signal.aborted||disposed)return;
    const active=await c.readActivePublication({version:1,providerId:ADMISSION_PROVIDER});
    lastPublication=active;
    if(!active||active.enrollment.mode!=="enforce") {
      recoveryReason="No prior explicit live enrollment to recover. Saved rules remain inactive.";return;
    }
    if(canonical(active.publication)===canonical(generationProof))return;
    const row=store.db.prepare("SELECT project_id,input FROM mr_admission_publications WHERE operation_id=?").get(active.operation.operationId) as {project_id:string;input:string}|undefined;
    if(!row) {recoveryReason="Persisted enrollment is not bound to this generation: original explicit publication input is unavailable.";return;}
    const input=PublishInputV1Schema.parse(JSON.parse(row.input));
    const {operation,expectedActivePublication,...content}=input;
    if(input.providerId!==ADMISSION_PROVIDER||input.evaluatorVersion!==VERSION||
      input.enrollment.mode!=="enforce"||input.enrollment.projectIds.length!==1||input.enrollment.projectIds[0]!==row.project_id||
      input.operation.namespace!==ADMISSION_PROVIDER+"/test/"+row.project_id||
      canonical(input.operation)!==canonical(active.operation)||
      input.snapshotBytes!==active.snapshotBytes||input.configurationVersion!==active.configurationVersion||
      input.evaluatorVersion!==active.evaluatorVersion||canonical(input.enrollment)!==canonical(active.enrollment)||
      active.publication.fingerprint!==await publicationFingerprint(content,Number.MAX_SAFE_INTEGER)) {
      recoveryReason="Persisted publication does not match the exact prior explicit input and current evaluator version; no recovery write occurred.";return;
    }
    // Even an unknown local acknowledgement must first resolve to this exact
    // successful native publication. No missing/ambiguous effect is replayed.
    const lookup=await c.lookupOperation({version:1,operation:input.operation});
    if(signal.aborted||disposed)return;
    if(lookup.status!=="found"||lookup.record?.kind!=="publication"||lookup.record.status!=="accepted"||
      !lookup.record.publication||canonical(lookup.record.publication)!==canonical(active)) {
      recoveryReason="Original publication outcome is unproved or no longer active. Reconcile it explicitly; no recovery write occurred.";return;
    }
    store.db.prepare("UPDATE mr_admission_publications SET state='reconciled',result=?,error=NULL WHERE operation_id=?").run(canonical(lookup),input.operation.operationId);
    const latest=await c.readActivePublication({version:1,providerId:ADMISSION_PROVIDER});
    lastPublication=latest;
    if(signal.aborted||disposed)return;
    if(canonical(latest)!==canonical(active)) {recoveryReason="A newer native publication replaced the recovery target; it was not overwritten.";return;}
    const key="admission-rebind/"+registration!.generation;
    if(store.db.prepare("SELECT value FROM mr_metadata WHERE key=?").get(key)) {
      recoveryReason="This generation already attempted publication recovery. No uncertain recovery call is automatically replayed.";return;
    }
    const note=(state:string,details:unknown)=>store.db.prepare("INSERT OR REPLACE INTO mr_metadata(key,value) VALUES(?,?)").run(key,canonical({state,operation:input.operation,publication:active.publication,details}));
    note("invoking",null);
    recoveryReason="Exact prior explicit publication is being rebound to this generation.";
    try {
      // Exact original operation/input, including its old expected pointer.
      // Native successful-operation dedup binds current generation before CAS;
      // this is never a newly authored publication or updated saved policy.
      const receipt=await c.publish(input);
      note("observed",receipt);
      if(signal.aborted||disposed)return;
      const after=await c.readActivePublication({version:1,providerId:ADMISSION_PROVIDER});
      lastPublication=after;
      if(receipt.status==="published"&&receipt.publication&&canonical(receipt.publication)===canonical(active)&&
        canonical(receipt.activePublication)===canonical(active.publication)&&canonical(after)===canonical(active)) {
        generationProof=active.publication;recoveryReason="Prior explicit immutable publication recovered for this evaluator generation.";
      } else recoveryReason="Native publication changed or recovery did not confirm the exact current binding. No newer policy was overwritten.";
    } catch(error) {
      note("unknown",errorText(error));
      recoveryReason="Publication generation recovery is uncertain; no automatic retry. "+errorText(error);
    }
  }
  async function start(signal:AbortSignal) {
    if(signal.aborted||disposed)return;
    if(!activated) {
      activated=true;
      try {await recoverPublication(signal);}
      catch(error) {recoveryReason="Publication generation remains unbound because startup recovery did not complete. "+errorText(error);}
      if(!signal.aborted&&!disposed)onStateChange?.();
    }
    if(signal.aborted||disposed) {generationProof=null;recoveryReason="Activated recovery stopped; this generation is not confirmed ready.";return;}
    // One activated lifecycle owner. No poller, timer or detached write.
    await new Promise<void>(resolve=>{
      const abort=()=>{signal.removeEventListener("abort",abort);generationProof=null;recoveryReason="Activated recovery service stopped; this generation is not confirmed ready.";resolve();};
      signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    });
  }
  async function previewPlacement(input:PreviewPlacementInputV1,signal:AbortSignal) {
    await ready;
    if(disposed||signal.aborted)throw new PlacementUnavailable("unknown","Native placement simulation cancelled or plugin retired.");
    if(binding?.status!=="available")throw new PlacementUnavailable(binding?.status==="unavailable"?"unknown":"unsupported",binding?.detail??"Native admission is unavailable.");
    if(!binding.capabilities.placement)throw new PlacementUnavailable("unsupported","This host does not support native previewPlacement. Content fixtures remain usable.");
    return binding.client.previewPlacement(input);
  }
  async function dispose() {
    if(disposed) return;
    disposed=true;generationProof=null;lifecycle.abort();ledger?.dispose();
    await ready;
    if(binding?.status==="available"&&registration)
      try {await binding.client.unregisterEvaluator({version:1,registrationId:registration.registrationId,generation:registration.generation});}
      catch(error) { registrationError="Native unregister outcome unknown; lifecycle must reconcile. "+errorText(error); }
  }
  return {ready,state,start,previewPlacement,
    listRecentDecisions:(input:RecentDecisionsInput)=>listRecentDecisions(store.db,input,async()=>{
      await ready;
      if(disposed||binding?.status!=="available") throw Error(binding?.status!=="available"?binding?.detail??"Native admission unavailable.":"Admission plugin disposed.");
      return binding.client;
    }),
    publishTestPolicy:(input:TestPublicationRequest)=>publish(input),deactivateTestPolicy:(input:TestPublicationRequest)=>publish(input,true),lookupTestPublication:lookup,dispose,get ledger(){return ledger;}};
}
