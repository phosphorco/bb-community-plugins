/** Controlled-port driver. No host implementation, registry, fake DB or dispatch path. */
import { bindMessageAdmission } from './bb.js';
import type { AdmissionClientV1 } from './bb.js';
import * as p from './protocol.js';
export interface ConformanceCheck {name:string;passed:boolean;detail:string}
export interface ConformanceReport {
  evidence:'controlled-port-conformance';subject:string;status:'passed'|'failed'|'unsupported'|'unavailable';
  passed:boolean;checks:ConformanceCheck[];coverage:string[];
}
export interface CapabilityCase {
  name:string; run(client:AdmissionClientV1):Promise<unknown>|unknown;
  verify(result:unknown):void|Promise<void>;
}
/** Each supplied case drives the real caller-owned port through the public binding. */
export async function runCapabilityConformance(input:{bb:unknown;subject:string;cases:CapabilityCase[]}):Promise<ConformanceReport> {
  const bound=await bindMessageAdmission(input.bb);
  if(bound.status!=='available')return {evidence:'controlled-port-conformance',subject:input.subject,status:bound.status==='unsupported'?'unsupported':'unavailable',passed:false,checks:[{name:'capability-negotiation',passed:false,detail:bound.detail}],coverage:[]};
  const checks:ConformanceCheck[]=[{name:'capability-negotiation',passed:true,detail:'Wire v1, advertised methods and configured limits validated.'}];
  if(input.cases.length===0)checks.push({name:'behavioral-cases',passed:false,detail:'No behavioral cases supplied; method shape is insufficient.'});
  for(const test of input.cases){try {await test.verify(await test.run(bound.client));checks.push({name:test.name,passed:true,detail:'Observed through the public binding.'});}catch(error){checks.push({name:test.name,passed:false,detail:error instanceof Error?error.message:String(error)});}}
  const passed=checks.every(c=>c.passed);
  return {evidence:'controlled-port-conformance',subject:input.subject,status:passed?'passed':'failed',passed,checks,coverage:input.cases.map(c=>c.name)};
}
export interface NativeAdmissionCase {
  name:string;submission:p.SubmissionV1;observations:p.RuleObservationV1[];complete:boolean;
  expectedVerdict:'accepted'|'rejected'|'unresolved';expectedAdvice:string[];
  capture?:p.EvidenceRequestV1;
}
export interface NativeAdmissionPorts {
  /** Adapter invokes the real native prepare/commit or public submission route. */
  submit(input:p.SubmissionV1):Promise<p.OperationRecordV1>;
}
function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const same=(a:unknown,b:unknown)=>p.canonicalJson(a,Number.MAX_SAFE_INTEGER)===p.canonicalJson(b,Number.MAX_SAFE_INTEGER);
const operationBasis=(value:p.OperationKey)=>({namespace:value.namespace,operationId:value.operationId});
const originalBasis=(value:p.OriginalRef)=>({originalId:value.originalId,revision:value.revision});
const sourceBasis=(value:p.OriginalSource)=>({senderThreadId:value.senderThreadId,initiator:value.initiator,
  author:value.author,editor:value.editor,origin:value.origin,visibleHumanActivity:value.visibleHumanActivity,
  externalOperation:value.externalOperation===null?null:operationBasis(value.externalOperation)});
const intentBasis=(value:p.RequestedIntent)=>({mode:value.mode,membership:value.membership,
  schedule:value.schedule.kind==='scheduled'?{kind:value.schedule.kind,notBefore:value.schedule.notBefore}:{kind:value.schedule.kind},
  execution:{provider:value.execution.provider,model:value.execution.model,reasoning:value.execution.reasoning,
    serviceTier:value.execution.serviceTier,permissionMode:value.execution.permissionMode,
    canAsk:value.execution.canAsk,configuration:value.execution.configuration}});
const submissionBasis=(value:p.SubmissionV1)=>({version:value.version,operation:operationBasis(value.operation),
  requestFingerprint:value.requestFingerprint,original:originalBasis(value.original),threadId:value.threadId,
  projectId:value.projectId,rawInput:value.rawInput,source:sourceBasis(value.source),requestedIntent:intentBasis(value.requestedIntent),
  policyContext:{messageText:value.policyContext.messageText,projectTitle:value.policyContext.projectTitle,
    senderTitle:value.policyContext.senderTitle,destinationTitle:value.policyContext.destinationTitle},
  kind:value.kind,override:value.override,expectedPlacementWitness:value.expectedPlacementWitness,
  ...(value.feedbackBinding===undefined?{}:{feedbackBinding:value.feedbackBinding===null?null:{
    providerId:value.feedbackBinding.providerId,obligationId:value.feedbackBinding.obligationId,
    original:originalBasis(value.feedbackBinding.original),rejectionAssessmentId:value.feedbackBinding.rejectionAssessmentId,
    recipientThreadId:value.feedbackBinding.recipientThreadId,adviceFingerprint:value.feedbackBinding.adviceFingerprint}})});
const publicationBasis=(value:p.PublicationV1)=>({version:value.version,publication:{providerId:value.publication.providerId,
  publicationId:value.publication.publicationId,fingerprint:value.publication.fingerprint},operation:operationBasis(value.operation),
  snapshotBytes:value.snapshotBytes,configurationVersion:value.configurationVersion,evaluatorVersion:value.evaluatorVersion,
  enrollment:{mode:value.enrollment.mode,projectIds:value.enrollment.projectIds},publishedAt:value.publishedAt});
function assertRequestedOriginal(record:p.OperationRecordV1,submission:p.SubmissionV1):void {
  assert(record.kind==='submission'&&record.requestFingerprint===submission.requestFingerprint&&same(operationBasis(record.operation),operationBasis(submission.operation)),'Native operation changed request identity.');
  assert(record.original!==null&&same(originalBasis(record.original),originalBasis(submission.original)),'Native operation changed the requested original ID/revision.');
  const original=record.acceptedOriginal;
  if(original){
    assert(same(originalBasis(original.original),originalBasis(submission.original)),'Accepted original changed the requested original ID/revision.');
    assert(original.threadId===submission.threadId&&same(original.rawInput,submission.rawInput)&&
      same(sourceBasis(original.source),sourceBasis(submission.source))&&same(intentBasis(original.requestedIntent),intentBasis(submission.requestedIntent))&&
      same(operationBasis(original.operation),operationBasis(submission.operation))&&original.requestFingerprint===submission.requestFingerprint,
      'Accepted original changed canonical destination/source/raw input/requested intent.');
  }
}
const admissionBasis=(record:p.OperationRecordV1)=>({operation:record.operation,requestFingerprint:record.requestFingerprint,kind:record.kind,status:record.status,original:record.original,assessments:record.assessments,acceptedOriginal:record.acceptedOriginal,publication:record.publication,...(Object.hasOwn(record,'acceptanceReceipt')?{acceptanceReceipt:record.acceptanceReceipt}:{})});
/**
 * Publishes only to the explicit caller-owned test project. Evaluator is controlled;
 * native persistence/transactions/submission must be the real implementation.
 * This is not provider, process-restart, registry, UI or consumption proof.
 */
export async function runNativeAdmissionConformance(input:{bb:unknown;subject:string;ports:NativeAdmissionPorts;publication:p.PublishInputV1;cases:NativeAdmissionCase[]}):Promise<ConformanceReport> {
  assert(input.publication.enrollment.mode==='enforce'&&input.publication.enrollment.projectIds.length>0,'Explicit test-project enrollment is required.');
  const fixtures=new Map(input.cases.map(c=>[p.canonicalJson(c.submission.operation,4096),c]));
  assert(fixtures.size===input.cases.length,'Each conformance case needs a distinct operation.');
  for(const test of input.cases)assert(test.submission.projectId!==null&&input.publication.enrollment.projectIds.includes(test.submission.projectId),'Every fixture belongs to the explicit test enrollment.');
  const calls=new Map<string,number>();
  let registration:p.RegistrationV1|null=null;
  let published=false;
  let publishedBasis:string|null=null;
  const cases:CapabilityCase[]=[{
    name:'real-registration-and-immutable-publication',
    async run(client){
      registration=await client.registerEvaluator({version:1,evaluatorVersion:input.publication.evaluatorVersion},async(request,context)=>{
        const key=p.canonicalJson(request.submission.operation,4096),test=fixtures.get(key);
        assert(test,'Unexpected operation reached the controlled evaluator.');
        assert(same(submissionBasis(request.submission),submissionBasis(test.submission)),'Evaluator input changed the requested submission.');
        assert(publishedBasis!==null&&p.canonicalJson(publicationBasis(request.publication),Number.MAX_SAFE_INTEGER)===publishedBasis,'Evaluator input changed the initial publication.');
        assert(request.publication.snapshotBytes===input.publication.snapshotBytes,'Evaluator did not receive exact immutable publication bytes.');
        assert(request.publication.publication.providerId===input.publication.providerId,'Wrong evaluator publication owner.');
        calls.set(key,(calls.get(key)??0)+1);
        const evidence=test.capture?[await context.captureEvidence(test.capture)]:[];
        return p.reduceObservations({assessmentId:request.assessmentId,observations:test.observations,complete:test.complete,evidenceTokens:evidence.map(e=>e.token)});
      });
      return client.publish(input.publication);
    },
    verify(value){const result=p.PublishResultV1Schema.parse(value);assert(result.status==='published','Test publication conflicted.');publishedBasis=p.canonicalJson(publicationBasis(result.publication!),Number.MAX_SAFE_INTEGER);published=true;}
  },{
    name:'publication-replay-and-active-pointer',
    async run(client){assert(published,'Initial publication failed; no dependent effects.');const replay=await client.publish(input.publication);const active=await client.readActivePublication({version:1,providerId:input.publication.providerId});return {replay,active};},
    verify(value){const v=value as {replay:p.PublishResultV1;active:p.PublicationV1|null};assert(v.replay.status==='published'&&v.replay.publication&&v.active&&
      p.canonicalJson(publicationBasis(v.replay.publication),Number.MAX_SAFE_INTEGER)===publishedBasis&&
      p.canonicalJson(publicationBasis(v.active),Number.MAX_SAFE_INTEGER)===publishedBasis,'Publication replay/active pointer diverged from the initial publication.');}
  }];
  for(const test of input.cases)cases.push({name:`submission-${test.name}`,async run(client){
    assert(published,'Initial publication failed; no dependent submissions.');
    const first=p.OperationRecordV1Schema.parse(await input.ports.submit(test.submission));
    assertRequestedOriginal(first,test.submission);
    const firstBasis=p.canonicalJson(admissionBasis(first),Number.MAX_SAFE_INTEGER);
    const lookup=await client.lookupOperation({version:1,operation:test.submission.operation});
    if(lookup.record)assertRequestedOriginal(lookup.record,test.submission);
    const lookupBasis=lookup.record?p.canonicalJson(admissionBasis(lookup.record),Number.MAX_SAFE_INTEGER):null;
    const before=calls.get(p.canonicalJson(test.submission.operation,4096))??0;
    const replay=p.OperationRecordV1Schema.parse(await input.ports.submit(test.submission));
    assertRequestedOriginal(replay,test.submission);
    const replayBasis=p.canonicalJson(admissionBasis(replay),Number.MAX_SAFE_INTEGER);
    const after=calls.get(p.canonicalJson(test.submission.operation,4096))??0;
    return {first,lookup,replay,before,after,firstBasis,lookupBasis,replayBasis};
  },verify(value){
    const v=value as {first:p.OperationRecordV1;lookup:p.LookupOperationResultV1;replay:p.OperationRecordV1;before:number;after:number;firstBasis:string;lookupBasis:string|null;replayBasis:string};
    assert(v.first.status===test.expectedVerdict,`Expected ${test.expectedVerdict}, received ${v.first.status}.`);
    assertRequestedOriginal(v.first,test.submission);
    assert(v.lookup.status==='found'&&v.lookup.record&&v.lookupBasis===v.firstBasis,'Operation lookup failed to reconcile the stored result.');
    assert(v.firstBasis===v.replayBasis&&v.before===v.after,'Replay repeated evaluation or changed native effects.');
    assert(v.before===1,'Expected one controlled evaluator call for the original operation.');
    const advice=v.first.assessments.flatMap(a=>a.advice);
    for(const text of test.expectedAdvice)assert(advice.includes(text),'Applicable advice was dropped.');
    if(test.expectedVerdict!=='accepted')assert(v.first.acceptedOriginal===null&&v.first.delivery.state==='none','Unaccepted original became eligible for delivery.');
  }});
  cases.push({name:'generation-fenced-unregister',async run(client){assert(registration,'No registration to unregister.');return client.unregisterEvaluator({version:1,registrationId:registration.registrationId,generation:registration.generation});},verify(value){assert((value as {removed:boolean}).removed,'Matching registration was not unregistered.');}});
  return runCapabilityConformance({bb:input.bb,subject:input.subject,cases});
}
export const CONFORMANCE_OBLIGATIONS = Object.freeze([
  'same operation+fingerprint replays without new evaluation or accepted insert',
  'changed fingerprint conflicts and does not overwrite the original operation',
  'all applicable causes/advice retained; unknown prevents final partial rejection',
  'publication CAS, explicit enrollment/deactivation, generation fences and lost-ack lookup',
  'candidate-bound evidence, negative facts, selected metadata and destructive-change recheck',
  'Q(A),S(T),B placement; closed target conflict; no implicit retarget or schedule absorption',
  'every-original identity/intent/settlement; closure and all-member claim CAS',
  'acceptance activity survives cancellation/restart and does not advance at retry/delivery',
  'delayed disposition atomically creates feedback obligation; acceptance is not consumption'
] as const);
