import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/protocol.js';
import {submission,publishInput,result,observation,accepted,when,hash,source} from './fixtures.mjs';
test('canonical JSON has stable order, UTF-8 exact bound, finite plain data and no getters/toJSON',async()=>{
  assert.equal(p.canonicalJson({z:1,a:'é'},16),'{"a":"é","z":1}');
  assert.throws(()=>p.canonicalJson({z:1,a:'é'},15),/exceeds/);
  for(const v of [NaN,Infinity,undefined,()=>{},new Date(),[,1],Object.assign([1],{x:2})])assert.throws(()=>p.canonicalJson(v,1024));
  let invoked=false;const getter={get secret(){invoked=true;return 'no';}};assert.throws(()=>p.canonicalJson(getter,1024));assert.equal(invoked,false);
  const cyclic={};cyclic.cycle=cyclic;assert.throws(()=>p.canonicalJson(cyclic,1024),/Cyclic/);
  assert.equal(await p.fingerprint({b:2,a:1},100),await p.fingerprint({a:1,b:2},100));
  assert.notEqual(await p.fingerprint({a:1},100),await p.fingerprint({a:2},100));
});
test('submission input strict at all typed boundaries; policy context is declared',()=>{
  assert.deepEqual(p.SubmissionV1Schema.parse(submission),submission);
  for(const value of [{...submission,extra:true},{...submission,operation:{...submission.operation,extra:true}},{...submission,requestedIntent:{...submission.requestedIntent,execution:{...submission.requestedIntent.execution,extra:true}}},{...submission,policyContext:{...submission.policyContext,extra:true}}])assert.throws(()=>p.SubmissionV1Schema.parse(value));
  assert.throws(()=>p.SubmissionV1Schema.parse({...submission,policyContext:undefined}));
});
test('callback output DTO additions preserved recursively',()=>{
  const value={...submission,newTop:'future',source:{...submission.source,newSource:1},policyContext:{...submission.policyContext,newContext:2},requestedIntent:{...submission.requestedIntent,newIntent:3,execution:{...submission.requestedIntent.execution,newExecution:4}}};
  const decoded=p.SubmissionOutputV1Schema.parse(value);
  assert.equal(decoded.newTop,'future');assert.equal(decoded.source.newSource,1);assert.equal(decoded.requestedIntent.execution.newExecution,4);
});
test('all applicable rejects collect every cause and distinct advice in order',()=>{
  const verdict=result([observation('one','reject',['Fix shared','Fix one']),observation('two','reject',['Fix shared','Fix two'])]);
  assert.equal(verdict.verdict,'rejected');assert.equal(verdict.complete,true);assert.deepEqual(verdict.advice,['Fix shared','Fix one','Fix two']);assert.equal(verdict.causes.length,2);
  assert.throws(()=>p.EvaluationResultV1Schema.parse({...verdict,advice:['Fix shared']}),/advice/);
  assert.throws(()=>p.EvaluationResultV1Schema.parse({...verdict,causes:[]}),/causes/);
});
test('reject plus unknown is unresolved with known causes/advice retained',()=>{
  const verdict=result([observation('one'),observation('unknown','unresolved',['Supply context'])]);
  assert.equal(verdict.verdict,'unresolved');assert.equal(verdict.complete,false);assert.equal(verdict.causes.length,1);assert.deepEqual(verdict.advice,['Correct one','Supply context']);
  assert.throws(()=>p.EvaluationResultV1Schema.parse({...verdict,verdict:'rejected',complete:true}),/unresolved/);
});
test('conflicting routing/membership is unresolved and preserves observations',()=>{
  const one={...observation('one','pass',[]),routing:'defer',membership:'separate'};
  const two={...observation('two','pass',[]),routing:'steer-if-active',membership:'join-next-ordinary'};
  const verdict=result([one,two]);assert.equal(verdict.verdict,'unresolved');assert.equal(verdict.unresolved.length,2);assert.equal(verdict.observations.length,2);
  assert.throws(()=>p.EvaluationResultV1Schema.parse({...verdict,verdict:'accepted'}));
});
test('publication requires explicit scoped enrollment, stable snapshot fingerprint and strict CAS',async()=>{
  for(const enrollment of [{mode:'enforce',projectIds:[]},{mode:'enforce',projectIds:['p','p']},{mode:'disabled',projectIds:['p']}])assert.throws(()=>p.PublishInputV1Schema.parse({...publishInput,enrollment}));
  assert.equal(p.PublishInputV1Schema.parse({...publishInput,enrollment:{mode:'disabled',projectIds:[]}}).enrollment.mode,'disabled');
  const {operation,expectedActivePublication,...content}=publishInput;
  assert.equal(await p.publicationFingerprint(content,4096),await p.publicationFingerprint({...content},4096));
  assert.notEqual(await p.publicationFingerprint(content,4096),await p.publicationFingerprint({...content,snapshotBytes:'{"rules":[1]}'},4096));
});
test('request fingerprint changes on exact original, source, intent or policy text',async()=>{
  const {operation,requestFingerprint,...content}=submission;
  const hash=await p.submissionFingerprint(content,8192);
  for(const next of [{...content,rawInput:'Changed'},{...content,source:{...source,senderThreadId:'another'}},{...content,original:{...content.original,revision:2}},{...content,requestedIntent:{...content.requestedIntent,schedule:{kind:'scheduled',notBefore:when}}},{...content,policyContext:{...content.policyContext,messageText:'Changed'}}])assert.notEqual(hash,await p.submissionFingerprint(next,8192));
});
test('manifest honors 256-original boundary and refuses overflow, duplicate or partial available',()=>{
  const originals=Array.from({length:256},(_,i)=>accepted('o-'+i));
  const manifest={version:1,threadId:'thread',requestId:'request',status:'available',complete:true,originals};
  assert.equal(p.OriginalManifestV1Schema.parse(manifest).originals.length,256);
  assert.throws(()=>p.OriginalManifestV1Schema.parse({...manifest,originals:[...originals,accepted('o-over')]}));
  assert.throws(()=>p.OriginalManifestV1Schema.parse({...manifest,originals:[originals[0],originals[0]]}),/Duplicate/);
  assert.throws(()=>p.OriginalManifestV1Schema.parse({...manifest,complete:false}),/complete/);
});
test('activity cursors use durable acceptance sequence and explicit page completeness',()=>{
  const page={version:1,threadId:'t',afterSequence:0,throughSequence:1,latestSequence:2,complete:false,items:[{acceptanceSequence:1,acceptedAt:when,original:submission.original,source}]};
  assert.equal(p.AcceptedActivityPageV1Schema.parse(page).complete,false);
  assert.throws(()=>p.AcceptedActivityPageV1Schema.parse({...page,complete:true}),/cursors/);
  assert.throws(()=>p.AcceptedActivityPageV1Schema.parse({...page,items:[page.items[0],page.items[0]]}),/ordered/);
  assert.throws(()=>p.ListAcceptedActivityInputV1Schema.parse({version:1,threadId:'t',afterSequence:0,limit:257}));
});
test('feedback cannot take arbitrary text or assert consumption without causal evidence',()=>{
  const input={version:1,providerId:'p',original:submission.original,rejectionAssessmentId:'a'};
  assert.throws(()=>p.SubmitFeedbackInputV1Schema.parse({...input,text:'bypass'}));
  const feedback={...input,version:1,obligationId:'f',operation:submission.operation,recipientThreadId:'sender',causeIds:['rule-one'],advice:['Fix'],status:'native-accepted',nativeRequestId:null,verification:null,reasons:[]};
  assert.equal(p.FeedbackV1Schema.parse(feedback).status,'native-accepted');
  assert.throws(()=>p.FeedbackV1Schema.parse({...feedback,status:'consumed-verified'}),/causal/);
  assert.equal(p.FeedbackV1Schema.parse({...feedback,status:'consumed-verified',nativeRequestId:'req',verification:{ack:'exact-input'}}).status,'consumed-verified');
});
test('preview inputs are explicitly simulation and cannot mint an acceptance ticket',()=>{
  const preview={version:1,simulation:true,now:when,queue:[],candidate:submission};
  assert.equal(p.PreviewPlacementInputV1Schema.parse(preview).simulation,true);
  assert.throws(()=>p.PreviewPlacementInputV1Schema.parse({...preview,simulation:false}));
  assert.throws(()=>p.PreviewPlacementInputV1Schema.parse({...preview,commitTicket:'fake'}));
});
test('accepted originals cannot freeze unresolved/rejected semantic assessments',()=>{
  const original=accepted();
  const publication={providerId:'p',publicationId:'publication',fingerprint:hash};
  for(const assessment of [result([observation('r')]),result([observation('unknown','unresolved')])])assert.throws(()=>p.AcceptedOriginalV1Schema.parse({...original,admission:{kind:'evaluated',publications:[publication],assessments:[assessment]}}),/complete accepted/);
  assert.throws(()=>p.AcceptedOriginalV1Schema.parse({...original,admission:{kind:'evaluated',publications:[publication],assessments:[]}}),/assessment/);
});
test('bounded decode copies opaque native data rather than exporting a live handle',()=>{
  const decoded=p.decodeBounded(p.SubmissionV1Schema,submission,65536);
  assert.notEqual(decoded.rawInput,submission.rawInput);assert.notEqual(decoded.source.author,submission.source.author);
  decoded.rawInput[0].text='local copy';assert.equal(submission.rawInput[0].text,'Fixture message');
});
