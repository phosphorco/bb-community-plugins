import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runCapabilityConformance,CONFORMANCE_OBLIGATIONS} from '../dist/testing.js';
import {scriptedHost} from './fixtures.mjs';
test('conformance never calls absent or incompatible hosts successful',async()=>{
  for(const bb of [{},scriptedHost({describe(){return {protocol:'bb-message-admission',versions:[2],capabilities:null};}})]){
    const result=await runCapabilityConformance({bb,subject:'boundary fixture',cases:[]});assert.equal(result.status,'unsupported');assert.equal(result.passed,false);
  }
});
test('method shape alone is insufficient; no cases cannot pass',async()=>{
  const result=await runCapabilityConformance({bb:scriptedHost(),subject:'boundary fixture',cases:[]});assert.equal(result.status,'failed');assert(result.checks.some(c=>c.name==='behavioral-cases'&&!c.passed));
});
test('driver records each observation and keeps failures visible',async()=>{
  const result=await runCapabilityConformance({bb:scriptedHost(),subject:'scripted boundary fixture; not native proof',cases:[{name:'actual-read-port',run:client=>client.readActivePublication({version:1,providerId:'fixture-provider'}),verify:value=>assert.equal(value,null)},{name:'deliberate-bad-expectation',run:()=>1,verify:()=>{throw new Error('expected witness');}}]});
  assert.equal(result.passed,false);assert.deepEqual(result.coverage,['actual-read-port','deliberate-bad-expectation']);assert.equal(result.checks.at(-1).detail,'expected witness');assert(CONFORMANCE_OBLIGATIONS.length>5);
});
