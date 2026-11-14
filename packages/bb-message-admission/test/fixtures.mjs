import * as p from '../dist/protocol.js';
export const when='2026-11-11T12:00:00.000Z';
export const hash='sha256:'+'a'.repeat(64);
export const limits={requestBytes:2097152,responseBytes:2097152,snapshotBytes:1048576,evidenceBytes:1048576,manifestBytes:2097152,evaluationMs:30000,concurrentEvaluations:4};
export const capabilities={admission:true,publication:true,operations:true,placement:false,originalManifest:false,activity:false,feedback:false,limits};
export const execution={provider:null,model:null,reasoning:null,serviceTier:null,permissionMode:null,canAsk:false,configuration:{}};
export const intent={mode:'queue',schedule:{kind:'ordinary'},membership:'join-next-ordinary',execution};
export const source={senderThreadId:'thr_sender',initiator:'agent',author:{kind:'machine',id:'host_one'},editor:null,origin:{pluginId:'fixture'},externalOperation:null,visibleHumanActivity:false};
export const submission={version:1,operation:{namespace:'fixture',operationId:'submit-one'},requestFingerprint:hash,original:{originalId:'original_one',revision:1},threadId:'thr_destination',projectId:'proj_fixture',rawInput:[{type:'text',text:'Fixture message'}],policyContext:{messageText:'Fixture message',projectTitle:'Fixture project',senderTitle:'Sender',destinationTitle:'Destination'},requestedIntent:intent,source,kind:'message',override:'none',expectedPlacementWitness:null};
export const publishInput={version:1,operation:{namespace:'fixture',operationId:'publish-one'},providerId:'fixture-provider',expectedActivePublication:null,snapshotBytes:'{"rules":[]}',configurationVersion:'config-1',evaluatorVersion:'fixture-evaluator-1',enrollment:{mode:'enforce',projectIds:['proj_fixture']}};
export async function publication(input=publishInput){return {version:1,publication:{providerId:input.providerId,publicationId:'publication-one',fingerprint:await p.publicationFingerprint({version:1,providerId:input.providerId,snapshotBytes:input.snapshotBytes,configurationVersion:input.configurationVersion,evaluatorVersion:input.evaluatorVersion,enrollment:input.enrollment},limits.requestBytes)},operation:input.operation,snapshotBytes:input.snapshotBytes,configurationVersion:input.configurationVersion,evaluatorVersion:input.evaluatorVersion,enrollment:input.enrollment,publishedAt:when};}
export const observation=(ruleId,status='reject',advice=['Correct '+ruleId])=>({groupId:'group',ruleId,revision:'1',status,causes:status==='reject'?[{code:'cause-'+ruleId,message:'Problem '+ruleId}]:[],advice,routing:'preserve',membership:'preserve'});
export function result(observations=[],complete=true){return p.reduceObservations({assessmentId:'assessment-one',observations,complete});}
export function accepted(originalId='original_one') {return {version:1,original:{originalId,revision:1},operation:submission.operation,requestFingerprint:hash,threadId:submission.threadId,rawInput:submission.rawInput,source,requestedIntent:intent,effectiveIntent:{...intent,changes:[]},acceptedAt:when,acceptanceSequence:1,admission:{kind:'evaluated',publications:[],assessments:[]}};}
/** Scripted boundary fixture only; no native transaction, persistence or routing implementation. */
export function scriptedHost(overrides={},flags={}) {
  const native={
    describe(){return {protocol:p.PROTOCOL,versions:[1],capabilities:{...capabilities,...flags}};},
    registerEvaluator(){return {version:1,registrationId:'registration-one',generation:'generation-one',evaluatorVersion:'fixture-evaluator-1'};},
    unregisterEvaluator(){return {version:1,removed:true};},
    async publish(input){return {version:1,status:'published',operation:input.operation,publication:await publication(input),activePublication:null,reasons:[]};},
    readActivePublication(){return null;},
    lookupOperation(){return {version:1,status:'missing',record:null};},
    recheckOperation(){return {version:1,status:'missing',record:null};},
    ...overrides
  };
  return {experimental_messageAdmission:native};
}
export async function evaluatorInput(){return {version:1,assessmentId:'assessment-one',generation:'generation-one',cancellationGeneration:'cancel-one',deadlineAt:'2099-01-01T00:00:00.000Z',submission,publication:await publication()};}
export function evidence(request,input){return {version:1,token:'native-read-set-token',operation:input.submission.operation,original:input.submission.original,assessmentId:input.assessmentId,capturedAt:when,metadata:{projectId:submission.projectId,threadId:submission.threadId,senderThreadId:source.senderThreadId,policyContext:submission.policyContext},windows:request.windows.map(w=>({...w,threadId:w.side==='destination'?submission.threadId:source.senderThreadId,coverage:'complete',asOfCursor:'cursor-one',latestClear:null,events:[],missingReason:null})),readSetFingerprint:hash,prefixMode:'native-candidate'};}
