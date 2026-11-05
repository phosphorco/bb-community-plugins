import {test,expect} from 'bun:test';
import {DEFAULT_SCORING_CONFIG_V3,rootFamilyHeatV1,validateRecentSnapshot,RECENT_LIMITS} from '../dist/index.js';
const T=1800000000000,keys=['m20','h24','d7'],all=[...keys,'lifetime'];
const vals=n=>Object.fromEntries(all.map(w=>[w,{kind:'estimate',amount:n}])),rs=n=>Object.fromEntries(keys.map(w=>[w,n]));
const topology={kind:'attested',parentThreadId:null,lifecycleOwnerThreadId:null,deleted:false};
const pop=(n=2,coverage='complete')=>Object.fromEntries(keys.map(w=>[w,{count:n,coverage,reasons:[]}]));
function scope(n){return {memberCount:1,coverage:'complete',coverageReasons:[],priceVersion:'prices:1',approximation:{approximate:false,reasons:[]},windows:vals(n),scores:vals(n),providers:[{providerId:'codex',windows:vals(n),approximation:{approximate:false,reasons:[]}}],omittedProviders:0,dollarRanks:rs(null),scoreRanks:rs(null),attribution:{unknownProvider:vals(0),attributionComplete:Object.fromEntries(all.map(w=>[w,true])),unpriced:Object.fromEntries(all.map(w=>[w,false]))}};}
function fixture(){
 const context={version:1,domain:{version:1,kind:'root-family'},contextRevision:'ctx:1',configRevision:'cfg:1',topologyRevision:'top:1',rankRevision:'r:1',rankAsOf:T,windows:Object.fromEntries(keys.map((w,i)=>[w,{start:T-[1200000,86400000,604800000][i],end:T}])),population:{dollars:pop(),scores:pop()}};
 const heat=(family,r)=>({topology,rootDollarRanks:rs(r),rootScoreRanks:rs(r),decisions:rootFamilyHeatV1({topology,family:{contextRevision:context.contextRevision,configRevision:'cfg:1',scores:family.scores,rootScoreRanks:rs(r)},context,config:DEFAULT_SCORING_CONFIG_V3})});
 const inputs=[1,2].map((n,i)=>{const family=scope(n);return {threadId:'root'+n,asOf:T,configRevision:'cfg:1',presentation:{title:'Root '+n,navigation:{kind:'project',projectId:'p1'}},family,heat:heat(family,i)};});
 return {version:1,revision:'pub:1',unchanged:false,currency:'USD',estimated:true,cutoffLastFoldAt:null,asOf:T,rankAsOf:T,recentWindowMs:RECENT_LIMITS.windowMs,config:{revision:'cfg:1',value:DEFAULT_SCORING_CONFIG_V3},heat:context,coverage:'complete',coverageReasons:[],materializationPending:0,omittedRows:{count:0,exact:true},population:{own:{dollars:pop(0,'unknown'),scores:pop(0,'unknown')},family:{dollars:pop(0,'unknown'),scores:pop(0,'unknown')}},rows:[],heatInputs:{contextRevision:'ctx:1',topologyRevision:'top:1',cohortComplete:true,pending:0,omitted:{count:0,exact:true},rows:inputs}};
}
test('unique all-window root inputs need no72h activity and preserve complete counts/ranks and provider attribution',()=>{
 const value=validateRecentSnapshot({},fixture());expect(value.rows).toEqual([]);expect(value.heatInputs.rows.map(r=>r.family.providers[0].windows.d7.amount)).toEqual([1,2]);expect(value.heatInputs.rows[1].heat.rootScoreRanks).toEqual(rs(1));
});
test('newer sidebar row does not replace or require false equality with captured root inputs',()=>{
 const value=fixture(),part=value.heatInputs.rows[0],family=scope(9);value.asOf=T+1000;const heat={...part.heat,rootDollarRanks:rs(null),rootScoreRanks:rs(null),decisions:rootFamilyHeatV1({topology,family:{contextRevision:'ctx:1',configRevision:'cfg:1',scores:family.scores,rootScoreRanks:rs(null)},context:value.heat,config:DEFAULT_SCORING_CONFIG_V3})};
 value.rows=[{threadId:'root1',revision:'row:new',asOf:T+1000,configRevision:'cfg:1',ownLastFoldAt:T+1000,familyLastFoldAt:T+1000,own:scope(9),family,heat}];const result=validateRecentSnapshot({},value);expect(result.rows[0].family.windows.d7.amount).toBe(9);expect(result.heatInputs.rows[0].family.windows.d7.amount).toBe(1);
});
test('complete input attestation reconciles capture, topology, exact cohort counts and actual first-tie order',()=>{
 const mutate=[v=>v.heatInputs.rows.pop(),v=>v.heatInputs.rows[0].asOf++,v=>v.heatInputs.pending++,v=>v.heatInputs.omitted.exact=false,v=>{const row=v.heatInputs.rows[0];row.heat.rootScoreRanks.d7=1;row.heat.decisions=rootFamilyHeatV1({topology:row.heat.topology,family:{contextRevision:'ctx:1',configRevision:'cfg:1',scores:row.family.scores,rootScoreRanks:row.heat.rootScoreRanks},context:v.heat,config:v.config.value});},v=>v.heatInputs.rows[0].heat.topology={...topology,parentThreadId:'parent'},v=>{v.heat.population.scores.d7={count:3,coverage:'partial',reasons:['population-incomplete']};}];
 for(const change of mutate){const bad=fixture();change(bad);expect(()=>validateRecentSnapshot({},bad)).toThrow();}
 const partial=fixture();partial.heatInputs.rows.pop();partial.heatInputs.cohortComplete=false;partial.heatInputs.omitted.count=1;expect(()=>validateRecentSnapshot({},partial)).toThrow(/partial snapshot/);partial.coverage='partial';expect(validateRecentSnapshot({},partial).heatInputs.rows).toHaveLength(1);
});
test('unknown remainder cannot silently become a weight1 provider or a complete price attestation',()=>{
 for(const change of [s=>s.attribution.attributionComplete.d7=false,s=>s.attribution.unpriced.d7=true,s=>s.attribution.unknownProvider.d7={kind:'floor',amount:2}]){const value=fixture();change(value.heatInputs.rows[0].family);expect(()=>validateRecentSnapshot({},value)).toThrow();}
});
test('physical display and captured entries share1000/4MiB/8KiB limits BEFORE additive output stripping',()=>{
 const value=fixture();value.heatInputs.rows=Array.from({length:1001},()=>value.heatInputs.rows[0]);expect(()=>validateRecentSnapshot({},value)).toThrow(/aggregate row/);
 const extra=fixture();extra.heatInputs.rows[0].additive='x'.repeat(8192);expect(()=>validateRecentSnapshot({},extra)).toThrow(/row byte/);
 const modest=fixture();modest.heatInputs.rows[0].additive='allowed';expect(validateRecentSnapshot({},modest).heatInputs.rows[0].additive).toBeUndefined();
});


test('full publication identity is additive bounded data and never accepted on unchanged responses',()=>{
 const legacy=fixture();expect(validateRecentSnapshot({},legacy).publication).toBeUndefined();
 const value=fixture();value.publication={instance:'opaque-writer',sequence:1,additive:'stripped'};expect(validateRecentSnapshot({},value).publication).toEqual({instance:'opaque-writer',sequence:1});
 for(const publication of [null,{}, {instance:'',sequence:1},{instance:'x'.repeat(129),sequence:1},{instance:'writer',sequence:0},{instance:'writer',sequence:-1},{instance:'writer',sequence:1.5},{instance:'writer',sequence:Number.MAX_SAFE_INTEGER+1},{instance:'writer',sequence:'1'}]){
  const bad=fixture();bad.publication=publication;expect(()=>validateRecentSnapshot({},bad)).toThrow();
 }
 value.publication={instance:'not-parsed-as-a-UUID:opaque',sequence:Number.MAX_SAFE_INTEGER};expect(validateRecentSnapshot({},value).publication.sequence).toBe(Number.MAX_SAFE_INTEGER);
 expect(()=>validateRecentSnapshot({ifRevision:'pub:1'},{version:1,unchanged:true,revision:'pub:1',publication:{instance:'writer',sequence:1}})).toThrow(/recognized full content/);
 expect(validateRecentSnapshot({ifRevision:'pub:1'},{version:1,unchanged:true,revision:'pub:1'})).toEqual({version:1,unchanged:true,revision:'pub:1'});
});
