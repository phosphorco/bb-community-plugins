import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/protocol.js';
import {runNativeAdmissionConformance} from '../dist/testing.js';
import {accepted,submission,hash,scriptedHost,publication,publishInput,evaluatorInput} from './fixtures.mjs';
/** Scripted kit counterexamples, not native acceptance or persistence proof. */
async function fixture({changeRecord=value=>value,changeCallback=value=>value,publicationDrift=false}={}){
  let evaluate,stored,publishes=0;
  const initial=await publication(),drift={...initial,publication:{...initial.publication,publicationId:'wrong-stable-publication'}};
  const host=scriptedHost({registerEvaluator(input,callback){evaluate=callback;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};},publish(){return {version:1,status:'published',operation:publishInput.operation,publication:publicationDrift&&++publishes>1?drift:initial,activePublication:initial.publication,reasons:[]};},readActivePublication(){return publicationDrift?drift:initial;},lookupOperation(){return {version:1,status:'found',record:stored};}});
  return runNativeAdmissionConformance({bb:host,subject:'scripted identity kit counterexample only',publication:publishInput,cases:[{name:'identity',submission,observations:[],complete:true,expectedVerdict:'accepted',expectedAdvice:[]}],ports:{async submit(){
    if(!stored){
      const assessment=await evaluate(changeCallback(await evaluatorInput()),{signal:new AbortController().signal,captureEvidence(){throw Error('unused');}});
      stored=changeRecord({version:1,operation:submission.operation,requestFingerprint:hash,kind:'submission',status:'accepted',original:submission.original,assessments:[assessment],acceptedOriginal:{...accepted(),admission:{kind:'evaluated',publications:[initial.publication],assessments:[assessment]}},publication:null,feedback:null,delivery:{state:'queued',queueId:'q',requestId:null,groupIndex:null,details:null},reasons:[]});
      p.OperationRecordV1Schema.parse(stored); // Wrong responses remain schema-valid and internally consistent.
    }
    return stored;
  }}});
}
test('kit anchors requested original ID/revision rather than a consistently wrong response',async()=>{
  for(const original of [{originalId:'wrong-original',revision:1},{...submission.original,revision:2}]){
    const report=await fixture({changeRecord:record=>({...record,original,acceptedOriginal:{...record.acceptedOriginal,original}})});
    assert.equal(report.passed,false,JSON.stringify({original,report}));assert(report.checks.some(c=>c.name==='submission-identity'&&!c.passed&&/requested original/.test(c.detail)));
  }
});
test('kit anchors canonical destination, source, raw input and requested intent to the fixture',async()=>{
  const changes=[
    value=>({...value,threadId:'wrong-destination'}),
    value=>({...value,source:{...value.source,senderThreadId:'wrong-sender'}}),
    value=>({...value,source:{...value.source,author:{changed:true}}}),
    value=>({...value,source:{...value.source,editor:{changed:true}}}),
    value=>({...value,rawInput:[{type:'text',text:'wrong-original-input'}]}),
    value=>({...value,requestedIntent:{...value.requestedIntent,membership:'separate'}}),
    value=>({...value,requestedIntent:{...value.requestedIntent,schedule:{kind:'scheduled',notBefore:'2026-11-20T00:00:00.000Z'}}}),
    value=>({...value,requestedIntent:{...value.requestedIntent,execution:{...value.requestedIntent.execution,configuration:{changed:true}}}}),
  ];
  for(const change of changes){const report=await fixture({changeRecord:record=>({...record,acceptedOriginal:change(record.acceptedOriginal)})});assert.equal(report.passed,false,JSON.stringify(report));assert(report.checks.some(c=>c.name==='submission-identity'&&!c.passed&&/canonical/.test(c.detail)));}
});
test('kit anchors evaluator input and publication replay to the original fixture',async()=>{
  const wrongCallback=await fixture({changeCallback:input=>({...input,submission:{...input.submission,original:{originalId:'wrong-callback-original',revision:1}}})});
  assert.equal(wrongCallback.passed,false,JSON.stringify(wrongCallback));assert(wrongCallback.checks.some(c=>c.name==='submission-identity'&&!c.passed&&/submission/.test(c.detail)));
  const drift=await fixture({publicationDrift:true});assert.equal(drift.passed,false,JSON.stringify(drift));assert(drift.checks.some(c=>c.name==='publication-replay-and-active-pointer'&&!c.passed));
});
test('kit accepts correct fixture anchors with additive typed output fields',async()=>{
  const report=await fixture({changeRecord:record=>({...record,original:{...record.original,future:true},acceptedOriginal:{...record.acceptedOriginal,original:{...record.original,future:true},source:{...record.acceptedOriginal.source,future:true},requestedIntent:{...record.acceptedOriginal.requestedIntent,future:true}}})});
  assert.equal(report.passed,true,JSON.stringify(report));
});
