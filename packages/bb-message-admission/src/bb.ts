/** Injected binding. No SDK imports, module augmentation, storage, discovery or timers. */
import * as p from './protocol.js';
import type { z } from 'zod';
export type AdmissionClientV1 = {
  registerEvaluator(input:{version:1;evaluatorVersion:string},evaluator:p.EvaluatorV1):Promise<p.RegistrationV1>;
  unregisterEvaluator(input:{version:1;registrationId:string;generation:string}):Promise<{version:1;removed:boolean}>;
  publish(input:p.PublishInputV1):Promise<p.PublishResultV1>;
  readActivePublication(input:{version:1;providerId:string}):Promise<p.PublicationV1|null>;
  lookupOperation(input:p.LookupOperationInputV1):Promise<p.LookupOperationResultV1>;
  recheckOperation(input:p.RecheckOperationInputV1):Promise<p.LookupOperationResultV1>;
  previewPlacement(input:p.PreviewPlacementInputV1):Promise<p.PreviewPlacementResultV1>;
  readOriginalManifest(input:p.ReadOriginalManifestInputV1):Promise<p.OriginalManifestV1>;
  readThreadActivity(input:p.ReadThreadActivityInputV1):Promise<p.ThreadActivityV1>;
  listAcceptedActivity(input:p.ListAcceptedActivityInputV1):Promise<p.AcceptedActivityPageV1>;
  submitFeedback(input:p.SubmitFeedbackInputV1):Promise<p.FeedbackV1>;
};
export type AdmissionBindingV1 =
  |{status:'unsupported';reason:'absent'|'incompatible';detail:string}
  |{status:'unavailable';detail:string}
  |{status:'available';version:1;capabilities:p.CapabilitiesV1;client:AdmissionClientV1};
export class AdmissionCallError extends Error {
  readonly method:string;
  readonly outcome:'not-invoked'|'unknown'|'read-failed';
  readonly cause:unknown;
  constructor(method:string,outcome:'not-invoked'|'unknown'|'read-failed',cause:unknown) {
    super(`${method}: ${outcome}: ${cause instanceof Error?cause.message:String(cause)}`);
    this.name='AdmissionCallError';this.method=method;this.outcome=outcome;this.cause=cause;
  }
}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;
function sameOperation(a:p.OperationKey,b:p.OperationKey):boolean {return a.namespace===b.namespace&&a.operationId===b.operationId;}
function sameOriginal(a:p.OriginalRef,b:p.OriginalRef):boolean {return a.originalId===b.originalId&&a.revision===b.revision;}
function sameEnrollment(a:p.EnrollmentV1,b:p.EnrollmentV1):boolean {return a.mode===b.mode&&p.canonicalJson(a.projectIds,Number.MAX_SAFE_INTEGER)===p.canonicalJson(b.projectIds,Number.MAX_SAFE_INTEGER);}
function assert(condition:unknown,message:string):asserts condition {if(!condition)throw new p.ContractBoundaryError('invalid_data',message);}
function freeze<T>(value:T):T {
  if(typeof value==='object'&&value!==null){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
function immutable<T>(value:T,maxBytes:number):T {return freeze(JSON.parse(p.canonicalJson(value,maxBytes)) as T);}
function assertSnapshot(bytes:string,maxBytes:number):void {
  assert(new TextEncoder().encode(bytes).byteLength<=maxBytes,'Snapshot exceeds advertised byte budget.');
  let parsed:unknown;
  try {parsed=JSON.parse(bytes);}catch {throw new p.ContractBoundaryError('invalid_data','snapshotBytes must encode canonical JSON.');}
  assert(p.canonicalJson(parsed,maxBytes)===bytes,'snapshotBytes must use canonical JSON.');
}
function isSignal(value:unknown):value is AbortSignal {return record(value)&&typeof value.aborted==='boolean'&&typeof value.addEventListener==='function'&&typeof value.removeEventListener==='function';}
export async function bindMessageAdmission(bb:unknown):Promise<AdmissionBindingV1> {
  let native:Record<string,unknown>;
  try {
    if(!record(bb)||bb[p.CAPABILITY]===undefined||bb[p.CAPABILITY]===null)return {status:'unsupported',reason:'absent',detail:'Native message admission is absent.'};
    const member=bb[p.CAPABILITY];
    if(!record(member)||typeof member.describe!=='function')return {status:'unsupported',reason:'incompatible',detail:'Native capability has no describe method.'};
    native=member;
  }catch(error){return {status:'unavailable',detail:error instanceof Error?error.message:String(error)};}
  let raw:unknown;
  try {raw=await (native.describe as (input:null)=>unknown).call(native,null);}catch(error){return {status:'unavailable',detail:error instanceof Error?error.message:String(error)};}
  let capabilities:p.CapabilitiesV1;
  try {
    const envelope=p.decodeBounded(p.DescribeEnvelopeSchema,raw,p.LIMITS.describeBytes);
    if(!envelope.versions.includes(1))return {status:'unsupported',reason:'incompatible',detail:'No supported wire version.'};
    capabilities=p.decodeBounded(p.CapabilitiesV1Schema,envelope.capabilities,p.LIMITS.describeBytes);
    assert(capabilities.admission&&capabilities.publication&&capabilities.operations,'Baseline admission/publication/operations are required.');
    const required=['registerEvaluator','unregisterEvaluator','publish','readActivePublication','lookupOperation','recheckOperation'];
    if(capabilities.placement)required.push('previewPlacement');
    if(capabilities.originalManifest)required.push('readOriginalManifest');
    if(capabilities.activity)required.push('readThreadActivity','listAcceptedActivity');
    if(capabilities.feedback)required.push('submitFeedback');
    for(const name of required)assert(typeof native[name]==='function',`Advertised method ${name} is absent.`);
    capabilities=immutable(capabilities,p.LIMITS.describeBytes);
  }catch(error){return {status:'unsupported',reason:'incompatible',detail:error instanceof Error?error.message:String(error)};}
  const limits=capabilities.limits;
  function prepareInput<T>(method:string,input:T,schema:z.ZodType):T {
    try {return immutable(p.decodeBounded(schema,input,limits.requestBytes),limits.requestBytes) as T;}
    catch(error){throw new AdmissionCallError(method,'not-invoked',error);}
  }
  async function validatePublication(value:p.PublicationV1):Promise<void> {
    assertSnapshot(value.snapshotBytes,limits.snapshotBytes);
    const content={version:1 as const,providerId:value.publication.providerId,snapshotBytes:value.snapshotBytes,
      configurationVersion:value.configurationVersion,evaluatorVersion:value.evaluatorVersion,
      enrollment:{mode:value.enrollment.mode,projectIds:value.enrollment.projectIds}};
    assert(value.publication.fingerprint===await p.publicationFingerprint(content,limits.requestBytes),'Publication fingerprint mismatch.');
  }
  async function validateRecordPublication(value:p.LookupOperationResultV1):Promise<void> {
    if(value.record?.publication)await validatePublication(value.record.publication);
  }
  async function call<T>(method:string,input:unknown,inputSchema:z.ZodType,outputSchema:z.ZodType<T>,write:boolean,feature:keyof p.CapabilitiesV1,outputBytes=limits.responseBytes,extra?:unknown):Promise<T> {
    let value:unknown;
    try {
      assert(capabilities[feature]===true,`Native ${feature} is unsupported.`);
      value=prepareInput(method,input,inputSchema);
    }catch(error){throw new AdmissionCallError(method,'not-invoked',error);}
    try {
      const fn=native[method];
      assert(typeof fn==='function',`Native ${method} disappeared; rebind capability.`);
      const output=await fn.call(native,value,...(extra===undefined?[]:[extra]));
      return p.decodeBounded(outputSchema,output,outputBytes);
    }catch(error){throw new AdmissionCallError(method,write?'unknown':'read-failed',error);}
  }
  async function checked<T>(method:string,write:boolean,action:()=>Promise<T>):Promise<T> {
    try{return await action();}catch(error){if(error instanceof AdmissionCallError)throw error;throw new AdmissionCallError(method,write?'unknown':'read-failed',error);}
  }
  const client:AdmissionClientV1={
    async registerEvaluator(input,evaluator) {
      if(typeof evaluator!=='function')throw new AdmissionCallError('registerEvaluator','not-invoked','Evaluator must be a function.');
      input=prepareInput('registerEvaluator',input,p.RegisterEvaluatorInputV1Schema);
      const wrapped:p.EvaluatorV1=async(rawInput,rawContext)=>{
        const parsed=p.decodeBounded(p.EvaluatorInputV1Schema,rawInput,limits.requestBytes);
        assert(parsed.publication.evaluatorVersion===input.evaluatorVersion,'Evaluator version mismatch.');
        await validatePublication(parsed.publication);
        assert(record(rawContext)&&isSignal(rawContext.signal)&&typeof rawContext.captureEvidence==='function','Native evaluator context is malformed.');
        const signal=rawContext.signal;
        assert(!signal.aborted,'Evaluation cancelled.');
        const captured=immutable(parsed,limits.requestBytes) as p.EvaluatorInputV1;
        let count=0,captureCalls=0;
        const issuedTokens=new Set<string>();
        const context:p.EvaluatorContextV1={signal,async captureEvidence(request){
          assert(!signal.aborted,'Evaluation cancelled.');
          const requestValue=p.decodeBounded(p.EvidenceRequestV1Schema,request,limits.requestBytes);
          count+=requestValue.windows.length;
          assert(count<=p.LIMITS.historyWindows&&++captureCalls<=p.LIMITS.historyWindows,'Too many evidence windows or captures for this assessment.');
          const evidence=p.decodeBounded(p.EvidenceV1Schema,await rawContext.captureEvidence(requestValue),limits.evidenceBytes);
          assert(!signal.aborted,'Evaluation cancelled.');
          assert(sameOperation(evidence.operation,captured.submission.operation)&&sameOriginal(evidence.original,captured.submission.original)&&evidence.assessmentId===captured.assessmentId,'Evidence belongs to a different assessment/original/operation.');
          assert(evidence.windows.length===requestValue.windows.length,'Evidence must report every selected window.');
          for(let i=0;i<requestValue.windows.length;i++){
            const requested=requestValue.windows[i]!,window=evidence.windows[i]!;
            assert(window.side===requested.side&&window.selection===requested.selection&&window.events.length<=requested.limit,'Evidence window does not match the selection.');
            const expectedThread=requested.side==='destination'?captured.submission.threadId:captured.submission.source.senderThreadId;
            assert(window.threadId===expectedThread,'Evidence window has the wrong thread.');
          }
          issuedTokens.add(evidence.token);
          return immutable(evidence,limits.evidenceBytes) as p.EvidenceV1;
        }};
        const result=p.decodeBounded(p.EvaluationResultV1Schema,await evaluator(captured,Object.freeze(context)),limits.responseBytes);
        assert(!signal.aborted,'Evaluation cancelled.');
        assert(result.assessmentId===captured.assessmentId,'Evaluator changed assessment identity.');
        assert(result.evidenceTokens.every(token=>issuedTokens.has(token)),'Evaluator returned an evidence token not captured for this assessment.');
        return result;
      };
      return checked('registerEvaluator',true,async()=>{const registered=await call('registerEvaluator',input,p.RegisterEvaluatorInputV1Schema,p.RegistrationV1Schema,true,'admission',limits.responseBytes,wrapped);assert(registered.evaluatorVersion===input.evaluatorVersion,'Registered evaluator version changed.');return registered;});
    },
    unregisterEvaluator(input){return call('unregisterEvaluator',input,p.UnregisterEvaluatorInputV1Schema,p.UnregisterEvaluatorResultV1Schema,true,'admission');},
    async publish(input){
      input=prepareInput('publish',input,p.PublishInputV1Schema);
      try {p.decodeBounded(p.PublishInputV1Schema,input,limits.requestBytes);assertSnapshot(input.snapshotBytes,limits.snapshotBytes);}catch(error){throw new AdmissionCallError('publish','not-invoked',error);}
      return checked('publish',true,async()=>{
        const result=await call('publish',input,p.PublishInputV1Schema,p.PublishResultV1Schema,true,'publication');
        assert(sameOperation(result.operation,input.operation),'Publication result has a different operation.');
        if(result.publication)await validatePublication(result.publication);
        if(result.status==='published'){
          const published=result.publication!;
          assert(published.publication.providerId===input.providerId&&sameOperation(published.operation,input.operation),'Publication owner or operation changed.');
          assert(published.snapshotBytes===input.snapshotBytes&&published.configurationVersion===input.configurationVersion&&published.evaluatorVersion===input.evaluatorVersion&&sameEnrollment(published.enrollment,input.enrollment),'Immutable publication content changed.');
        }
        return result;
      });
    },
    readActivePublication(input){return checked('readActivePublication',false,async()=>{
      input=prepareInput('readActivePublication',input,p.ReadActivePublicationInputV1Schema);
      const value=await call('readActivePublication',input,p.ReadActivePublicationInputV1Schema,p.PublicationV1Schema.nullable(),false,'publication');
      if(value){assert(value.publication.providerId===input.providerId,'Active publication belongs to a different provider.');await validatePublication(value);}return value;
    });},
    lookupOperation(input){return checked('lookupOperation',false,async()=>{
      input=prepareInput('lookupOperation',input,p.LookupOperationInputV1Schema);
      const result=await call('lookupOperation',input,p.LookupOperationInputV1Schema,p.LookupOperationResultV1Schema,false,'operations');
      if(result.record)assert(sameOperation(result.record.operation,input.operation),'Lookup returned another operation.');
      await validateRecordPublication(result);return result;
    });},
    recheckOperation(input){return checked('recheckOperation',true,async()=>{
      input=prepareInput('recheckOperation',input,p.RecheckOperationInputV1Schema);
      const result=await call('recheckOperation',input,p.RecheckOperationInputV1Schema,p.LookupOperationResultV1Schema,true,'operations');
      if(result.record)assert(sameOperation(result.record.operation,input.operation)&&(result.record.status==='conflict'||result.record.requestFingerprint===input.expectedRequestFingerprint),'Recheck changed operation or request fingerprint.');
      await validateRecordPublication(result);return result;
    });},
    previewPlacement(input){return checked('previewPlacement',false,async()=>{
      input=prepareInput('previewPlacement',input,p.PreviewPlacementInputV1Schema);
      const result=await call('previewPlacement',input,p.PreviewPlacementInputV1Schema,p.PreviewPlacementResultV1Schema,false,'placement');
      if(result.targetGroupId!==null)assert(input.queue.some(g=>g.groupId===result.targetGroupId),'Preview returned an unknown fixture target.');return result;
    });},
    readOriginalManifest(input){return checked('readOriginalManifest',false,async()=>{
      input=prepareInput('readOriginalManifest',input,p.ReadOriginalManifestInputV1Schema);
      const result=await call('readOriginalManifest',input,p.ReadOriginalManifestInputV1Schema,p.OriginalManifestV1Schema,false,'originalManifest',limits.manifestBytes);
      assert(result.threadId===input.threadId&&result.requestId===input.requestId,'Manifest returned a different request.');return result;
    });},
    readThreadActivity(input){return checked('readThreadActivity',false,async()=>{
      input=prepareInput('readThreadActivity',input,p.ReadThreadActivityInputV1Schema);
      const result=await call('readThreadActivity',input,p.ReadThreadActivityInputV1Schema,p.ThreadActivityV1Schema,false,'activity');assert(result.threadId===input.threadId,'Activity returned a different thread.');return result;
    });},
    listAcceptedActivity(input){return checked('listAcceptedActivity',false,async()=>{
      input=prepareInput('listAcceptedActivity',input,p.ListAcceptedActivityInputV1Schema);
      const result=await call('listAcceptedActivity',input,p.ListAcceptedActivityInputV1Schema,p.AcceptedActivityPageV1Schema,false,'activity');
      assert(result.threadId===input.threadId&&result.afterSequence===input.afterSequence&&result.items.length<=input.limit,'Activity page does not match requested thread/cursor/limit.');return result;
    });},
    submitFeedback(input){return checked('submitFeedback',true,async()=>{
      input=prepareInput('submitFeedback',input,p.SubmitFeedbackInputV1Schema);
      const result=await call('submitFeedback',input,p.SubmitFeedbackInputV1Schema,p.FeedbackV1Schema,true,'feedback');
      assert(result.providerId===input.providerId&&sameOriginal(result.original,input.original)&&result.rejectionAssessmentId===input.rejectionAssessmentId,'Feedback returned another obligation.');return result;
    });}
  };
  return {status:'available',version:1,capabilities,client:Object.freeze(client)};
}
