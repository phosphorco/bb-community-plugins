import { randomUUID } from "node:crypto";
import type { PreviewPlacementInputV1 } from "@phosphorco/bb-message-admission/protocol";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { PlacementUnavailable } from "../contracts/placement.ts";
import { GLOBAL_CATALOG } from "../contracts/catalog.ts";
import { VERSION } from "../contracts/model.ts";
import { canonical, fingerprint } from "../contracts/hash.ts";
import type { Transport, TokenCounter } from "../evaluation/evaluator.ts";
import type { Store } from "../state/store.ts";
import { savedBasis } from "../suites/runner.ts";
import { policyBytes, readPolicyBytes, type AdmissionSnapshot } from "./snapshot.ts";
import { listRecentDecisions } from "./decisions.ts";
import type { RecentDecisionsInput } from "./decisions-contract.ts";
import { decideSenderMessage } from "./sender.ts";

export const ADMISSION_PROVIDER = "message-rules";
export const senderPolicyRefSchema = z.strictObject({ policyId:z.string().min(1), fingerprint:z.string().min(1) });
export type SenderPolicyRef = z.infer<typeof senderPolicyRefSchema>;
export type TestPublicationRequest = {
  testProjectId:string; scope:"test-project"; requestId:string; basis:string;
  expectedActivePolicy:SenderPolicyRef|null;
};
type Policy = { ref:SenderPolicyRef; projectId:string; enabled:boolean; snapshotBytes:string; createdAt:string };
const ACTIVE = "sender-policy-active-v1";

/** Plugin owns activation; native owns applying the synchronous hook decision. */
export function createNativeAdmission(
  bb:BbPluginApi, store:Store,
  _transportFor:(snapshot:AdmissionSnapshot)=>Transport,
  _countTokens?:TokenCounter, onStateChange?:()=>void,
) {
  let disposed=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS mr_sender_policy_operations(
    operation_id TEXT PRIMARY KEY,request_basis TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mr_sender_decisions(
    id TEXT PRIMARY KEY,created_at TEXT NOT NULL,thread_id TEXT NOT NULL,sender_thread_id TEXT,
    policy_id TEXT NOT NULL,decision TEXT NOT NULL);`);
  const active=():Policy|null=>{
    const row=store.db.prepare("SELECT value FROM mr_metadata WHERE key=?").get(ACTIVE) as {value:string}|undefined;
    return row?JSON.parse(row.value) as Policy:null;
  };
  bb.experimental_hooks.on("message.dispatch", context=>{
    const policy=active();
    if(disposed) return {action:"reject",message:"Message Rules is being reloaded. Retry once its plugin is running."};
    if(!policy?.enabled||policy.projectId!==context.project.id) return {action:"proceed"};
    const decision=decideSenderMessage(context,readPolicyBytes(policy.snapshotBytes));
    store.db.prepare("INSERT INTO mr_sender_decisions VALUES(?,?,?,?,?,?)").run(randomUUID(),new Date().toISOString(),context.thread.id,context.senderThreadId,policy.ref.policyId,canonical(decision));
    return decision;
  });
  const ready=Promise.resolve();
  async function state(){
    const policy=active();
    return {state:disposed?"unavailable":"available",reason:disposed?"Message Rules plugin disposed.":"Native sender hook: static accept/reject only. Paid JEV and delivery rewriting are refused with an explanation. Explicit Send now bypasses native policy; edited resends and compaction are outside this hook.",
      activeKnown:true,generationReady:!disposed,
      activePolicy:policy?{ref:policy.ref,projectId:policy.projectId,enabled:policy.enabled,createdAt:policy.createdAt,catalogRevision:readPolicyBytes(policy.snapshotBytes).catalogRevision}:null,
      recentSenderDecisions:(store.db.prepare("SELECT created_at,thread_id,sender_thread_id,policy_id,decision FROM mr_sender_decisions ORDER BY rowid DESC LIMIT 10").all() as Array<{created_at:string;thread_id:string;sender_thread_id:string|null;policy_id:string;decision:string}>).map(row=>({...row,decision:JSON.parse(row.decision)}))};
  }
  const publish=store.db.transaction((input:TestPublicationRequest,disable=false)=>{
    if(disposed)throw Error("Message Rules plugin is disposed.");
    if(input.scope!=="test-project"||input.testProjectId===GLOBAL_CATALOG)throw Error("One explicit testing project is required.");
    const operationId=fingerprint({projectId:input.testProjectId,requestId:input.requestId});
    const requestBasis=fingerprint({...input,disable});
    const prior=store.db.prepare("SELECT request_basis,result FROM mr_sender_policy_operations WHERE operation_id=?").get(operationId) as {request_basis:string;result:string}|undefined;
    if(prior){if(prior.request_basis!==requestBasis)throw Error("Request ID reused with different policy intent.");return JSON.parse(prior.result);}
    const project=store.get(GLOBAL_CATALOG);
    if(!project||savedBasis(project)!==input.basis)throw Error("Saved catalog changed. Refresh before activating its policy.");
    const previous=active();
    if(canonical(previous?.ref??null)!==canonical(input.expectedActivePolicy))throw Error("Active sender policy changed. Read status before replacing it.");
    if(previous?.enabled&&previous.projectId!==input.testProjectId)throw Error("Another project has the active policy. Deactivate that project explicitly first.");
    const bytes=policyBytes(project,input.basis),policy:Policy={ref:{policyId:operationId,fingerprint:fingerprint(bytes)},projectId:input.testProjectId,enabled:!disable,snapshotBytes:bytes,createdAt:new Date().toISOString()};
    store.db.prepare("INSERT OR REPLACE INTO mr_metadata(key,value) VALUES(?,?)").run(ACTIVE,canonical(policy));
    const result={operationId,status:"activated",policy:{ref:policy.ref,projectId:policy.projectId,enabled:policy.enabled}};
    store.db.prepare("INSERT INTO mr_sender_policy_operations VALUES(?,?,?)").run(operationId,requestBasis,canonical(result));
    return result;
  });
  async function publishAndRead(input:TestPublicationRequest,disable=false){const result=publish(input,disable);onStateChange?.();return {...result,admission:await state()};}
  return {ready,state,
    async start(signal:AbortSignal){if(signal.aborted)return;await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));},
    async previewPlacement(_input:PreviewPlacementInputV1,_signal:AbortSignal){throw new PlacementUnavailable("unsupported","Native sender hooks do not simulate delivery placement. Static content tests remain available.");},
    listRecentDecisions:(input:RecentDecisionsInput)=>listRecentDecisions(store.db,input,async()=>{throw Error("Historical admission API retired. These are retained historical callbacks, not current sender-hook decisions.");}),
    publishTestPolicy:(input:TestPublicationRequest)=>publishAndRead(input),
    deactivateTestPolicy:(input:TestPublicationRequest)=>publishAndRead(input,true),
    async lookupTestPublication(input:Pick<TestPublicationRequest,"testProjectId"|"scope"|"requestId">){
      if(input.scope!=="test-project"||input.testProjectId===GLOBAL_CATALOG)throw Error("One explicit testing project is required.");
      const operationId=fingerprint({projectId:input.testProjectId,requestId:input.requestId});
      const row=store.db.prepare("SELECT result FROM mr_sender_policy_operations WHERE operation_id=?").get(operationId) as {result:string}|undefined;
      return {operationId,result:row?JSON.parse(row.result):null,admission:await state()};
    },
    async dispose(){disposed=true;},get ledger(){return null;}};
}
