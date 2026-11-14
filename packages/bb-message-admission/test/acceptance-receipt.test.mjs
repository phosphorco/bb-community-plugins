import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../dist/protocol.js';
import {bindMessageAdmission} from '../dist/bb.js';
import {runNativeAdmissionConformance} from '../dist/testing.js';
import {accepted,submission,hash,scriptedHost,publication,publishInput,evaluatorInput} from './fixtures.mjs';
const receipt={source:'direct-queue',response:{id:'queue-original',createdAt:1730000000000},future:{metadata:['preserved',null]}};
const base=()=>({version:1,operation:submission.operation,requestFingerprint:hash,kind:'submission',status:'accepted',original:submission.original,assessments:[],acceptedOriginal:accepted(),publication:null,feedback:null,delivery:{state:'queued',queueId:'queue-original',requestId:null,groupIndex:null,details:null},reasons:[]});
const lookup=record=>({version:1,status:'found',record});
async function client(host){const bound=await bindMessageAdmission(host);assert.equal(bound.status,'available');return bound.client;}
test('acceptance receipt is optional finite JSON output; absence and explicit null remain distinct',()=>{
  const original=base();assert(!Object.hasOwn(p.OperationRecordV1Schema.parse(original),'acceptanceReceipt'));
  for(const value of [receipt,null,[],false,0,'opaque native response']){
    const record=p.OperationRecordV1Schema.parse({...original,acceptanceReceipt:value,futureOutput:{kept:true}});
    assert(Object.hasOwn(record,'acceptanceReceipt'));assert.deepEqual(record.acceptanceReceipt,value);assert.deepEqual(record.futureOutput,{kept:true});
    assert.deepEqual(record.acceptedOriginal,original.acceptedOriginal);
  }
});
test('explicit acceptance receipt rejects non-JSON values without invoking accessors',()=>{
  const cyclic={};cyclic.self=cyclic;let invoked=false;
  const accessor={get value(){invoked=true;return 1;}};
  for(const value of [undefined,NaN,Infinity,()=>{},1n,cyclic,accessor,{nested:undefined}])assert.throws(()=>p.OperationRecordV1Schema.parse({...base(),acceptanceReceipt:value}));
  assert.equal(invoked,false);
});
test('receipt bytes share the full output budget, with exact UTF-8 boundary and no truncation',()=>{
  const record={...base(),acceptanceReceipt:{text:'é'.repeat(128)}};
  const bytes=new TextEncoder().encode(p.canonicalJson(record,65536)).byteLength;
  assert.deepEqual(p.decodeBounded(p.OperationRecordV1Schema,record,bytes).acceptanceReceipt,record.acceptanceReceipt);
  assert.throws(()=>p.decodeBounded(p.OperationRecordV1Schema,record,bytes-1),error=>error.code==='capacity');
});
test('lookup and recheck preserve the same receipt across scripted queue removal and delivery progress',async()=>{
  const first={...base(),acceptanceReceipt:receipt};
  const completed={...first,delivery:{state:'completed',queueId:null,requestId:'request-original',groupIndex:0,details:{queueRemoved:true}}};
  const c=await client(scriptedHost({lookupOperation(){return lookup(first);},recheckOperation(){return lookup(completed);}}));
  const a=(await c.lookupOperation({version:1,operation:submission.operation})).record;
  const b=(await c.recheckOperation({version:1,operation:submission.operation,expectedRequestFingerprint:hash,recheckId:'receipt-recheck'})).record;
  assert.deepEqual(a.acceptanceReceipt,b.acceptanceReceipt);assert.equal(b.delivery.state,'completed');assert.equal(b.delivery.queueId,null);
  assert(!Object.hasOwn(b.acceptanceReceipt.response,'input'));assert.deepEqual(b.acceptedOriginal.rawInput,submission.rawInput);
  b.acceptanceReceipt.response.id='local mutation';assert.equal(receipt.response.id,'queue-original');
});
test('alpha1 receipt absence preserves accepted status and negotiated availability',async()=>{
  const c=await client(scriptedHost({lookupOperation(){return lookup(base());}}));
  const result=await c.lookupOperation({version:1,operation:submission.operation});
  assert.equal(result.record.status,'accepted');assert(!Object.hasOwn(result.record,'acceptanceReceipt'));assert.deepEqual(result.record.acceptedOriginal,accepted());
});
test('a receipt payload is not an admission verdict or a canonical original',()=>{
  const initial={...base(),acceptanceReceipt:{source:'native-preparation',response:{state:'preparing',rawInput:'not canonical'}}};
  const completed={...initial,delivery:{...initial.delivery,state:'completed'}};
  const parsed=p.OperationRecordV1Schema.parse(completed);
  assert.equal(parsed.status,'accepted');assert.equal(parsed.acceptanceReceipt.response.state,'preparing');assert.deepEqual(parsed.acceptedOriginal.rawInput,submission.rawInput);
  assert.throws(()=>p.OperationRecordV1Schema.parse({...initial,acceptedOriginal:null}),/immutable accepted original/);
});
/** Scripted kit self-test, never a native persistence/queue/restart witness. */
async function replayFixture(changedReceipt){
  let evaluate,firstRecord;
  const pub=await publication();
  const host=scriptedHost({registerEvaluator(input,callback){evaluate=callback;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};},readActivePublication(){return pub;},lookupOperation(){return lookup(firstRecord);}});
  let submits=0;
  return runNativeAdmissionConformance({bb:host,subject:'scripted receipt replay kit self-test only',publication:publishInput,cases:[{name:'receipt-replay',submission,observations:[],complete:true,expectedVerdict:'accepted',expectedAdvice:[]}],ports:{async submit(){
    if(++submits===1){
      const assessment=await evaluate(await evaluatorInput(),{signal:new AbortController().signal,captureEvidence(){throw Error('unused');}});
      firstRecord={...base(),assessments:[assessment],acceptanceReceipt:receipt,acceptedOriginal:{...accepted(),admission:{kind:'evaluated',publications:[pub.publication],assessments:[assessment]}}};return firstRecord;
    }
    return {...firstRecord,acceptanceReceipt:changedReceipt?{...receipt,response:{id:'changed-acceptance'}}:receipt,delivery:{state:'completed',queueId:null,requestId:'request-original',groupIndex:0,details:null}};
  }}});
}
test('conformance replay permits delivery progress but reports an explicit immutable receipt change',async()=>{
  const stable=await replayFixture(false);assert.equal(stable.passed,true,JSON.stringify(stable));
  const changed=await replayFixture(true);assert.equal(changed.passed,false);assert(changed.checks.some(check=>check.name==='submission-receipt-replay'&&!check.passed));
});
