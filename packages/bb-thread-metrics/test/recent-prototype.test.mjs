import { test,expect } from 'bun:test';
// Additive0.2 contract source; no registry/runtime release claim.
import { RECENT_LIMITS,DEFAULT_SCORING_CONFIG_V2,weightedScoreV2,recentDollarSchema,validateRecentSnapshot,recentPercentileHeat } from '../dist/index.js';
const now=1800000000000;
const windows=()=>Object.fromEntries(['m20','h24','d7','lifetime'].map(k=>[k,{kind:'estimate',amount:1}]));
const scope=()=>({memberCount:1,coverage:'complete',coverageReasons:[],priceVersion:'rates-v1',approximation:{approximate:false,reasons:[]},windows:windows(),scores:windows(),providers:[{providerId:'claude-code',approximation:{approximate:false,reasons:[]},windows:windows()}],omittedProviders:0,dollarRanks:{m20:0,h24:0,d7:0},scoreRanks:{m20:0,h24:0,d7:0}});
const row=(threadId='thr_one')=>({threadId,revision:'r1',configRevision:'cfg:1',asOf:now,ownLastFoldAt:now,familyLastFoldAt:now,own:scope(),family:scope()});
const population=()=>Object.fromEntries(['m20','h24','d7'].map(k=>[k,{count:1,coverage:'complete'}]));
const fixture=()=>({version:1,revision:'instance:1',unchanged:false,currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:now,rankAsOf:now,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'cfg:1',value:DEFAULT_SCORING_CONFIG_V2},coverage:'complete',coverageReasons:[],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:population(),scores:population()},family:{dollars:population(),scores:population()}},rows:[row()]});
test('snapshot prototype preserves explicit estimate/floor/attested-zero/unavailable and revision identity',()=>{
 const f=fixture();f.rows[0].own.windows.m20=f.rows[0].own.scores.m20=f.rows[0].own.providers[0].windows.m20={kind:'floor',amount:0};f.rows[0].family.windows.m20=f.rows[0].family.scores.m20=f.rows[0].family.providers[0].windows.m20={kind:'unavailable',amount:null};f.rows[0].own.dollarRanks.m20=f.rows[0].own.scoreRanks.m20=null;f.rows[0].family.dollarRanks.m20=f.rows[0].family.scoreRanks.m20=null;f.rows[0].family.approximation=f.rows[0].family.providers[0].approximation={approximate:true,reasons:['missing-price']};const v=validateRecentSnapshot({},f);expect(v.rows[0].own.windows.m20).toEqual({kind:'floor',amount:0});expect(v.rows[0].family.windows.m20).toEqual({kind:'unavailable',amount:null});expect(()=>recentDollarSchema.parse({kind:'unavailable',amount:0})).toThrow();expect(()=>validateRecentSnapshot({},{version:1,unchanged:true,revision:'other'})).toThrow();expect(validateRecentSnapshot({ifRevision:'same'},{version:1,unchanged:true,revision:'same'}).unchanged).toBe(true);
});
test('snapshot prototype accounts unknown additive bytes before decoding and rejects duplicate/capped/future rows',()=>{
 const f=fixture();f.extra='ok';expect(validateRecentSnapshot({},f).extra).toBeUndefined();f.rows[0].extra='x'.repeat(RECENT_LIMITS.rowBytes);expect(()=>validateRecentSnapshot({},f)).toThrow('row byte');const tooBig=fixture();tooBig.extra='x'.repeat(RECENT_LIMITS.bytes);expect(()=>validateRecentSnapshot({},tooBig)).toThrow('byte');const dup=fixture();dup.rows.push(row());expect(()=>validateRecentSnapshot({},dup)).toThrow('Duplicate');const cap=fixture();cap.materializationPending=1;expect(()=>validateRecentSnapshot({},cap)).toThrow('coverage');const future=fixture();future.rows[0].familyLastFoldAt=now+1;expect(()=>validateRecentSnapshot({},future)).toThrow('activity');const configMismatch=fixture();configMismatch.rows[0].configRevision='old-config';expect(()=>validateRecentSnapshot({},configMismatch)).toThrow('configuration mismatch');const old=fixture();old.rows[0].ownLastFoldAt=old.rows[0].familyLastFoldAt=now-RECENT_LIMITS.windowMs-1;expect(()=>validateRecentSnapshot({},old)).toThrow('activity');
});
test('weighted dollars default to1 and never reprice; unknown/duplicate/overflow paths stay explicit',()=>{
 const values=[{providerId:'claude-code',amount:20},{providerId:'codex',amount:10}];expect(weightedScoreV2(values,{})).toBe(30);expect(weightedScoreV2(values,{'claude-code':1.5,codex:1})).toBe(40);expect(values[0].amount).toBe(20);expect(weightedScoreV2([{providerId:'constructor',amount:2}],{})).toBe(2);expect(weightedScoreV2([{providerId:'claude-code',amount:null}],{})).toBeNull();expect(()=>weightedScoreV2([...values,values[0]],{})).toThrow('Duplicate');expect(()=>weightedScoreV2([{providerId:'codex',amount:Number.MAX_VALUE}],{codex:2})).toThrow('overflow');
});
test('400-row compact prototype has measured bounded JSON bytes, qualified synthetic only',()=>{
 const f=fixture();f.rows=Array.from({length:400},(_,i)=>row(`thr_${i}`)).sort((a,b)=>a.threadId<b.threadId?-1:1);const bytes=new TextEncoder().encode(JSON.stringify(f)).byteLength;validateRecentSnapshot({},f);expect(bytes).toBeLessThan(RECENT_LIMITS.bytes);console.log(JSON.stringify({witness:'snapshot-prototype400',bytes,rows:400,qualification:'synthetic DTO only, not live-store materializer/consumer measurement'}));
});

test('emitted owner/client capability and conditional snapshot method preserve the old read lane',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const {runSupplierConformance}=await import('../dist/testing.js');
 const capabilities={summary:true,series:false,detail:false,recentSnapshotV1:true};let legacyReads=0;
 const port={capabilities,read:async()=>{legacyReads++;return {version:1,rows:[]};},recentSnapshot:async input=>input.ifRevision==='instance:1'?{version:1,unchanged:true,revision:'instance:1'}:fixture()};
 const host=createFakePluginHost({pluginId:'supplier'});registerThreadMetricsOwner(host.bb,port);const calls=[];const sdk={plugins:{list:async()=>({plugins:[]}),callRpc:async a=>{calls.push(a.method);return host.harness.behavior.callRpc(a.method,a.input);}}};
 try{const client=createThreadMetricsClient(sdk,'supplier');expect((await client.describe()).capabilities.recentSnapshotV1).toBe(true);expect((await client.recentSnapshot()).rows).toHaveLength(1);expect((await client.recentSnapshot({ifRevision:'instance:1'})).unchanged).toBe(true);expect(legacyReads).toBe(0);expect(calls).toEqual(['threadMetricsDescribe','threadMetricsRecentSnapshotV1','threadMetricsRecentSnapshotV1']);await expect(host.harness.behavior.callRpc('threadMetricsRecentSnapshotV1',{unexpected:true})).rejects.toThrow();}
 finally{await host.harness.lifecycle.dispose();}
 const report=await runSupplierConformance({pluginId:'supplier-kit',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[{scope:'own',threadIds:['thr_one']}],recentCases:[{},{ifRevision:'instance:1'}]});expect(report.passed).toBe(true);expect(report.checks.filter(x=>x.name.startsWith('recent-'))).toHaveLength(2);
});
test('unadvertised legacy supplier remains compatible and capability/handler mismatch fails closed',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const host=createFakePluginHost({pluginId:'old'});const port={capabilities:{summary:true,series:false,detail:false},read:async()=>({version:1,rows:[]})};
 try{registerThreadMetricsOwner(host.bb,port);const client=createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'old');expect((await client.describe()).kind).toBe('ready');expect((await client.describe()).capabilities.recentSnapshotV1).toBeUndefined();expect((await client.read({scope:'own',threadIds:['thr_one']})).rows).toHaveLength(0);await expect(client.recentSnapshot()).rejects.toThrow();expect(()=>registerThreadMetricsOwner(host.bb,{...port,capabilities:{...port.capabilities,recentSnapshotV1:true}})).toThrow('mismatch');}
 finally{await host.harness.lifecycle.dispose();}
});

test('provider totals, configured weighted scores, row order and cap cutoff are validated',()=>{
 const f=fixture();f.rows[0].own.windows.m20.amount=2;expect(()=>validateRecentSnapshot({},f)).toThrow('dollar total');const score=fixture();score.config.value={schemaVersion:2,mode:'percentile',providerWeights:{'claude-code':1.5},gates:{m20:.9,h24:.9,d7:.9}};expect(()=>validateRecentSnapshot({},score)).toThrow('score total');for(const scope of [score.rows[0].own,score.rows[0].family])for(const w of ['m20','h24','d7','lifetime'])scope.scores[w].amount=1.5;expect(validateRecentSnapshot({},score).rows).toHaveLength(1);const order=fixture();order.rows=[row('z'),row('a')];expect(()=>validateRecentSnapshot({},order)).toThrow('newest first');const cap=fixture();cap.coverage='partial';cap.omittedRows={count:1,exact:true};expect(()=>validateRecentSnapshot({},cap)).toThrow('cutoff');cap.cutoffLastFoldAt=now;expect(validateRecentSnapshot({},cap).rows).toHaveLength(1);
});


test('reviewed malformed recent replies fail through emitted codec, real owner/client and conformance',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');
 const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');
 const {runSupplierConformance}=await import('../dist/testing.js');
 const cases=[
  ['known partial subtotal',f=>{const p=f.rows[0].own;p.coverage='partial';p.providers[0].windows.m20={kind:'floor',amount:10};p.providers.push({...structuredClone(p.providers[0]),providerId:'codex',windows:Object.fromEntries(['m20','h24','d7','lifetime'].map(w=>[w,{kind:'unavailable',amount:null}]))});p.windows.m20=p.scores.m20={kind:'floor',amount:1};}],
  ['tiny omitted subtotal',f=>{const p=f.rows[0].own;p.coverage='partial';p.omittedProviders=1;p.providers[0].windows.m20={kind:'floor',amount:1e-20};for(const w of ['m20','h24','d7','lifetime'])p.windows[w]=p.scores[w]={kind:'floor',amount:0};}],
  ['omitted subtotal',f=>{const p=f.rows[0].own;p.coverage='partial';p.omittedProviders=1;p.providers[0].windows.m20={kind:'floor',amount:10};}],
  ['partial exact promotion',f=>{const p=f.rows[0].own;p.coverage='partial';p.omittedProviders=1;}],
  ['partial weighted overflow',f=>{const p=f.rows[0].own;p.coverage='partial';p.omittedProviders=1;p.providers[0].windows.m20={kind:'floor',amount:Number.MAX_VALUE};f.config.value={...structuredClone(DEFAULT_SCORING_CONFIG_V2),providerWeights:{'claude-code':2}};}],
  ['zero rank',f=>{const p=f.rows[0].own;p.windows.m20=p.scores.m20=p.providers[0].windows.m20={kind:'estimate',amount:0};p.dollarRanks.m20=p.scoreRanks.m20=1;}],
  ['unavailable rank',f=>{const p=f.rows[0].own;p.windows.m20=p.scores.m20=p.providers[0].windows.m20={kind:'unavailable',amount:null};p.dollarRanks.m20=p.scoreRanks.m20=1;}],
  ['singleton rank',f=>{f.rows[0].own.dollarRanks.m20=1;}],
  ['empty population rank',f=>{f.population.own.dollars.m20.count=0;}],
  ['unchanged changed content',f=>{f.unchanged=true;f.rows[0].revision='changed';},{ifRevision:'instance:1'}],
  ['uncertain omissions',f=>{f.omittedRows.exact=false;}],
  ['missing fold timestamp',f=>{f.asOf=f.rankAsOf=f.rows[0].asOf=1000;f.rows[0].ownLastFoldAt=f.rows[0].familyLastFoldAt=null;}],
 ];
 for(const [name,mutate,input={}] of cases){
  const f=fixture();mutate(f);for(const p of [f.rows[0].own,f.rows[0].family]){for(const provider of p.providers)if(Object.values(provider.windows).some(v=>v.kind==='unavailable'))provider.approximation={approximate:true,reasons:['missing-price']};if(p.providers.some(v=>v.approximation.approximate)||[...Object.values(p.windows),...Object.values(p.scores)].some(v=>v.kind==='unavailable'))p.approximation={approximate:true,reasons:['missing-price']};}expect(()=>validateRecentSnapshot(input,f),name).toThrow();
  const port={capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>f};
  const host=createFakePluginHost({pluginId:'bad-supplier'});registerThreadMetricsOwner(host.bb,port);
  try{const client=createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'bad-supplier');await expect(client.recentSnapshot(input),name).rejects.toThrow();}finally{await host.harness.lifecycle.dispose();}
  const report=await runSupplierConformance({pluginId:'bad-kit',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[{scope:'own',threadIds:['thr_one']}],recentCases:[input]});expect(report.passed,name).toBe(false);expect(report.checks.find(c=>c.name==='recent-0').passed,name).toBe(false);
 }
});

test('partial known dollars remain floors, provenance survives codecs and older ranks cannot heat current zero',async()=>{
 const f=fixture(),p=f.rows[0].own;p.coverage='partial';p.providers[0].windows.m20={kind:'floor',amount:10};p.providers[0].approximation=p.approximation={approximate:true,reasons:['provider-default','model-attribution']};p.windows.m20=p.scores.m20={kind:'floor',amount:10};p.omittedProviders=1;for(const w of ['h24','d7','lifetime'])p.windows[w]=p.scores[w]={kind:'floor',amount:1};
 const decoded=validateRecentSnapshot({},f);expect(decoded.rows[0].own.approximation).toEqual(p.approximation);expect(decoded.rows[0].own.providers[0].approximation).toEqual(p.approximation);
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const host=createFakePluginHost({pluginId:'provenance'});registerThreadMetricsOwner(host.bb,{capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>f});try{const client=createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'provenance');expect((await client.recentSnapshot()).rows[0].own.approximation).toEqual(p.approximation);}finally{await host.harness.lifecycle.dispose();}
 const unavailable={providerId:'codex',windows:Object.fromEntries(['m20','h24','d7','lifetime'].map(w=>[w,{kind:'unavailable',amount:null}])),approximation:{approximate:true,reasons:['missing-price']}};p.providers.push(unavailable);p.approximation.reasons.push('missing-price');for(const w of ['h24','d7','lifetime'])p.windows[w]=p.scores[w]={kind:'floor',amount:1};expect(validateRecentSnapshot({},f).rows[0].own.windows.m20.amount).toBe(10);
 const dropped=structuredClone(f);dropped.rows[0].own.approximation={approximate:true,reasons:['missing-price']};expect(()=>validateRecentSnapshot({},dropped)).toThrow('provenance');
 const stale=fixture();stale.rankAsOf=now-1000;stale.population.own.scores.m20.count=2;stale.rows[0].own.scoreRanks.m20=1;stale.rows[0].own.windows.m20=stale.rows[0].own.scores.m20=stale.rows[0].own.providers[0].windows.m20={kind:'floor',amount:0};expect(validateRecentSnapshot({},stale).rows[0].own.scoreRanks.m20).toBe(1);expect(recentPercentileHeat(stale.rows[0].own)).toBeNull();stale.rows[0].own.windows.m20=stale.rows[0].own.scores.m20=stale.rows[0].own.providers[0].windows.m20={kind:'floor',amount:2};expect(recentPercentileHeat(stale.rows[0].own)).toBe('on-fire');
 expect(validateRecentSnapshot({ifRevision:'r'},{version:1,revision:'r',unchanged:true,futureField:'ok'})).toEqual({version:1,revision:'r',unchanged:true});
 const epoch=fixture();epoch.asOf=epoch.rankAsOf=epoch.rows[0].asOf=0;epoch.rows[0].ownLastFoldAt=0;epoch.rows[0].familyLastFoldAt=null;expect(validateRecentSnapshot({},epoch).rows).toHaveLength(1);
});

test('newer rank epochs reject unavailable/zero values; observational absence is not an invented price gap',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const {runSupplierConformance}=await import('../dist/testing.js');
 async function check(f,accepted){
  if(accepted)expect(validateRecentSnapshot({},f).rows).toHaveLength(1);else expect(()=>validateRecentSnapshot({},f)).toThrow();
  const port={capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>f};const host=createFakePluginHost({pluginId:'epoch-observation'});registerThreadMetricsOwner(host.bb,port);
  try{const client=createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'epoch-observation');if(accepted){const result=await client.recentSnapshot();expect(result.rows[0].own.approximation.reasons).not.toContain('missing-price');expect(result.rows[0].family.windows.m20.amount).toBe(10);}else await expect(client.recentSnapshot()).rejects.toThrow();}finally{await host.harness.lifecycle.dispose();}
  const report=await runSupplierConformance({pluginId:'epoch-observation-kit',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[{scope:'own',threadIds:['thr_one']}],recentCases:[{}]});expect(report.passed).toBe(accepted);
 }
 for(const kind of ['estimate','unavailable']){const f=fixture(),p=f.rows[0].own;f.rows[0].asOf=now-1000;for(const type of ['dollars','scores'])f.population.own[type].m20.count=2;p.dollarRanks.m20=p.scoreRanks.m20=1;p.windows.m20=p.scores.m20=p.providers[0].windows.m20={kind,amount:kind==='unavailable'?null:0};if(kind==='unavailable')p.approximation=p.providers[0].approximation={approximate:true,reasons:['missing-price']};await check(f,false);}
 const root=fixture(),own=root.rows[0].own,family=root.rows[0].family;root.rows[0].ownLastFoldAt=null;own.memberCount=0;own.coverage='partial';own.coverageReasons=['root-unattested','source-gap'];own.approximation={approximate:true,reasons:['source-gap']};own.providers=[];for(const w of ['m20','h24','d7','lifetime'])own.windows[w]=own.scores[w]={kind:'unavailable',amount:null};for(const w of ['m20','h24','d7'])own.dollarRanks[w]=own.scoreRanks[w]=null;family.coverage='partial';family.coverageReasons=['source-gap'];family.approximation=family.providers[0].approximation={approximate:true,reasons:['source-gap']};for(const w of ['m20','h24','d7','lifetime'])family.windows[w]=family.scores[w]=family.providers[0].windows[w]={kind:'floor',amount:10};await check(root,true);
 const unpriced=structuredClone(root);unpriced.rows[0].own.coverageReasons.push('unpriced');await check(unpriced,false);
});

test('partial provider subtotal admits machine rounding without erasing tiny supported floors',()=>{
 const f=fixture(),p=f.rows[0].own;p.coverage='partial';p.omittedProviders=1;p.providers[0].windows=Object.fromEntries(['m20','h24','d7','lifetime'].map(w=>[w,{kind:'floor',amount:.1}]));p.providers.push({...structuredClone(p.providers[0]),providerId:'codex',windows:Object.fromEntries(['m20','h24','d7','lifetime'].map(w=>[w,{kind:'floor',amount:.2}]))});for(const w of ['m20','h24','d7','lifetime'])p.windows[w]=p.scores[w]={kind:'floor',amount:.3};expect(validateRecentSnapshot({},f).rows[0].own.windows.m20.amount).toBe(.3);p.windows.m20={kind:'floor',amount:.29};expect(()=>validateRecentSnapshot({},f)).toThrow('subtotal');
});

test('explicit unpriced coverage retains missing-price even when supported totals remain available floors',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const {runSupplierConformance}=await import('../dist/testing.js');
 const f=fixture(),p=f.rows[0].own;p.coverage='partial';p.coverageReasons=['unpriced'];p.omittedProviders=1;for(const w of ['m20','h24','d7','lifetime'])p.windows[w]=p.scores[w]={kind:'floor',amount:1};
 for(const accepted of [false,true]){
  if(accepted)p.approximation={approximate:true,reasons:['missing-price']};
  if(accepted)expect(validateRecentSnapshot({},f).rows[0].own.windows.m20).toEqual({kind:'floor',amount:1});else expect(()=>validateRecentSnapshot({},f)).toThrow('missing-price');
  const port={capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>f},host=createFakePluginHost({pluginId:'unpriced-floor'});registerThreadMetricsOwner(host.bb,port);
  try{const client=createThreadMetricsClient({plugins:{list:async()=>({plugins:[]}),callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'unpriced-floor');if(accepted)expect((await client.recentSnapshot()).rows[0].own.approximation).toEqual(p.approximation);else await expect(client.recentSnapshot()).rejects.toThrow('missing-price');}finally{await host.harness.lifecycle.dispose();}
  const report=await runSupplierConformance({pluginId:'unpriced-floor-kit',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[{scope:'own',threadIds:['thr_one']}],recentCases:[{}]});expect(report.passed).toBe(accepted);
 }
});
