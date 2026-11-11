import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindMessageAdmission} from '../dist/bb.js';
import {scriptedHost,publishInput,publication,evaluatorInput,result,hash} from './fixtures.mjs';
async function client(host){const binding=await bindMessageAdmission(host);assert.equal(binding.status,'available');return binding.client;}
const registration={version:1,evaluatorVersion:publishInput.evaluatorVersion};
const context=()=>({signal:new AbortController().signal,captureEvidence(){throw Error('unused');}});
function publicationRecord(value){return {version:1,operation:value.operation,requestFingerprint:hash,kind:'publication',status:'accepted',original:null,assessments:[],acceptedOriginal:null,publication:value,feedback:null,delivery:{state:'none',queueId:null,requestId:null,groupIndex:null,details:null},reasons:[]};}
test('review P2: changed immutable publication bytes are rejected before evaluator work',async()=>{
  let callback,paidWork=0;
  const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  await c.registerEvaluator(registration,()=>{paidWork++;return result();});
  for(const change of [value=>({...value,snapshotBytes:'{"rules":["changed"]}'}),value=>({...value,configurationVersion:'changed-config'}),value=>({...value,enrollment:{mode:'disabled',projectIds:[]}})]){
    const input=await evaluatorInput();input.publication=change(input.publication);
    await assert.rejects(callback(input,context()),/fingerprint/);
  }
  assert.equal(paidWork,0);
});
test('review P2: active publication reads verify full immutable content fingerprint',async()=>{
  const changed={...await publication(),snapshotBytes:'{"rules":["changed"]}'};
  const c=await client(scriptedHost({readActivePublication(){return changed;}}));
  await assert.rejects(c.readActivePublication({version:1,providerId:publishInput.providerId}),error=>error.outcome==='read-failed'&&/fingerprint/.test(error.message));
});
test('review P2: publication lookup and recheck verify stored immutable content',async()=>{
  const changed={...await publication(),snapshotBytes:'{"rules":["changed"]}'};
  const response={version:1,status:'found',record:publicationRecord(changed)};
  const c=await client(scriptedHost({lookupOperation(){return response;},recheckOperation(){return response;}}));
  await assert.rejects(c.lookupOperation({version:1,operation:changed.operation}),error=>error.outcome==='read-failed'&&/fingerprint/.test(error.message));
  await assert.rejects(c.recheckOperation({version:1,operation:changed.operation,expectedRequestFingerprint:hash,recheckId:'recheck-review'}),error=>error.outcome==='unknown'&&/fingerprint/.test(error.message));
});
test('review P2: full publication data in conflict responses is also validated',async()=>{
  const changed={...await publication(),snapshotBytes:'{"rules":["changed"]}'};
  const c=await client(scriptedHost({publish(){return {version:1,status:'conflict',operation:publishInput.operation,publication:changed,activePublication:changed.publication,reasons:[]};}}));
  await assert.rejects(c.publish(publishInput),error=>error.outcome==='unknown'&&/fingerprint/.test(error.message));
});
test('review P2: caller mutation after registration cannot change callback identity',async()=>{
  let callback;
  const c=await client(scriptedHost({registerEvaluator(input,evaluate){callback=evaluate;return {version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion};}}));
  const options={...registration};await c.registerEvaluator(options,()=>result());options.evaluatorVersion='another-version';
  assert.equal((await callback(await evaluatorInput(),context())).verdict,'accepted');
  const changed=await evaluatorInput();changed.publication=await publication({...publishInput,evaluatorVersion:'another-version'});
  await assert.rejects(callback(changed,context()),/version mismatch/);
});
test('review P2: caller mutation while registration is pending cannot change response binding',async()=>{
  let complete,captured;
  const c=await client(scriptedHost({registerEvaluator(input){captured=input;return new Promise(resolve=>complete=()=>resolve({version:1,registrationId:'r',generation:'g',evaluatorVersion:input.evaluatorVersion}));}}));
  const options={...registration};const pending=c.registerEvaluator(options,()=>result());options.evaluatorVersion='another-version';complete();
  assert.equal((await pending).evaluatorVersion,registration.evaluatorVersion);assert.equal(captured.evaluatorVersion,registration.evaluatorVersion);assert(Object.isFrozen(captured));
});
