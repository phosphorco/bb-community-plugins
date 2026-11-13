import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as p from '../dist/protocol.js';
import {bindMessageAdmission,AdmissionCallError} from '../dist/bb.js';
import {scriptedHost,capabilities,limits,publishInput,publication,evaluatorInput,evidence,result,submission,when} from './fixtures.mjs';
async function client(host){const bound=await bindMessageAdmission(host);assert.equal(bound.status,'available',JSON.stringify(bound));return bound.client;}
const key={version:1,operation:submission.operation};
test('absent, incompatible and unavailable remain separate',async()=>{
  assert.deepEqual((await bindMessageAdmission({})).reason,'absent');
  assert.equal((await bindMessageAdmission({experimental_messageAdmission:{}})).reason,'incompatible');
  assert.equal((await bindMessageAdmission(scriptedHost({describe(){throw new Error('native offline');}}))).status,'unavailable');
  const throwing={get experimental_messageAdmission(){throw new Error('offline member');}};
  assert.equal((await bindMessageAdmission(throwing)).status,'unavailable');
});
test('tolerant describe negotiates version1 without parsing unknown version details',async()=>{
  const fixtures=JSON.parse(readFileSync(new URL('../fixtures/versions.json',import.meta.url),'utf8'));
  for(const fixture of fixtures){
    const bound=await bindMessageAdmission(scriptedHost({describe(){return {protocol:p.PROTOCOL,versions:fixture.versions,capabilities:fixture.supported?{...capabilities,newFeature:{nested:true}}:'not version1 capabilities',futureEnvelope:1};}}));
    assert.equal(bound.status,fixture.supported?'available':'unsupported');
  }
  const excessive=await bindMessageAdmission(scriptedHost({describe(){return {protocol:p.PROTOCOL,versions:Array(17).fill(1),capabilities};}}));assert.equal(excessive.status,'unsupported');
});
test('capability flags require exact real method shapes and complete baseline',async()=>{
  assert.equal((await bindMessageAdmission(scriptedHost({}, {admission:false}))).status,'unsupported');
  assert.equal((await bindMessageAdmission(scriptedHost({}, {placement:true}))).status,'unsupported');
  assert.equal((await bindMessageAdmission(scriptedHost({readActivePublication:undefined}))).status,'unsupported');
  const c=await client(scriptedHost());await assert.rejects(c.previewPlacement({version:1,simulation:true,now:when,queue:[],candidate:submission}),e=>e.outcome==='not-invoked');
});
test('native this preserved and additive nested publication fields accepted',async()=>{
  const host=scriptedHost({async publish(input){assert.equal(this,host.experimental_messageAdmission);const value=await publication(input);return {version:1,status:'published',operation:{...input.operation,future:1},publication:{...value,enrollment:{...value.enrollment,future:true},publication:{...value.publication,future:2},future:3},activePublication:null,reasons:[],future:4};}});
  const c=await client(host);const output=await c.publish(publishInput);assert.equal(output.future,4);assert.equal(output.publication.enrollment.future,true);
});
test('strict input and snapshot validation fail before invocation',async()=>{
  let calls=0;const c=await client(scriptedHost({publish(){calls++;throw new Error('must not invoke');}}));
  for(const value of [{...publishInput,extra:true},{...publishInput,snapshotBytes:'{ "rules": [] }'},{...publishInput,snapshotBytes:'invalid'},{...publishInput,enrollment:{mode:'enforce',projectIds:[]}}])await assert.rejects(c.publish(value),e=>e instanceof AdmissionCallError&&e.outcome==='not-invoked');
  assert.equal(calls,0);
});
test('write errors are unknown and never retried or silently reconciled',async()=>{
  let writes=0,reads=0;
  const c=await client(scriptedHost({publish(){writes++;throw new Error('lost acknowledgement');},lookupOperation(){reads++;return {version:1,status:'missing',record:null};}}));
  await assert.rejects(c.publish(publishInput),e=>e.outcome==='unknown'&&e.method==='publish');
  assert.equal(writes,1);assert.equal(reads,0);
  assert.equal((await c.lookupOperation(key)).status,'missing');assert.equal(reads,1);assert.equal(writes,1);
});
test('malformed or oversized write responses remain unknown',async()=>{
  const malformed=await client(scriptedHost({publish(){return {status:'published'};}}));await assert.rejects(malformed.publish(publishInput),e=>e.outcome==='unknown');
  const c=await client(scriptedHost({async publish(input){const value=await publication(input);return {version:1,status:'published',operation:input.operation,publication:value,activePublication:null,reasons:[],future:'x'.repeat(3000)};}},{limits:{...limits,responseBytes:2048}}));
  await assert.rejects(c.publish(publishInput),e=>e.outcome==='unknown'&&e.cause.code==='capacity');
});
test('read failures preserve failure; active publication and lookup identity cannot drift',async()=>{
  const c=await client(scriptedHost({async readActivePublication(){return {...await publication(),publication:{...(await publication()).publication,providerId:'other'}};},lookupOperation(){throw new Error('read failed');}}));
  await assert.rejects(c.readActivePublication({version:1,providerId:'fixture-provider'}),e=>e.outcome==='read-failed');
  await assert.rejects(c.lookupOperation(key),e=>e.outcome==='read-failed');
});
test('registered evaluator receives immutable copies and exact candidate-bound evidence',async()=>{
  let callback;
  const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  let raw=await evaluatorInput();
  await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},async(input,context)=>{
    assert(Object.isFrozen(input));assert(Object.isFrozen(input.submission.rawInput));assert(Object.isFrozen(input.publication.enrollment.projectIds));
    assert.throws(()=>input.submission.policyContext.messageText='mutated');
    const proof=await context.captureEvidence({version:1,windows:[{side:'destination',selection:'latest',limit:2}],prefixMode:'native-candidate'});
    assert(Object.isFrozen(proof));assert.equal(proof.windows[0].threadId,submission.threadId);
    return {...result(),evidenceTokens:[proof.token]};
  });
  const controller=new AbortController();
  const output=await callback(raw,{signal:controller.signal,captureEvidence:request=>evidence(request,raw)});
  assert.equal(output.verdict,'accepted');assert.equal(Object.isFrozen(raw.submission.rawInput),false);
});
test('forged evidence identity, window and tokens are rejected',async()=>{
  for(const mutation of [e=>({...e,assessmentId:'other'}),e=>({...e,original:{originalId:'other',revision:1}}),e=>({...e,windows:[]}),e=>({...e,windows:e.windows.map(w=>({...w,threadId:'other'}))})]){
    let callback;const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
    await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},async(input,context)=>{await context.captureEvidence({version:1,windows:[{side:'destination',selection:'latest',limit:2}],prefixMode:'native-candidate'});return result();});
    const raw=await evaluatorInput();await assert.rejects(callback(raw,{signal:new AbortController().signal,captureEvidence:request=>mutation(evidence(request,raw))}));
  }
  let callback;const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},()=>({...result(),evidenceTokens:['not-issued']}));
  await assert.rejects(callback(await evaluatorInput(),{signal:new AbortController().signal,captureEvidence(){throw new Error('not used');}}),/not captured/);
});
test('cancellation fences late evaluator completion',async()=>{
  let callback,finish,started;const began=new Promise(resolve=>started=resolve);
  const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},async()=>{started();await new Promise(resolve=>finish=resolve);return result();});
  const controller=new AbortController();const pending=callback(await evaluatorInput(),{signal:controller.signal,captureEvidence(){throw new Error('not used');}});await began;controller.abort();finish();await assert.rejects(pending,/cancelled/);
});
test('evidence budget is checked before schema decode and capture calls stay bounded',async()=>{
  let callback;const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}},{limits:{...limits,evidenceBytes:10}}));
  await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},async(input,context)=>{await context.captureEvidence({version:1,windows:[],prefixMode:'native-candidate'});return result();});
  const raw=await evaluatorInput();await assert.rejects(callback(raw,{signal:new AbortController().signal,captureEvidence:request=>evidence(request,raw)}),e=>e.code==='capacity');
});
test('declared activity page must match requested thread, sequence and limit',async()=>{
  const c=await client(scriptedHost({readThreadActivity(input){return {version:1,threadId:input.threadId,messageAcceptanceSequence:0,lastVisibleHumanAcceptedAt:null,lastVisibleHumanOriginal:null};},listAcceptedActivity(){return {version:1,threadId:'wrong',afterSequence:0,throughSequence:0,latestSequence:0,complete:true,items:[]};}},{activity:true}));
  assert.equal((await c.readThreadActivity({version:1,threadId:'right'})).messageAcceptanceSequence,0);
  await assert.rejects(c.listAcceptedActivity({version:1,threadId:'right',afterSequence:0,limit:1}),e=>e.outcome==='read-failed');
});
test('native capture admission counts all windows and empty captures before invocation',async()=>{
  let callback,captures=0;const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  await c.registerEvaluator({version:1,evaluatorVersion:publishInput.evaluatorVersion},async(input,context)=>{for(let i=0;i<17;i++)await context.captureEvidence({version:1,windows:[],prefixMode:'native-candidate'});return result();});
  const raw=await evaluatorInput();await assert.rejects(callback(raw,{signal:new AbortController().signal,captureEvidence:request=>{captures++;return evidence(request,raw);}}),/Too many/);assert.equal(captures,16);
});
test('recheck fingerprint mismatch is an explicit known conflict retaining stored fingerprint',async()=>{
  const c=await client(scriptedHost({recheckOperation(input){return {version:1,status:'found',record:{version:1,operation:input.operation,requestFingerprint:'sha256:'+'a'.repeat(64),kind:'submission',status:'conflict',original:submission.original,assessments:[],acceptedOriginal:null,publication:null,feedback:null,delivery:{state:'none',queueId:null,requestId:null,groupIndex:null,details:null},reasons:[{code:'operation-fingerprint-conflict',message:'Expected fingerprint differs from the immutable original'}]}};}}));
  const output=await c.recheckOperation({version:1,operation:submission.operation,expectedRequestFingerprint:'sha256:'+'b'.repeat(64),recheckId:'recheck-one'});
  assert.equal(output.record.status,'conflict');assert.equal(output.record.requestFingerprint,'sha256:'+'a'.repeat(64));
});
