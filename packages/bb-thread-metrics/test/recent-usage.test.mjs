import {test,expect} from 'bun:test';
import {recentScopeSchema,validateRecentSnapshot,DEFAULT_SCORING_CONFIG_V2,RECENT_LIMITS} from '../dist/index.js';
import {registerThreadMetricsOwner,createThreadMetricsClient} from '../dist/bb.js';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
const T=1800000000000,ws=v=>Object.fromEntries(['m20','h24','d7','lifetime'].map(w=>[w,structuredClone(v)]));
const vector=n=>({inputUncached:n,cacheRead:0,cacheWrite:0,output:0});
function scope(){const money=ws({kind:'unavailable',amount:null});return {memberCount:2,coverage:'partial',coverageReasons:['unpriced'],priceVersion:'price:1',approximation:{approximate:true,reasons:['missing-price']},windows:money,scores:structuredClone(money),providers:[{providerId:'codex',windows:structuredClone(money),approximation:{approximate:true,reasons:['missing-price']}}],omittedProviders:0,dollarRanks:{m20:null,h24:null,d7:null},scoreRanks:{m20:null,h24:null,d7:null},usage:{windows:ws({kind:'floor',value:vector(200)}),providers:[{providerId:'codex',windows:ws({kind:'floor',value:vector(200)})}],omittedProviders:0,descendants:{count:1,exact:true}}};}
function snapshot(){const pop=Object.fromEntries(['m20','h24','d7'].map(w=>[w,{count:0,coverage:'unknown'}]));return {version:1,revision:'instance:1',unchanged:false,currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:T,rankAsOf:T,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'cfg:1',value:DEFAULT_SCORING_CONFIG_V2},coverage:'partial',coverageReasons:['unpriced'],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:pop,scores:pop},family:{dollars:pop,scores:pop}},rows:[{threadId:'root',revision:'row:1',configRevision:'cfg:1',asOf:T,ownLastFoldAt:T,familyLastFoldAt:T,own:scope(),family:scope()}]};}
async function roundtrip(value){const host=createFakePluginHost({pluginId:'usage-producer'});registerThreadMetricsOwner(host.bb,{capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>value});try{return await createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'usage-producer').recentSnapshot();}finally{await host.harness.lifecycle.dispose();}}
test('public emitted owner/client retains unpriced token floors and exact descendant count without fabricating dollars',async()=>{
 const s=snapshot(),result=await roundtrip(s);expect(result.rows[0].family.usage.windows.d7).toEqual({kind:'floor',value:vector(200)});expect(result.rows[0].family.windows.d7.amount).toBeNull();expect(result.rows[0].family.usage.descendants).toEqual({count:1,exact:true});
 const unknown=scope();unknown.usage.windows=unknown.usage.providers[0].windows=ws({kind:'unavailable',value:null});expect(recentScopeSchema.parse(unknown).usage.windows.m20.value).toBeNull();
 const zero=scope();zero.usage.windows=zero.usage.providers[0].windows=ws({kind:'estimate',value:vector(0)});expect(recentScopeSchema.parse(zero).usage.windows.m20.value.inputUncached).toBe(0);
 const legacy=scope();delete legacy.usage;expect(recentScopeSchema.parse(legacy).usage).toBeUndefined();
});
test('token attribution, descendant bounds and known component conservation reject at public boundary',async()=>{
 const variants=[s=>{s.usage.providers[0].providerId='claude-code';},s=>{s.usage.providers.push(structuredClone(s.usage.providers[0]));},s=>{s.usage.descendants.count=2;},s=>{s.usage.providers[0].windows.h24.value.inputUncached=201;},s=>{s.usage.windows.h24={kind:'unavailable',value:null};},s=>{s.usage.windows.d7.value.cacheRead=1;},s=>{s.usage.omittedProviders=1;}];
 for(const mutate of variants){const f=snapshot();mutate(f.rows[0].family);expect(()=>validateRecentSnapshot({},f)).toThrow();await expect(roundtrip(f)).rejects.toThrow();}
});
test('explicit omitted providers allow an aggregate supported subtotal above displayed tokens, never below them',()=>{
 const s=scope();s.omittedProviders=s.usage.omittedProviders=1;s.coverageReasons.push('provider-cap');s.usage.windows=ws({kind:'floor',value:vector(400)});expect(recentScopeSchema.parse(s).usage.windows.d7.value.inputUncached).toBe(400);
 s.usage.windows.h24.value.inputUncached=199;expect(()=>recentScopeSchema.parse(s)).toThrow('conservation');
});

test('token estimate requires complete provider token support independently in every window',async()=>{
 for(const w of ['m20','h24','d7','lifetime']){
  for(const providerKind of ['floor','unavailable']){
   const f=snapshot(),u=f.rows[0].family.usage;u.windows[w]={kind:'estimate',value:vector(0)};u.providers[0].windows[w]=providerKind==='floor'?{kind:'floor',value:vector(0)}:{kind:'unavailable',value:null};
   expect(()=>validateRecentSnapshot({},f)).toThrow('aggregate estimate');await expect(roundtrip(f)).rejects.toThrow();
  }
  const omitted=snapshot(),u=omitted.rows[0].family.usage;omitted.rows[0].family.omittedProviders=u.omittedProviders=1;u.windows[w]={kind:'estimate',value:vector(400)};u.providers[0].windows[w]={kind:'estimate',value:vector(200)};
  expect(()=>validateRecentSnapshot({},omitted)).toThrow('aggregate estimate');await expect(roundtrip(omitted)).rejects.toThrow();
 }
 for(const n of [0,200]){const f=snapshot(),u=f.rows[0].family.usage;u.windows=u.providers[0].windows=ws({kind:'estimate',value:vector(n)});const result=await roundtrip(f);expect(result.rows[0].family.usage.windows.d7.value.inputUncached).toBe(n);expect(result.rows[0].family.windows.d7.amount).toBeNull();}
});
test('explicit membership caps cannot become an exact descendant count, but pricing-only partial counts remain attested',async()=>{
 for(const reason of ['member-cap','depth-cap','edge-cap']){
  const f=snapshot();f.rows[0].family.coverageReasons.push(reason);expect(()=>validateRecentSnapshot({},f)).toThrow('exact descendant');await expect(roundtrip(f)).rejects.toThrow();
  f.rows[0].family.usage.descendants.exact=false;expect((await roundtrip(f)).rows[0].family.usage.descendants).toEqual({count:1,exact:false});
 }
 expect((await roundtrip(snapshot())).rows[0].family.usage.descendants).toEqual({count:1,exact:true});
});
