import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as a from '../dist/index.js';
const v = (i=0,r=0,w=0,o=0) => ({inputUncached:i,cacheRead:r,cacheWrite:w,output:o});

test('vector codec finite nonnegative; commutative monoid identity and associativity',()=>{
  for (const bad of [-1,NaN,Infinity]) assert.equal(a.UsageVectorSchema.safeParse(v(bad)).success,false);
  for(let i=0;i<100;i++) {
    const x=v(i,2*i,3*i,i+1), y=v(7,4,3,2), z=v(1,1,2,3);
    assert.deepEqual(a.addUsageVectors(x,a.zeroUsageVector()),x);
    assert.deepEqual(a.addUsageVectors(x,y),a.addUsageVectors(y,x));
    assert.deepEqual(a.addUsageVectors(a.addUsageVectors(x,y),z),a.addUsageVectors(x,a.addUsageVectors(y,z)));
  }
  assert.throws(()=>a.addUsageVectors(v(Number.MAX_VALUE),v(Number.MAX_VALUE)));
});
test('real translator normalized fixtures: Claude/Pi exclusive, Codex cache alias inclusive, reasoning subset',()=>{
  const claude={inputTokens:100,cacheReadInputTokens:40,cacheWriteInputTokens:10,cachedInputTokens:50,outputTokens:20,totalTokens:170,reasoningOutputTokens:0};
  for(const p of ['claude-code','provider-claude-code','pi']) assert.deepEqual(a.canonicalize(p,claude),{vector:v(100,40,10,20),complete:true,issues:[]});
  const codex={inputTokens:150,cachedInputTokens:50,cacheReadInputTokens:50,cacheWriteInputTokens:0,outputTokens:30,reasoningOutputTokens:20,totalTokens:180};
  assert.deepEqual(a.canonicalize('codex',codex),{vector:v(100,50,0,30),complete:true,issues:[]});
  // total is advisory; reasoning is never added to output.
  assert.deepEqual(a.canonicalize('codex',{...codex,totalTokens:999}).vector,v(100,50,0,30));
});
test('missing classes, cache aggregate normalization and unknown translator approximation are explicit',()=>{
  const missing=a.canonicalize('pi',{outputTokens:3}); assert.equal(missing.complete,false);assert.deepEqual(missing.vector,v(0,0,0,3));
  const aggregate=a.canonicalize('pi',{inputTokens:5,cachedInputTokens:10,outputTokens:2});assert.deepEqual(aggregate.vector,v(5,10,0,2));assert.equal(aggregate.complete,false);
  assert.deepEqual(a.canonicalize('pi',{inputTokens:5,cachedInputTokens:10,cacheWriteInputTokens:3,outputTokens:2}).vector,v(5,7,3,2));
  const unknown=a.canonicalize('custom',{inputTokens:100,cachedInputTokens:30,outputTokens:4});assert.equal(unknown.complete,false);assert.deepEqual(unknown.vector,v(70,30,0,4));
  assert.equal(a.canonicalize('custom',{totalTokens:100}).vector,null);
  const cacheOnly=a.canonicalize('custom',{cacheReadInputTokens:30,cacheWriteInputTokens:7});assert.deepEqual(cacheOnly.vector,v(0,30,7,0));assert.equal(cacheOnly.complete,false);
  assert.deepEqual(a.canonicalize('custom',{inputTokens:100,outputTokens:4},{inputSemantics:'exclusive'}).vector,v(100,0,0,4));
  const bad=a.canonicalize('codex',{inputTokens:4,cacheReadInputTokens:8,cacheWriteInputTokens:2,outputTokens:1});assert.deepEqual(bad.vector,v(0,4,0,1));assert.equal(bad.complete,false);
  assert.throws(()=>a.canonicalize('pi',{inputTokens:-2}));
});
test('absent cache observations are incomplete; explicit zero observations remain valid',()=>{
  for (const provider of ['claude-code','pi','codex']) {
    const missing=a.canonicalize(provider,{inputTokens:100,outputTokens:10});
    assert.equal(missing.complete,false,provider);
    assert.ok(missing.issues.some(issue=>issue.startsWith('missing-cache-observations:')),provider);
    for (const cache of [provider==='codex' ? {cachedInputTokens:0,cacheWriteInputTokens:0} : {cachedInputTokens:0},{cacheReadInputTokens:0,cacheWriteInputTokens:0}]) {
      const zero=a.canonicalize(provider,{inputTokens:100,outputTokens:10,...cache});
      assert.equal(zero.complete,true,provider);
      assert.deepEqual(zero.vector,v(100,0,0,10));
    }
  }
});
test('single cache class without aggregate is incomplete symmetrically; aggregate inference remains complete',()=>{
  for (const provider of ['claude-code','pi','codex']) {
    for (const cache of [{cacheReadInputTokens:40},{cacheWriteInputTokens:20}]) {
      const result=a.canonicalize(provider,{inputTokens:100,outputTokens:10,...cache});
      assert.equal(result.complete,false,`${provider} ${JSON.stringify(cache)}`);
      assert.equal(result.vector.cacheRead,cache.cacheReadInputTokens??0);
      assert.equal(result.vector.cacheWrite,cache.cacheWriteInputTokens??0);
    }
  }
  for (const provider of ['claude-code','pi']) {
    for (const cache of [{cachedInputTokens:60,cacheReadInputTokens:40},{cachedInputTokens:60,cacheWriteInputTokens:20}]) {
      const result=a.canonicalize(provider,{inputTokens:100,outputTokens:10,...cache});
      assert.equal(result.complete,true);assert.deepEqual(result.vector,v(100,40,20,10));
    }
  }
  assert.equal(a.canonicalize('codex',{inputTokens:100,outputTokens:10,cachedInputTokens:0}).complete,false);
  assert.equal(a.canonicalize('codex',{inputTokens:100,outputTokens:10,cachedInputTokens:40,cacheWriteInputTokens:20}).complete,true);
});
test('single-field A/B/C composition skips partial cache baseline symmetrically',()=>{
  for (const provider of ['claude-code','pi','codex']) {
    for (const cache of [{cacheReadInputTokens:40},{cacheWriteInputTokens:20}]) {
      const full={cachedInputTokens:provider==='codex'?40:60,cacheReadInputTokens:40,cacheWriteInputTokens:20};
      const observations=[{inputTokens:100,outputTokens:10,...full},{inputTokens:110,outputTokens:11,...cache},{inputTokens:120,outputTokens:12,...full}];
      let state=null,total=a.zeroUsageVector();const statuses=[];
      observations.forEach((breakdown,sequence)=>{
        const canonical=a.canonicalize(provider,breakdown);
        if (!canonical.complete) {assert.equal(sequence,1);assert.equal(state.sequence,0);return;}
        const result=a.counterToIncrement(state,{epochKey:'same-session',sequence,total:canonical.vector});
        state=result.state;total=a.addUsageVectors(total,result.increment);statuses.push(result.status);
      });
      assert.deepEqual(statuses,['initial','advance']);
      assert.equal(state.sequence,2);
      assert.deepEqual(total,a.canonicalize(provider,observations[2]).vector);
    }
  }
});
test('canonicalize-to-counter composition retains A baseline across incomplete B, then telescopes to C',()=>{
  const observations=[
    {inputTokens:100,outputTokens:10,cachedInputTokens:60,cacheReadInputTokens:40,cacheWriteInputTokens:20},
    {inputTokens:110,outputTokens:11},
    {inputTokens:120,outputTokens:12,cachedInputTokens:60,cacheReadInputTokens:40,cacheWriteInputTokens:20},
  ];
  for(const provider of ['claude-code','pi','codex']) {
    let state=null, total=a.zeroUsageVector();
    const statuses=[];
    // Codex aggregate aliases reads, whereas Claude/Pi aggregate is reads+writes.
    const providerObservations=observations.map(breakdown=>provider==='codex' && breakdown.cachedInputTokens !== undefined
      ? {...breakdown,cachedInputTokens:breakdown.cacheReadInputTokens} : breakdown);
    providerObservations.forEach((breakdown,sequence)=>{
      const canonical=a.canonicalize(provider,breakdown);
      if (!canonical.complete || !canonical.vector) {
        assert.equal(sequence,1);
        assert.equal(state.sequence,0); // B must not replace accepted A baseline.
        return;
      }
      const result=a.counterToIncrement(state,{epochKey:'same-session',sequence,total:canonical.vector});
      state=result.state;total=a.addUsageVectors(total,result.increment);statuses.push(result.status);
    });
    assert.deepEqual(statuses,['initial','advance']);
    assert.equal(state.sequence,2);
    assert.deepEqual(total,a.canonicalize(provider,providerObservations[2]).vector);
    assert.deepEqual(total,provider==='codex' ? v(60,40,20,12) : v(120,40,20,12));
  }
});
test('counter replay, stale input, epoch change, whole-vector regression and constant snapshots',()=>{
  const s=(epochKey,sequence,total)=>({epochKey,sequence,total});
  const results=a.counterToIncrements([s('a',1,v(10,2)),s('a',2,v(15,3)),s('a',2,v(15,3)),s('a',1,v(10,2)),s('a',3,v(15,3)),s('a',4,v(2,4)),s('b',5,v(1)),s('a',2,v(15,3))]);
  assert.deepEqual(results.map(x=>x.status),['initial','advance','duplicate','stale','advance','regression-reset','epoch-change','stale']);
  assert.deepEqual(results.map(x=>x.increment),[v(10,2),v(5,1),v(),v(),v(),v(2,4),v(1),v()]);
  assert.deepEqual(results.at(-1).state,s('b',5,v(1)));
  // Continuous epoch telescopes to latest total regardless of sampling.
  assert.deepEqual(a.addUsageVectors(...a.counterToIncrements([s('a',1,v(2)),s('a',3,v(11)),s('a',5,v(18))]).map(x=>x.increment)),v(18));
});
test('5-minute bucket boundaries; aligned and jitter windows, no future data',()=>{
  const B=a.BUCKET_MS;assert.equal(a.bucketStart(B-1),0);assert.equal(a.bucketStart(B),B);
  const buckets=Array.from({length:7},(_,i)=>({start:i*B,vector:v(i+1)}));
  assert.deepEqual(a.windowSum(buckets,5*B,20*60*1000),v(3+4+5+6));
  assert.deepEqual(a.windowSum(buckets,5*B+1,20*60*1000),v(3+4+5+6));
  assert.deepEqual(a.windowSum(buckets,0,0),v());
  const day=Array.from({length:300},(_,i)=>({start:i*B,vector:v(1)}));
  assert.equal(a.windowSum(day,299*B,a.WINDOW_MS.h24).inputUncached,288);
  assert.equal(a.windowSum(day,299*B+B-1,a.WINDOW_MS.h24).inputUncached,288);
  assert.equal(a.windowSum(day,299*B+B-1,a.WINDOW_MS.m20).inputUncached,4);
  assert.throws(()=>a.windowSum([{start:1,vector:v()}],B,B));
});
test('pricing linearity, deterministic nearest model, provider/default fallbacks and no-rate last resort',()=>{
  const table=a.DEFAULT_RATE_TABLE, x=v(1e6,1e6,1e6,1e6), y=v(20,30,40,50);
  const p=z=>a.price(table,'claude-code','claude-sonnet-4-6',z);
  assert.ok(Math.abs(p(a.addUsageVectors(x,y)).amount-p(x).amount-p(y).amount)<1e-10);
  assert.equal(p(x).amount,22.05);assert.equal(p(x).estimated,true);
  assert.equal(a.price(table,'codex','gpt-5.3-codex',x).approximate,true);
  const nearest=a.matchRate(table,'codex','gpt-6.1-sol-preview');assert.equal(nearest.reason,'nearest-provider-model');assert.equal(nearest.rate.modelId,'gpt-6.1-sol');
  assert.deepEqual(a.matchRate({...table,rates:[...table.rates].reverse()},'codex','gpt-6.1-sol-preview'),nearest);
  assert.equal(a.price(table,'unknown',null,x).reason,'explicit-default');
  const empty={schemaVersion:1,version:'none',currency:'USD',rates:[],defaultRateId:null};assert.equal(a.price(empty,'none',null,x).amount,null);
  assert.equal(a.RateTableSchema.safeParse({...empty,defaultRateId:'absent'}).success,false);
  assert.equal(a.RateTableSchema.safeParse({...table,rates:[...table.rates,table.rates[0]]}).success,false);
  assert.equal(a.RateTableSchema.safeParse({...table,schemaVersion:2}).success,false);
});
