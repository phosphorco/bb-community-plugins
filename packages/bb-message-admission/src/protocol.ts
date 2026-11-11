import { z } from 'zod';
import { canonicalJson, fingerprint, ContractBoundaryError } from './json.js';
import type { JsonValue } from './json.js';
export { canonicalJson, fingerprint, ContractBoundaryError };
export type { JsonValue };
export const PROTOCOL = 'bb-message-admission' as const;
export const VERSION = 1 as const;
export const CAPABILITY = 'experimental_messageAdmission' as const;
export const LIMITS = Object.freeze({ describeBytes:65536, jsonDepth:64, originals:256, historyWindows:16, historyEvents:2000, activityPage:256, identifierChars:256, tokenChars:8192, versions:16 });
export const METHODS = Object.freeze({describe:'describe',registerEvaluator:'registerEvaluator',unregisterEvaluator:'unregisterEvaluator',publish:'publish',readActivePublication:'readActivePublication',lookupOperation:'lookupOperation',recheckOperation:'recheckOperation',previewPlacement:'previewPlacement',readOriginalManifest:'readOriginalManifest',readThreadActivity:'readThreadActivity',listAcceptedActivity:'listAcceptedActivity',submitFeedback:'submitFeedback'} as const);
export const IdSchema = z.string().min(1).max(LIMITS.identifierChars).regex(/^[^\p{Cc}]+$/u);
export const FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const RevisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const InstantSchema = z.iso.datetime({offset:true});
export const JsonSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(v=>{try { canonicalJson(v,Number.MAX_SAFE_INTEGER,LIMITS.jsonDepth); return true; }catch{return false;}},'Expected finite, plain JSON.');
export const OperationKeySchema = z.strictObject({namespace:IdSchema,operationId:IdSchema});
export const OriginalRefSchema = z.strictObject({originalId:IdSchema,revision:RevisionSchema});
export const PublicationRefSchema = z.strictObject({providerId:IdSchema,publicationId:IdSchema,fingerprint:FingerprintSchema});
export type OperationKey = z.infer<typeof OperationKeySchema>;
export type OriginalRef = z.infer<typeof OriginalRefSchema>;
export type PublicationRef = z.infer<typeof PublicationRefSchema>;
export type DeliveryMode = 'proceed'|'steer'|'queue';
export type RoutingPreference = 'preserve'|'steer-if-active'|'defer';
export type MembershipPreference = 'preserve'|'separate'|'join-next-ordinary';
export interface ExecutionChoices {
  provider: string|null; model:string|null; reasoning:string|null; serviceTier:string|null;
  permissionMode:string|null; canAsk:boolean; configuration:JsonValue;
}
export interface RequestedIntent {
  mode:DeliveryMode; schedule:{kind:'ordinary'}|{kind:'scheduled';notBefore:string}|{kind:'legacy-unknown'};
  membership:MembershipPreference; execution:ExecutionChoices;
}
export interface EffectiveIntent {
  mode:DeliveryMode; schedule:RequestedIntent['schedule']; membership:MembershipPreference;
  execution:ExecutionChoices; changes:{field:string;causeRuleIds:string[];explanation:string}[];
}
export interface OriginalSource {
  senderThreadId:string|null; initiator:'user'|'agent'|'system'; author:JsonValue; editor:JsonValue;
  origin:JsonValue; externalOperation:OperationKey|null; visibleHumanActivity:boolean;
}
export interface PolicyContextV1 {messageText:string;projectTitle:string|null;senderTitle:string|null;destinationTitle:string|null}
export interface EvidenceMetadataV1 {projectId:string|null;threadId:string;senderThreadId:string|null;policyContext:PolicyContextV1}
export interface FeedbackBindingV1 {providerId:string;obligationId:string;original:OriginalRef;rejectionAssessmentId:string;recipientThreadId:string;adviceFingerprint:string}
export interface SubmissionV1 {
  version:1; operation:OperationKey; requestFingerprint:string; original:OriginalRef;
  threadId:string; projectId:string|null; rawInput:JsonValue; policyContext:PolicyContextV1; requestedIntent:RequestedIntent;
  source:OriginalSource; kind:'message'|'edit'|'compact-first'|'retry'|'continuation'|'native-notice'|'historical-import'|'maintenance';
  override:'none'|'full-send-now'; expectedPlacementWitness:string|null;
  feedbackBinding?:FeedbackBindingV1|null;
}
export interface RuleObservationV1 {
  groupId:string; ruleId:string; revision:string; status:'pass'|'reject'|'unresolved'|'not-applicable';
  causes:{code:string;message:string}[]; advice:string[];
  routing:RoutingPreference; membership:MembershipPreference;
}
export interface EvaluationResultV1 {
  version:1; assessmentId:string; verdict:'accepted'|'rejected'|'unresolved'; complete:boolean;
  observations:RuleObservationV1[]; causes:{groupId:string;ruleId:string;code:string;message:string}[];
  advice:string[]; unresolved:{code:string;message:string}[];
  routing:RoutingPreference; membership:MembershipPreference; evidenceTokens:string[];
}
export interface EnrollmentV1 { mode:'disabled'|'enforce'; projectIds:string[] }
export interface PublishInputV1 {
  version:1; operation:OperationKey; providerId:string; expectedActivePublication:PublicationRef|null;
  snapshotBytes:string; configurationVersion:string; evaluatorVersion:string;
  enrollment:EnrollmentV1;
}
export interface PublicationV1 {
  version:1; publication:PublicationRef; operation:OperationKey; snapshotBytes:string;
  configurationVersion:string; evaluatorVersion:string; enrollment:EnrollmentV1; publishedAt:string;
}
export interface EvidenceRequestV1 {
  version:1; windows:{side:'sender'|'destination';selection:'latest'|'since-clear';limit:number}[];
  prefixMode:'native-candidate';
}
export interface EvidenceWindowV1 {
  side:'sender'|'destination'; threadId:string|null; selection:'latest'|'since-clear';
  coverage:'complete'|'partial'|'unavailable'; asOfCursor:string|null; latestClear:string|null;
  events:{id:string;revision:string;sequence:number;text:string;data:JsonValue}[]; missingReason:string|null;
}
export interface EvidenceV1 {
  version:1; token:string; operation:OperationKey; original:OriginalRef; assessmentId:string;
  capturedAt:string; metadata:EvidenceMetadataV1; windows:EvidenceWindowV1[];
  readSetFingerprint:string; prefixMode:'native-candidate';
}
export interface EvaluatorInputV1 {
  version:1; assessmentId:string; generation:string; cancellationGeneration:string;
  deadlineAt:string; submission:SubmissionV1; publication:PublicationV1;
}
export interface EvaluatorContextV1 {
  signal:AbortSignal; captureEvidence(input:EvidenceRequestV1):Promise<EvidenceV1>;
}
export type EvaluatorV1 = (input:EvaluatorInputV1,context:EvaluatorContextV1)=>Promise<EvaluationResultV1>|EvaluationResultV1;
export interface RegistrationV1 {version:1;registrationId:string;generation:string;evaluatorVersion:string}
export interface AcceptedOriginalV1 {
  version:1; original:OriginalRef; operation:OperationKey; requestFingerprint:string;
  threadId:string; rawInput:JsonValue; source:OriginalSource; requestedIntent:RequestedIntent;
  effectiveIntent:EffectiveIntent; acceptedAt:string; acceptanceSequence:number;
  admission:{kind:'evaluated';publications:PublicationRef[];assessments:EvaluationResultV1[]}|{kind:'legacy-unverified'|'full-send-now'|'operational-exemption';reason:string};
}
export interface ThreadActivityV1 {
  version:1; threadId:string; messageAcceptanceSequence:number;
  lastVisibleHumanAcceptedAt:string|null; lastVisibleHumanOriginal:OriginalRef|null;
}
export interface AcceptedActivityV1 {
  acceptanceSequence:number; acceptedAt:string; original:OriginalRef; source:OriginalSource;
}
export interface ConnectionLimitsV1 {
  requestBytes:number; responseBytes:number; snapshotBytes:number; evidenceBytes:number;
  manifestBytes:number; evaluationMs:number; concurrentEvaluations:number;
}
export interface CapabilitiesV1 {
  admission:boolean; publication:boolean; operations:boolean; placement:boolean;
  originalManifest:boolean; activity:boolean; feedback:boolean; limits:ConnectionLimitsV1;
}
export interface DescribeV1 {protocol:typeof PROTOCOL;versions:number[];capabilities:CapabilitiesV1}

const enums={routing:z.enum(['preserve','steer-if-active','defer']),membership:z.enum(['preserve','separate','join-next-ordinary'])};
/** Every nested operational input is strict; output objects preserve additive fields. */
function models(output:boolean) {
  const o=<T extends z.ZodRawShape>(shape:T)=>output?z.looseObject(shape):z.strictObject(shape);
  const op=o({namespace:IdSchema,operationId:IdSchema});
  const ref=o({originalId:IdSchema,revision:RevisionSchema});
  const pubref=o({providerId:IdSchema,publicationId:IdSchema,fingerprint:FingerprintSchema});
  const execution=o({provider:IdSchema.nullable(),model:IdSchema.nullable(),reasoning:IdSchema.nullable(),serviceTier:IdSchema.nullable(),permissionMode:IdSchema.nullable(),canAsk:z.boolean(),configuration:JsonSchema});
  const schedule=z.discriminatedUnion('kind',[o({kind:z.literal('ordinary')}),o({kind:z.literal('scheduled'),notBefore:InstantSchema}),o({kind:z.literal('legacy-unknown')})]);
  const intentShape={mode:z.enum(['proceed','steer','queue']),schedule,membership:enums.membership,execution};
  const requested=o(intentShape);
  const effective=o({...intentShape,changes:z.array(o({field:IdSchema,causeRuleIds:z.array(IdSchema),explanation:z.string()}))});
  const source=o({senderThreadId:IdSchema.nullable(),initiator:z.enum(['user','agent','system']),author:JsonSchema,editor:JsonSchema,origin:JsonSchema,externalOperation:op.nullable(),visibleHumanActivity:z.boolean()});
  const cause=o({code:IdSchema,message:z.string()});
  const observation=o({groupId:IdSchema,ruleId:IdSchema,revision:IdSchema,status:z.enum(['pass','reject','unresolved','not-applicable']),causes:z.array(cause),advice:z.array(z.string()),routing:enums.routing,membership:enums.membership});
  const result=o({version:z.literal(1),assessmentId:IdSchema,verdict:z.enum(['accepted','rejected','unresolved']),complete:z.boolean(),observations:z.array(observation),causes:z.array(o({groupId:IdSchema,ruleId:IdSchema,...cause.shape})),advice:z.array(z.string()),unresolved:z.array(cause),routing:enums.routing,membership:enums.membership,evidenceTokens:z.array(z.string().min(1).max(LIMITS.tokenChars)).max(LIMITS.historyWindows)}).superRefine((v,ctx)=>{
    const keys=v.observations.map(r=>JSON.stringify([r.groupId,r.ruleId]));
    if(new Set(keys).size!==keys.length) ctx.addIssue({code:'custom',message:'Duplicate rule observations.'});
    const unknown=!v.complete||v.unresolved.length>0||v.observations.some(r=>r.status==='unresolved');
    if(unknown&&v.verdict!=='unresolved') ctx.addIssue({code:'custom',message:'Incomplete or unresolved assessment cannot be final.'});
    if(v.verdict==='unresolved'&&v.complete) ctx.addIssue({code:'custom',message:'Unresolved assessment must retain complete=false.'});
    if(v.verdict==='accepted'&&(v.causes.length||v.observations.some(r=>r.status==='reject'))) ctx.addIssue({code:'custom',message:'Rejection causes cannot be accepted.'});
    if(v.verdict==='rejected'&&!v.observations.some(r=>r.status==='reject')) ctx.addIssue({code:'custom',message:'Final rejection needs a rejecting observation.'});
    for(const r of v.observations) for(const c of r.causes) if(!v.causes.some(x=>x.groupId===r.groupId&&x.ruleId===r.ruleId&&x.code===c.code&&x.message===c.message)) ctx.addIssue({code:'custom',message:'Known causes must be retained.'});
    for(const r of v.observations) for(const advice of r.advice) if(!v.advice.includes(advice)) ctx.addIssue({code:'custom',message:'All advice must be retained.'});
  });
  const enrollment=o({mode:z.enum(['disabled','enforce']),projectIds:z.array(IdSchema)}).superRefine((v,ctx)=>{
    if(new Set(v.projectIds).size!==v.projectIds.length) ctx.addIssue({code:'custom',message:'Duplicate enrolled project.'});
    if(v.mode==='enforce'&&!v.projectIds.length) ctx.addIssue({code:'custom',message:'Enforcement requires explicit project enrollment.'});
    if(v.mode==='disabled'&&v.projectIds.length) ctx.addIssue({code:'custom',message:'Disabled enrollment has no effective projects.'});
  });
  const publication=o({version:z.literal(1),publication:pubref,operation:op,snapshotBytes:z.string(),configurationVersion:IdSchema,evaluatorVersion:IdSchema,enrollment,publishedAt:InstantSchema});
  const policyContext=o({messageText:z.string(),projectTitle:z.string().nullable(),senderTitle:z.string().nullable(),destinationTitle:z.string().nullable()});
  const metadata=o({projectId:IdSchema.nullable(),threadId:IdSchema,senderThreadId:IdSchema.nullable(),policyContext});
  const submission=o({version:z.literal(1),operation:op,requestFingerprint:FingerprintSchema,original:ref,threadId:IdSchema,projectId:IdSchema.nullable(),rawInput:JsonSchema,policyContext,requestedIntent:requested,source,kind:z.enum(['message','edit','compact-first','retry','continuation','native-notice','historical-import','maintenance']),override:z.enum(['none','full-send-now']),expectedPlacementWitness:z.string().min(1).max(LIMITS.tokenChars).nullable(),feedbackBinding:o({providerId:IdSchema,obligationId:IdSchema,original:ref,rejectionAssessmentId:IdSchema,recipientThreadId:IdSchema,adviceFingerprint:FingerprintSchema}).nullable().optional()});
  const evidenceRequest=o({version:z.literal(1),windows:z.array(o({side:z.enum(['sender','destination']),selection:z.enum(['latest','since-clear']),limit:RevisionSchema.max(LIMITS.historyEvents)})).max(LIMITS.historyWindows),prefixMode:z.literal('native-candidate')});
  const window=o({side:z.enum(['sender','destination']),threadId:IdSchema.nullable(),selection:z.enum(['latest','since-clear']),coverage:z.enum(['complete','partial','unavailable']),asOfCursor:IdSchema.nullable(),latestClear:IdSchema.nullable(),events:z.array(o({id:IdSchema,revision:IdSchema,sequence:SequenceSchema,text:z.string(),data:JsonSchema})).max(LIMITS.historyEvents),missingReason:z.string().nullable()});
  const evidence=o({version:z.literal(1),token:z.string().min(1).max(LIMITS.tokenChars),operation:op,original:ref,assessmentId:IdSchema,capturedAt:InstantSchema,metadata,windows:z.array(window).max(LIMITS.historyWindows),readSetFingerprint:FingerprintSchema,prefixMode:z.literal('native-candidate')});
  const evaluatorInput=o({version:z.literal(1),assessmentId:IdSchema,generation:IdSchema,cancellationGeneration:IdSchema,deadlineAt:InstantSchema,submission,publication});
  const accepted=o({version:z.literal(1),original:ref,operation:op,requestFingerprint:FingerprintSchema,threadId:IdSchema,rawInput:JsonSchema,source,requestedIntent:requested,effectiveIntent:effective,acceptedAt:InstantSchema,acceptanceSequence:RevisionSchema,admission:z.discriminatedUnion('kind',[o({kind:z.literal('evaluated'),publications:z.array(pubref),assessments:z.array(result)}),o({kind:z.enum(['legacy-unverified','full-send-now','operational-exemption']),reason:z.string().min(1)})])}).superRefine((v,ctx)=>{
    if(v.admission.kind==='evaluated'){
      if(v.admission.assessments.some(a=>a.verdict!=='accepted'||!a.complete))ctx.addIssue({code:'custom',message:'Accepted originals require complete accepted assessments.'});
      if(v.admission.publications.length!==v.admission.assessments.length)ctx.addIssue({code:'custom',message:'Every enforcing publication needs its accepted assessment.'});
      if(new Set(v.admission.publications.map(p=>p.providerId)).size!==v.admission.publications.length)ctx.addIssue({code:'custom',message:'Duplicate provider publication in accepted basis.'});
    }
  });
  const activity=o({version:z.literal(1),threadId:IdSchema,messageAcceptanceSequence:SequenceSchema,lastVisibleHumanAcceptedAt:InstantSchema.nullable(),lastVisibleHumanOriginal:ref.nullable()}).superRefine((v,ctx)=>{
    if((v.lastVisibleHumanAcceptedAt===null)!==(v.lastVisibleHumanOriginal===null)||(!v.messageAcceptanceSequence&&v.lastVisibleHumanOriginal!==null))ctx.addIssue({code:'custom',message:'Human activity timestamp and original must have a durable acceptance basis.'});
  });
  return {op,ref,pubref,execution,schedule,requested,effective,source,cause,observation,result,enrollment,publication,submission,evidenceRequest,evidence,evaluatorInput,accepted,activity,policyContext,metadata,o};
}
const I=models(false), O=models(true);
export const PolicyContextV1Schema=I.policyContext;
export const EvidenceMetadataV1Schema=O.metadata;
export const ExecutionChoicesSchema=I.execution;
export const RequestedIntentSchema=I.requested;
export const EffectiveIntentSchema=I.effective;
export const OriginalSourceSchema=I.source;
export const SubmissionV1Schema=I.submission;
export const SubmissionOutputV1Schema=O.submission;
export const RuleObservationV1Schema=I.observation;
export const EvaluationResultV1Schema=I.result;
export const EvaluationResultOutputV1Schema=O.result;
export const EnrollmentV1Schema=I.enrollment;
export const PublicationV1Schema=O.publication;
export const EvidenceRequestV1Schema=I.evidenceRequest;
export const EvidenceV1Schema=O.evidence;
export const EvaluatorInputV1Schema=O.evaluatorInput;
export const AcceptedOriginalV1Schema=O.accepted;
export const ThreadActivityV1Schema=O.activity;
export const RegisterEvaluatorInputV1Schema=z.strictObject({version:z.literal(1),evaluatorVersion:IdSchema});
export const RegistrationV1Schema=z.looseObject({version:z.literal(1),registrationId:IdSchema,generation:IdSchema,evaluatorVersion:IdSchema});
export const UnregisterEvaluatorInputV1Schema=z.strictObject({version:z.literal(1),registrationId:IdSchema,generation:IdSchema});
export const UnregisterEvaluatorResultV1Schema=z.looseObject({version:z.literal(1),removed:z.boolean()});
export const PublishInputV1Schema=z.strictObject({version:z.literal(1),operation:I.op,providerId:IdSchema,expectedActivePublication:I.pubref.nullable(),snapshotBytes:z.string(),configurationVersion:IdSchema,evaluatorVersion:IdSchema,enrollment:I.enrollment});
export const ConnectionLimitsV1Schema=z.looseObject({requestBytes:RevisionSchema,responseBytes:RevisionSchema,snapshotBytes:RevisionSchema,evidenceBytes:RevisionSchema,manifestBytes:RevisionSchema,evaluationMs:RevisionSchema,concurrentEvaluations:RevisionSchema});
export const CapabilitiesV1Schema=z.looseObject({admission:z.boolean(),publication:z.boolean(),operations:z.boolean(),placement:z.boolean(),originalManifest:z.boolean(),activity:z.boolean(),feedback:z.boolean(),limits:ConnectionLimitsV1Schema});
export const DescribeEnvelopeSchema=z.looseObject({protocol:z.literal(PROTOCOL),versions:z.array(z.number().int().positive().max(1000)).max(LIMITS.versions),capabilities:z.unknown()});
export const DescribeV1Schema=DescribeEnvelopeSchema.extend({capabilities:CapabilitiesV1Schema});
export function decodeBounded<T>(schema:z.ZodType<T>,value:unknown,maxBytes:number):T {
  return schema.parse(JSON.parse(canonicalJson(value,maxBytes,LIMITS.jsonDepth)));
}
/** Stable request fingerprint excludes only the operation key and its own hash. */
export function submissionFingerprint(input:Omit<SubmissionV1,'requestFingerprint'|'operation'>,maxBytes:number):Promise<string> {return fingerprint({domain:'bb-message-admission/submission/v1',input},maxBytes);}
export function publicationFingerprint(input:Omit<PublishInputV1,'operation'|'expectedActivePublication'>,maxBytes:number):Promise<string> {return fingerprint({domain:'bb-message-admission/publication/v1',input},maxBytes);}
export function reduceObservations(input:{assessmentId:string;observations:RuleObservationV1[];complete:boolean;unresolved?:{code:string;message:string}[];evidenceTokens?:string[]}):EvaluationResultV1 {
  const observations=input.observations;
  const unresolved=[...(input.unresolved??[])];
  const routes=[...new Set(observations.filter(r=>r.status!=='not-applicable').map(r=>r.routing).filter(r=>r!=='preserve'))];
  const memberships=[...new Set(observations.filter(r=>r.status!=='not-applicable').map(r=>r.membership).filter(r=>r!=='preserve'))];
  if(routes.length>1) unresolved.push({code:'routing-conflict',message:'Applicable rules request incompatible routing.'});
  if(memberships.length>1) unresolved.push({code:'membership-conflict',message:'Applicable rules request incompatible membership.'});
  const unknown=!input.complete||unresolved.length>0||observations.some(r=>r.status==='unresolved');
  const result:EvaluationResultV1={version:1,assessmentId:input.assessmentId,verdict:unknown?'unresolved':observations.some(r=>r.status==='reject')?'rejected':'accepted',complete:!unknown,observations,causes:observations.flatMap(r=>r.causes.map(c=>({groupId:r.groupId,ruleId:r.ruleId,...c}))),advice:[...new Set(observations.flatMap(r=>r.advice))],unresolved,routing:routes.length===1?routes[0]!:'preserve',membership:memberships.length===1?memberships[0]!:'preserve',evidenceTokens:input.evidenceTokens??[]};
  return EvaluationResultV1Schema.parse(result);
}

export interface FeedbackV1 {
  version:1; obligationId:string; operation:OperationKey; providerId:string; original:OriginalRef;
  rejectionAssessmentId:string; recipientThreadId:string|null; causeIds:string[]; advice:string[];
  status:'pending'|'blocked-by-policy'|'native-accepted'|'provider-input-accepted'|'consumed-verified'|'uncertain'|'superseded-without-send'|'undeliverable';
  nativeRequestId:string|null; verification:JsonValue; reasons:{code:string;message:string}[];
}
export interface OperationRecordV1 {
  version:1; operation:OperationKey; requestFingerprint:string; kind:'submission'|'publication'|'feedback';
  status:'evaluating'|'unresolved'|'rejected'|'accepted'|'conflict';
  original:OriginalRef|null; assessments:EvaluationResultV1[]; acceptedOriginal:AcceptedOriginalV1|null;
  publication:PublicationV1|null; feedback:FeedbackV1|null;
  delivery:{state:'none'|'queued'|'preparing'|'request-committed'|'provider-accepted'|'completed'|'cancelled'|'preparation-failed'|'uncertain';queueId:string|null;requestId:string|null;groupIndex:number|null;details:JsonValue};
  reasons:{code:string;message:string}[];
}
export interface LookupOperationInputV1 {version:1;operation:OperationKey}
export interface LookupOperationResultV1 {version:1;status:'found'|'missing';record:OperationRecordV1|null}
export interface RecheckOperationInputV1 {
  version:1;operation:OperationKey;expectedRequestFingerprint:string;recheckId:string;
}
export interface PublishResultV1 {
  version:1;status:'published'|'conflict';operation:OperationKey;
  publication:PublicationV1|null;activePublication:PublicationRef|null;reasons:{code:string;message:string}[];
}
export interface ReadOriginalManifestInputV1 {version:1;threadId:string;requestId:string}
export interface OriginalManifestV1 {
  version:1;threadId:string;requestId:string;status:'available'|'legacy-unverified'|'missing';
  originals:AcceptedOriginalV1[];complete:boolean;
}
export interface ReadThreadActivityInputV1 {version:1;threadId:string}
export interface ListAcceptedActivityInputV1 {version:1;threadId:string;afterSequence:number;limit:number}
export interface AcceptedActivityPageV1 {
  version:1;threadId:string;afterSequence:number;throughSequence:number;latestSequence:number;
  complete:boolean;items:AcceptedActivityV1[];
}
export interface SubmitFeedbackInputV1 {version:1;providerId:string;original:OriginalRef;rejectionAssessmentId:string}
export interface QueueFixtureGroupV1 {
  groupId:string;originals:AcceptedOriginalV1[];joinState:'open'|'divider'|'frozen';
  claimed:boolean;blocked:boolean;orderKey:string;witness:string;
}
export interface PreviewPlacementInputV1 {
  version:1;simulation:true;now:string;queue:QueueFixtureGroupV1[];candidate:SubmissionV1;
}
export interface PreviewPlacementResultV1 {
  version:1;simulation:true;status:'join'|'singleton'|'separate'|'conflict';
  targetGroupId:string|null;orderedOriginalIds:string[];reasons:{code:string;message:string}[];
}
export interface NativeAdmissionProtocolV1 {
  describe(input:null):Promise<DescribeV1>|DescribeV1;
  registerEvaluator(input:{version:1;evaluatorVersion:string},evaluator:EvaluatorV1):Promise<RegistrationV1>|RegistrationV1;
  unregisterEvaluator(input:{version:1;registrationId:string;generation:string}):Promise<{version:1;removed:boolean}>|{version:1;removed:boolean};
  publish(input:PublishInputV1):Promise<PublishResultV1>|PublishResultV1;
  readActivePublication(input:{version:1;providerId:string}):Promise<PublicationV1|null>|PublicationV1|null;
  lookupOperation(input:LookupOperationInputV1):Promise<LookupOperationResultV1>|LookupOperationResultV1;
  recheckOperation(input:RecheckOperationInputV1):Promise<LookupOperationResultV1>|LookupOperationResultV1;
  previewPlacement?(input:PreviewPlacementInputV1):Promise<PreviewPlacementResultV1>|PreviewPlacementResultV1;
  readOriginalManifest?(input:ReadOriginalManifestInputV1):Promise<OriginalManifestV1>|OriginalManifestV1;
  readThreadActivity?(input:ReadThreadActivityInputV1):Promise<ThreadActivityV1>|ThreadActivityV1;
  listAcceptedActivity?(input:ListAcceptedActivityInputV1):Promise<AcceptedActivityPageV1>|AcceptedActivityPageV1;
  submitFeedback?(input:SubmitFeedbackInputV1):Promise<FeedbackV1>|FeedbackV1;
}
const FeedbackV1SchemaBase=z.looseObject({version:z.literal(1),obligationId:IdSchema,operation:O.op,providerId:IdSchema,original:O.ref,rejectionAssessmentId:IdSchema,recipientThreadId:IdSchema.nullable(),causeIds:z.array(IdSchema),advice:z.array(z.string()),status:z.enum(['pending','blocked-by-policy','native-accepted','provider-input-accepted','consumed-verified','uncertain','superseded-without-send','undeliverable']),nativeRequestId:IdSchema.nullable(),verification:JsonSchema,reasons:z.array(O.cause)});
export const FeedbackV1Schema=FeedbackV1SchemaBase.superRefine((v,ctx)=>{
  if(v.status==='consumed-verified'&&(v.nativeRequestId===null||v.verification===null))ctx.addIssue({code:'custom',message:'Consumption requires causal request and verification evidence.'});
  if((v.status==='provider-input-accepted'||v.status==='consumed-verified')&&v.nativeRequestId===null)ctx.addIssue({code:'custom',message:'Provider input acceptance requires the exact native request.'});
  if(v.status==='blocked-by-policy'&&v.reasons.length===0)ctx.addIssue({code:'custom',message:'Policy-blocked feedback must retain reasons.'});
  if(v.status==='native-accepted'&&v.recipientThreadId===null)ctx.addIssue({code:'custom',message:'Accepted feedback requires a known recipient.'});
});
export const OperationRecordV1Schema=z.looseObject({version:z.literal(1),operation:O.op,requestFingerprint:FingerprintSchema,kind:z.enum(['submission','publication','feedback']),status:z.enum(['evaluating','unresolved','rejected','accepted','conflict']),original:O.ref.nullable(),assessments:z.array(O.result),acceptedOriginal:O.accepted.nullable(),publication:O.publication.nullable(),feedback:FeedbackV1Schema.nullable(),delivery:z.looseObject({state:z.enum(['none','queued','preparing','request-committed','provider-accepted','completed','cancelled','preparation-failed','uncertain']),queueId:IdSchema.nullable(),requestId:IdSchema.nullable(),groupIndex:SequenceSchema.max(LIMITS.originals-1).nullable(),details:JsonSchema}),reasons:z.array(O.cause)}).superRefine((v,ctx)=>{
  if(v.status==='accepted'&&v.kind==='submission'&&!v.acceptedOriginal)ctx.addIssue({code:'custom',message:'Accepted submissions require the immutable accepted original.'});
  if(v.status!=='accepted'&&v.acceptedOriginal)ctx.addIssue({code:'custom',message:'Unaccepted operations cannot contain an accepted original.'});
  if(v.status!=='accepted'&&v.delivery.state!=='none')ctx.addIssue({code:'custom',message:'Unaccepted work is not delivery eligible.'});
  if(v.status==='rejected'&&!v.assessments.some(a=>a.verdict==='rejected'))ctx.addIssue({code:'custom',message:'Final rejection needs a completed rejection assessment.'});
  if(v.acceptedOriginal&&(v.original===null||v.original.originalId!==v.acceptedOriginal.original.originalId||v.original.revision!==v.acceptedOriginal.original.revision||v.operation.namespace!==v.acceptedOriginal.operation.namespace||v.operation.operationId!==v.acceptedOriginal.operation.operationId||v.requestFingerprint!==v.acceptedOriginal.requestFingerprint))ctx.addIssue({code:'custom',message:'Accepted original must match its operation/revision/fingerprint.'});
  if(v.status==='rejected'&&v.assessments.some(a=>a.verdict==='unresolved'))ctx.addIssue({code:'custom',message:'An unresolved policy cannot be a final partial rejection.'});
});
export const LookupOperationInputV1Schema=z.strictObject({version:z.literal(1),operation:I.op});
export const LookupOperationResultV1Schema=z.looseObject({version:z.literal(1),status:z.enum(['found','missing']),record:OperationRecordV1Schema.nullable()}).refine(v=>(v.status==='found')===(v.record!==null),'Found status requires exactly one record.');
export const RecheckOperationInputV1Schema=z.strictObject({version:z.literal(1),operation:I.op,expectedRequestFingerprint:FingerprintSchema,recheckId:IdSchema});
export const PublishResultV1Schema=z.looseObject({version:z.literal(1),status:z.enum(['published','conflict']),operation:O.op,publication:O.publication.nullable(),activePublication:O.pubref.nullable(),reasons:z.array(O.cause)}).refine(v=>v.status!=='published'||v.publication!==null,'Published result needs its immutable publication.');
export const ReadOriginalManifestInputV1Schema=z.strictObject({version:z.literal(1),threadId:IdSchema,requestId:IdSchema});
export const OriginalManifestV1Schema=z.looseObject({version:z.literal(1),threadId:IdSchema,requestId:IdSchema,status:z.enum(['available','legacy-unverified','missing']),originals:z.array(O.accepted).max(LIMITS.originals),complete:z.boolean()}).superRefine((v,ctx)=>{
  const ids=v.originals.map(x=>JSON.stringify(x.original));
  if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate original revision in a manifest.'});
  if(v.status==='available'&&(!v.complete||v.originals.length===0))ctx.addIssue({code:'custom',message:'Available manifests are complete and nonempty.'});
  if(v.status==='missing'&&(v.originals.length||v.complete))ctx.addIssue({code:'custom',message:'Missing manifests cannot claim originals or completeness.'});
});
export const ReadThreadActivityInputV1Schema=z.strictObject({version:z.literal(1),threadId:IdSchema});
export const ListAcceptedActivityInputV1Schema=z.strictObject({version:z.literal(1),threadId:IdSchema,afterSequence:SequenceSchema,limit:RevisionSchema.max(LIMITS.activityPage)});
export const AcceptedActivityPageV1Schema=z.looseObject({version:z.literal(1),threadId:IdSchema,afterSequence:SequenceSchema,throughSequence:SequenceSchema,latestSequence:SequenceSchema,complete:z.boolean(),items:z.array(z.looseObject({acceptanceSequence:RevisionSchema,acceptedAt:InstantSchema,original:O.ref,source:O.source})).max(LIMITS.activityPage)}).superRefine((v,ctx)=>{
  let previous=v.afterSequence;
  for(const item of v.items){if(item.acceptanceSequence<=previous||item.acceptanceSequence>v.throughSequence)ctx.addIssue({code:'custom',message:'Activity must be ordered, unique and within the cursor interval.'});previous=item.acceptanceSequence;}
  if(v.throughSequence!==(v.items.at(-1)?.acceptanceSequence??v.afterSequence)||v.throughSequence<v.afterSequence||v.throughSequence>v.latestSequence||v.complete!==(v.throughSequence===v.latestSequence))ctx.addIssue({code:'custom',message:'Invalid activity coverage cursors.'});
});
export const SubmitFeedbackInputV1Schema=z.strictObject({version:z.literal(1),providerId:IdSchema,original:I.ref,rejectionAssessmentId:IdSchema});
export const PreviewPlacementInputV1Schema=z.strictObject({version:z.literal(1),simulation:z.literal(true),now:InstantSchema,queue:z.array(z.strictObject({groupId:IdSchema,originals:z.array(I.accepted).min(1).max(LIMITS.originals),joinState:z.enum(['open','divider','frozen']),claimed:z.boolean(),blocked:z.boolean(),orderKey:z.string().min(1),witness:z.string().min(1).max(LIMITS.tokenChars)})).max(LIMITS.originals),candidate:I.submission}).superRefine((v,ctx)=>{
  if(v.queue.reduce((sum,g)=>sum+g.originals.length,0)>LIMITS.originals)ctx.addIssue({code:'custom',message:'Fixture queue exceeds the original limit.'});
  const ids=v.queue.map(g=>g.groupId);if(new Set(ids).size!==ids.length)ctx.addIssue({code:'custom',message:'Duplicate fixture group.'});
});
export const PreviewPlacementResultV1Schema=z.looseObject({version:z.literal(1),simulation:z.literal(true),status:z.enum(['join','singleton','separate','conflict']),targetGroupId:IdSchema.nullable(),orderedOriginalIds:z.array(IdSchema).max(LIMITS.originals),reasons:z.array(O.cause)}).refine(v=>v.status!=='join'||v.targetGroupId!==null,'Joined placement requires its target.');

export const ReadActivePublicationInputV1Schema=z.strictObject({version:z.literal(1),providerId:IdSchema});

export const OPERATIONAL_EXEMPTIONS = Object.freeze(['standalone-clear','standalone-compact','historical-import','accepted-replay','exact-accepted-retry','exact-accepted-continuation','ownership-assigned','ownership-removed','child-needs-attention','child-completed','child-failed','child-interrupted','child-outcome-batch','tool-result-delivered'] as const);
export const OperationalExemptionV1Schema=z.strictObject({kind:z.enum(OPERATIONAL_EXEMPTIONS),nativeOperation:I.op,original:I.ref.nullable()});
export type OperationalExemptionV1=z.infer<typeof OperationalExemptionV1Schema>;
