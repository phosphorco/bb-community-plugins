import {test,expect} from 'bun:test';
import {DEFAULT_SCORING_CONFIG_V3,DEFAULT_SCORING_CONFIG_V2,ROOT_FAMILY_HEAT_DOMAIN_V1,rootFamilyEligibilityV1,rootFamilyHeatV1,validateRecentSnapshot,scoringConfigV3Schema,RECENT_LIMITS} from '../dist/index.js';
const now=1800000000000,keys=['m20','h24','d7'],root={kind:'attested',parentThreadId:null,lifecycleOwnerThreadId:null,deleted:false};
const pop=()=>Object.fromEntries(keys.map(w=>[w,{count:10,coverage:'complete',reasons:[]}]));
function context(){return {version:1,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,contextRevision:'ctx:1',configRevision:'cfg:1',topologyRevision:'top:1',rankRevision:'rank:1',rankAsOf:now,windows:Object.fromEntries(keys.map((w,i)=>[w,{start:now-[1200000,86400000,604800000][i],end:now}])),population:{dollars:pop(),scores:pop()}};}
const windows=n=>Object.fromEntries([...keys,'lifetime'].map(w=>[w,{kind:'estimate',amount:n}]));
const family=(n=1,r=1)=>({contextRevision:'ctx:1',configRevision:'cfg:1',scores:windows(n),rootScoreRanks:Object.fromEntries(keys.map(w=>[w,r]))});
const decide=(topology=root,config=DEFAULT_SCORING_CONFIG_V3,ctx=context(),value=family())=>rootFamilyHeatV1({topology,config,context:ctx,family:value});
function scope(n,r){return {memberCount:1,coverage:'complete',coverageReasons:[],priceVersion:'rates:1',approximation:{approximate:false,reasons:[]},windows:windows(n),scores:windows(n),providers:[{providerId:'codex',windows:windows(n),approximation:{approximate:false,reasons:[]}}],omittedProviders:0,dollarRanks:Object.fromEntries(keys.map(w=>[w,r])),scoreRanks:Object.fromEntries(keys.map(w=>[w,r]))};}
function snapshot(config=DEFAULT_SCORING_CONFIG_V3){const ctx=context();return {version:1,revision:'snapshot:1',unchanged:false,currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:now,rankAsOf:now,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'cfg:1',value:config},coverage:'complete',coverageReasons:[],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:pop(),scores:pop()},family:{dollars:pop(),scores:pop()}},heat:ctx,rows:Array.from({length:10},(_,i)=>{const n=i+1,r=i/9;return {threadId:'root-'+String(n).padStart(2,'0'),revision:'row:1',configRevision:'cfg:1',asOf:now,ownLastFoldAt:now,familyLastFoldAt:now,own:scope(n,r),family:scope(n,r),heat:{topology:{...root},rootDollarRanks:Object.fromEntries(keys.map(w=>[w,r])),rootScoreRanks:Object.fromEntries(keys.map(w=>[w,r])),decisions:decide(root,config.schemaVersion===3?config:DEFAULT_SCORING_CONFIG_V3,ctx,family(n,r))}};})};}
test('new default and domain are explicit, immutable and distinct from legacy default',()=>{
 expect(DEFAULT_SCORING_CONFIG_V3.gates).toEqual({m20:.9,h24:.8,d7:.8});expect(DEFAULT_SCORING_CONFIG_V3.providerWeights).toEqual({});expect(Object.isFrozen(DEFAULT_SCORING_CONFIG_V3.gates)).toBe(true);expect(Object.isFrozen(DEFAULT_SCORING_CONFIG_V3.domain)).toBe(true);
 expect(DEFAULT_SCORING_CONFIG_V2.gates.h24).toBe(.9);
 for(const domain of [undefined,{version:2,kind:'root-family'},{version:1,kind:'own'}])expect(scoringConfigV3Schema.safeParse({...DEFAULT_SCORING_CONFIG_V3,domain}).success).toBe(false);
});
test('topology requires both attested nulls; hidden/archive metadata cannot exclude roots',()=>{
 expect(rootFamilyEligibilityV1({...root,hidden:true,archived:true})).toBe('eligible-root');
 for(const child of [{...root,parentThreadId:'p'},{...root,lifecycleOwnerThreadId:'p'},{...root,parentThreadId:'p',lifecycleOwnerThreadId:'q'}])expect(rootFamilyEligibilityV1(child)).toBe('ineligible-child');
 expect(rootFamilyEligibilityV1({...root,deleted:true})).toBe('deleted');expect(rootFamilyEligibilityV1({kind:'unknown',reasons:['source-gap']})).toBe('unknown');
 const {parentThreadId,...missing}=root;expect(()=>rootFamilyEligibilityV1(missing)).toThrow();
});
test('all three decisions survive one-winner precedence; default counts are90/80/80',()=>{
 const s=validateRecentSnapshot({},snapshot()),decisions=s.rows.map(r=>r.heat.decisions);
 expect(keys.map(w=>decisions.filter(d=>d.signals[w].decision==='qualifies').length)).toEqual([1,2,2]);
 expect(['on-fire','hot','heavy'].map(w=>decisions.filter(d=>d.winner===w).length)).toEqual([1,1,0]);
 expect(Object.values(decisions.at(-1).signals).every(d=>d.decision==='qualifies')).toBe(true);
 const d=decide();expect(d.winner).toBe('on-fire');expect(d.contextRevision).toBe('ctx:1');
 const h=decide(root,DEFAULT_SCORING_CONFIG_V3,context(),{...family(),rootScoreRanks:{m20:0,h24:1,d7:1}});expect(h.winner).toBe('hot');expect(h.signals.d7.decision).toBe('qualifies');
 expect(decide(root,DEFAULT_SCORING_CONFIG_V3,context(),{...family(),rootScoreRanks:{m20:0,h24:0,d7:1}}).winner).toBe('heavy');
});
test('singleton gate0/empty suppressed, absolute positive singleton allowed, no lifetime fourth signal',()=>{
 const c={...DEFAULT_SCORING_CONFIG_V3,gates:{m20:0,h24:0,d7:0}},ctx=context(),v=family(1,0);
 for(const n of [0,1]){for(const axis of ['dollars','scores'])for(const w of keys)ctx.population[axis][w].count=n;const val=n?v:{...v,rootScoreRanks:{m20:null,h24:null,d7:null}};expect(decide(root,c,ctx,val).winner).toBeNull();}
 const abs={schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'absolute',providerWeights:{},thresholds:{m20:1,h24:1,d7:1,lifetime:0},lifetimeEnabled:false};
 expect(decide(root,abs,ctx,v).winner).toBe('on-fire');expect(decide(root,abs,ctx,{...v,scores:windows(0)}).winner).toBeNull();
 expect(scoringConfigV3Schema.safeParse({...abs,lifetimeEnabled:true}).success).toBe(false);
 const onlyLifetime={...v,scores:{...windows(0),lifetime:{kind:'estimate',amount:1e6}}};expect(decide(root,abs,ctx,onlyLifetime).winner).toBeNull();
});
test('children, unknown and deleted never root heat in either mode; missing context is rejected',()=>{
 const abs={schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'absolute',providerWeights:{},thresholds:{m20:0,h24:0,d7:0,lifetime:0}};
 for(const cfg of [DEFAULT_SCORING_CONFIG_V3,abs])for(const topology of [{...root,parentThreadId:'p'},{...root,lifecycleOwnerThreadId:'p'},{...root,deleted:true},{kind:'unknown',reasons:['root-unattested']}]){
  const d=decide(topology,cfg);expect(d.winner).toBeNull();expect(Object.values(d.signals).every(d=>d.decision!=='qualifies')).toBe(true);
 }
 expect(()=>rootFamilyHeatV1({topology:root,config:DEFAULT_SCORING_CONFIG_V3,family:family()})).toThrow();
 const ctx=context();ctx.configRevision='foreign';expect(()=>decide(root,DEFAULT_SCORING_CONFIG_V3,ctx)).toThrow('mismatch');
});
test('codec rejects malformed domain/context/rank/three-decision publications and accounts additive bytes',()=>{
 for(const mutate of [s=>delete s.heat,s=>s.heat.configRevision='foreign',s=>s.heat.rankAsOf++,s=>s.heat.windows.d7.start-=1,s=>s.rows[9].heat.decisions.signals.d7.decision='below',s=>s.rows[9].heat.decisions.winner='hot',s=>s.rows[9].heat.decisions.contextRevision='other',s=>s.rows[9].heat.topology.lifecycleOwnerThreadId='parent',s=>s.heat.population.scores.d7.count=1]){const s=snapshot();mutate(s);expect(()=>validateRecentSnapshot({},s)).toThrow();}
 const tooLarge=snapshot();tooLarge.rows[0].heat.extra='x'.repeat(8192);expect(()=>validateRecentSnapshot({},tooLarge)).toThrow('row byte');
 const legacy=snapshot(DEFAULT_SCORING_CONFIG_V2);delete legacy.heat;for(const r of legacy.rows)delete r.heat;expect(validateRecentSnapshot({},legacy).heat).toBeUndefined();
 for(const cfg of [DEFAULT_SCORING_CONFIG_V3,{schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'absolute',providerWeights:{},thresholds:{m20:0,h24:0,d7:0,lifetime:0}}]){
  const s=snapshot(cfg),r=s.rows[9];r.heat.topology={...root,lifecycleOwnerThreadId:'parent'};r.heat.rootDollarRanks=r.heat.rootScoreRanks={m20:null,h24:null,d7:null};r.heat.decisions=decide(r.heat.topology,cfg,s.heat,{...family(10,null)});expect(validateRecentSnapshot({},s).rows[9].heat.decisions.winner).toBeNull();
 }
});
test('root decisions round-trip through real owner/client and supplier conformance without changing readV1',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');const {runSupplierConformance}=await import('../dist/testing.js');
 const port={capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>snapshot()};const host=createFakePluginHost({pluginId:'root-fixture'});registerThreadMetricsOwner(host.bb,port);
 try{const client=createThreadMetricsClient({plugins:{callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'root-fixture');const result=await client.recentSnapshot({});expect(result.rows[9].heat.decisions).toEqual(snapshot().rows[9].heat.decisions);expect((await client.read({threadIds:['root-01'],scope:'own'})).rows).toEqual([]);}finally{await host.harness.lifecycle.dispose();}
 const report=await runSupplierConformance({pluginId:'root-kit',register:bb=>registerThreadMetricsOwner(bb,port),readCases:[{scope:'own',threadIds:['root-01']}],recentCases:[{}]});expect(report.passed).toBe(true);
 const invalid={...port,recentSnapshot:async()=>{const s=snapshot();s.rows[9].heat.decisions.signals.h24.decision='below';return s;}};
 const bad=await runSupplierConformance({pluginId:'bad-root-kit',register:bb=>registerThreadMetricsOwner(bb,invalid),readCases:[{scope:'own',threadIds:['root-01']}],recentCases:[{}]});expect(bad.checks.find(c=>c.name==='recent-0').passed).toBe(false);
});

test('a complete current root population cannot undercount supported displayed members even with null ranks',()=>{
 const config={schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'absolute',providerWeights:{},thresholds:{m20:1,h24:1,d7:1,lifetime:0}},s=snapshot(config);s.heat.population.scores.d7.count=0;
 for(const row of s.rows){row.heat.rootScoreRanks.d7=null;row.heat.decisions=decide(root,config,s.heat,{...family(row.family.scores.h24.amount),rootScoreRanks:row.heat.rootScoreRanks});}
 expect(()=>validateRecentSnapshot({},s)).toThrow('population below');
});


test('current partial projections cannot carry authoritative complete ranks; retained older epochs stay qualified',()=>{
 const s=snapshot(),row=s.rows[9];row.family.coverage='partial';row.family.coverageReasons=['population-incomplete'];row.family.omittedProviders=1;
 for(const w of [...keys,'lifetime']){row.family.windows[w]={kind:'floor',amount:10};row.family.scores[w]={kind:'floor',amount:10};}
 expect(()=>validateRecentSnapshot({},s)).toThrow('complete root rank');
 for(const axis of ['dollars','scores'])for(const w of keys){s.heat.population[axis][w].coverage='partial';s.heat.population[axis][w].reasons=['population-incomplete'];}
 expect(validateRecentSnapshot({},s).rows[9].heat.decisions.winner).toBe('on-fire');
 for(const axis of ['dollars','scores'])for(const w of keys){s.heat.population[axis][w].coverage='complete';s.heat.population[axis][w].reasons=[];}
 s.rankAsOf=s.heat.rankAsOf=now-1000;for(const w of keys){s.heat.windows[w].start-=1000;s.heat.windows[w].end-=1000;}
 expect(validateRecentSnapshot({},s).rows[9].heat.decisions.winner).toBe('on-fire');
});

const absolutePolicy={schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'absolute',providerWeights:{},thresholds:{m20:7,h24:7,d7:7,lifetime:0}};
function refreshDecisions(s){for(const r of s.rows)r.heat.decisions=decide(r.heat.topology,s.config.value,s.heat,{contextRevision:s.heat.contextRevision,configRevision:r.configRevision,scores:r.family.scores,rootScoreRanks:r.heat.rootScoreRanks});return s;}
async function policyOwner(s){
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');
 const host=createFakePluginHost({pluginId:'policy-root'});registerThreadMetricsOwner(host.bb,{capabilities:{summary:true,series:false,detail:false,recentSnapshotV1:true},read:async()=>({version:1,rows:[]}),recentSnapshot:async()=>s});
 try{return await createThreadMetricsClient({plugins:{callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'policy-root').recentSnapshot({});}finally{await host.harness.lifecycle.dispose();}
}
function floorSnapshot(){
 const s=snapshot(absolutePolicy);s.rows=s.rows.slice(-1);const r=s.rows[0];r.family.coverage='partial';r.family.coverageReasons=['population-incomplete'];
 for(const w of [...keys,'lifetime'])for(const values of [r.family.windows,r.family.scores,r.family.providers[0].windows])values[w]={kind:'floor',amount:5};
 for(const w of keys){r.heat.rootDollarRanks[w]=r.heat.rootScoreRanks[w]=r.family.dollarRanks[w]=r.family.scoreRanks[w]=null;for(const axis of ['dollars','scores'])s.heat.population[axis][w]={count:1,coverage:'partial',reasons:['population-incomplete']};}
 return refreshDecisions(s);
}
test('absolute lower bounds below a threshold are indeterminate through helper and public transport',async()=>{
 const s=floorSnapshot(),published=await policyOwner(s);expect(Object.values(published.rows[0].heat.decisions.signals).map(v=>v.decision)).toEqual(['unavailable','unavailable','unavailable']);expect(published.rows[0].heat.decisions.winner).toBeNull();
 const scores={...windows(5),m20:{kind:'floor',amount:5},h24:{kind:'floor',amount:7},d7:{kind:'floor',amount:8}};
 const d=decide(root,absolutePolicy,s.heat,{...family(),scores,rootScoreRanks:{m20:null,h24:null,d7:null}});expect(keys.map(w=>d.signals[w].decision)).toEqual(['unavailable','qualifies','qualifies']);expect(d.winner).toBe('hot');
 scores.h24={kind:'estimate',amount:5};expect(decide(root,absolutePolicy,s.heat,{...family(),scores,rootScoreRanks:{m20:null,h24:null,d7:null}}).winner).toBe('heavy');
 const zero=decide(root,absolutePolicy,s.heat,{...family(),scores:Object.fromEntries([...keys,'lifetime'].map(w=>[w,{kind:'floor',amount:0}])),rootScoreRanks:{m20:null,h24:null,d7:null}});expect(zero.signals.m20.decision).toBe('unavailable');
 expect(decide(root,absolutePolicy,s.heat,{...family(),scores:windows(5),rootScoreRanks:{m20:null,h24:null,d7:null}}).signals.m20.decision).toBe('below');
});
test('positive floor membership constrains each complete current cohort independently of null ranks',async()=>{
 for(const axis of ['dollars','scores'])for(const w of keys){const s=floorSnapshot();s.heat.population[axis][w]={count:0,coverage:'complete',reasons:[]};expect(()=>validateRecentSnapshot({},s)).toThrow('population below');await expect(policyOwner(s)).rejects.toThrow('population below');}
 const truthful=floorSnapshot();for(const axis of ['dollars','scores'])for(const w of keys)truthful.heat.population[axis][w]={count:1,coverage:'complete',reasons:[]};expect((await policyOwner(truthful)).rows[0].heat.rootScoreRanks.m20).toBeNull();
 const partial=floorSnapshot();for(const axis of ['dollars','scores'])for(const w of keys)partial.heat.population[axis][w].count=0;expect((await policyOwner(partial)).rows[0].family.scores.m20.kind).toBe('floor');
 const older=floorSnapshot();older.rankAsOf=older.heat.rankAsOf=now-1000;for(const w of keys){older.heat.windows[w].start-=1000;older.heat.windows[w].end-=1000;for(const axis of ['dollars','scores'])older.heat.population[axis][w]={count:0,coverage:'complete',reasons:[]};}expect((await policyOwner(older)).rankAsOf).toBe(now-1000);
});
test('fixed context windows reject shortened starts/ends but retain exact clipped and older epochs',async()=>{
 for(const w of keys)for(const endpoint of ['start','end']){const s=snapshot();s.heat.windows[w][endpoint]+=endpoint==='start'?1:-1;expect(()=>validateRecentSnapshot({},s)).toThrow('window provenance');await expect(policyOwner(s)).rejects.toThrow('window provenance');}
 for(const epoch of [0,1,1200000,86400000,604800000,now-1000]){const s=snapshot();s.rankAsOf=s.heat.rankAsOf=epoch;keys.forEach((w,i)=>s.heat.windows[w]={start:Math.max(0,epoch-[1200000,86400000,604800000][i]),end:epoch});expect((await policyOwner(s)).heat.rankAsOf).toBe(epoch);}
});
test('complete root rank grids validate both axes without population reconstruction, allowing precision/ties/partial/older',async()=>{
 const pair=()=>{const s=snapshot();s.rows=s.rows.slice(0,2);for(const axis of ['dollars','scores'])for(const w of keys)s.heat.population[axis][w].count=2;for(let i=0;i<2;i++)for(const ranks of [s.rows[i].heat.rootDollarRanks,s.rows[i].heat.rootScoreRanks])for(const w of keys)ranks[w]=i;return refreshDecisions(s);};
 for(const field of ['rootDollarRanks','rootScoreRanks']){const s=pair();s.rows[0].heat[field].h24=.8;refreshDecisions(s);expect(()=>validateRecentSnapshot({},s)).toThrow('first-index grid');await expect(policyOwner(s)).rejects.toThrow('first-index grid');}
 const tied=pair();tied.rows[1].family=structuredClone(tied.rows[0].family);tied.rows[1].heat.rootDollarRanks=tied.rows[1].heat.rootScoreRanks={m20:0,h24:0,d7:0};refreshDecisions(tied);expect((await policyOwner(tied)).rows[1].heat.rootScoreRanks.h24).toBe(0);
 const precise=snapshot();for(const ranks of [precise.rows[3].heat.rootDollarRanks,precise.rows[3].heat.rootScoreRanks])ranks.h24=1/3+Number.EPSILON/4;refreshDecisions(precise);expect((await policyOwner(precise)).rows.length).toBe(10);
 const offGrid=snapshot();offGrid.rows[3].heat.rootDollarRanks.h24=1/3+1e-12;expect(()=>validateRecentSnapshot({},offGrid)).toThrow('first-index grid');
 const partial=pair();partial.rows[0].heat.rootScoreRanks.h24=.8;partial.heat.population.scores.h24.coverage='partial';partial.heat.population.scores.h24.reasons=['population-incomplete'];refreshDecisions(partial);expect((await policyOwner(partial)).rows[0].heat.rootScoreRanks.h24).toBe(.8);
 const older=pair();older.rankAsOf=older.heat.rankAsOf=now-1000;for(const w of keys){older.heat.windows[w].start-=1000;older.heat.windows[w].end-=1000;}expect((await policyOwner(older)).rows[1].heat.rootScoreRanks.h24).toBe(1);older.rows[0].heat.rootDollarRanks.h24=.8;await expect(policyOwner(older)).rejects.toThrow('first-index grid');
});
