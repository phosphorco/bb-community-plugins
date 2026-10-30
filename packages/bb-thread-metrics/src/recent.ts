import { z } from 'zod';
import { UsageVectorSchema } from '@phosphorco/bb-usage-algebra/vector';
/** Data-only0.2 prototype. Byte bounds apply to canonical JSON AFTER transport parsing. */
export const RECENT_LIMITS=Object.freeze({rows:1000,bytes:4*1024*1024,rowBytes:8*1024,inputBytes:1024,providers:32,windowMs:3*24*60*60*1000});
const id=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const revision=z.string().min(1).max(256);
const time=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const coverage=z.enum(['complete','partial','unknown']);
const rank=z.number().finite().min(0).max(1).nullable();
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const windowShape=<T extends z.ZodType>(value:T)=>z.object({m20:value,h24:value,d7:value,lifetime:value}).strip();
const reason=z.string().min(1).max(64);
const reasons=z.array(reason).max(16);
/** An explicit floor zero is a supplier attestation; clients never infer it from omission. */
export const recentDollarSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('estimate'),amount:z.number().finite().nonnegative()}).strip(),
 z.object({kind:z.literal('floor'),amount:z.number().finite().nonnegative()}).strip(),
 z.object({kind:z.literal('unavailable'),amount:z.null()}).strip(),
]);
export const recentWindowsSchema=windowShape(recentDollarSchema);
const flags=windowShape(z.boolean());
/** Provider identity completeness is distinct from price/observation coverage.
 * Unknown remainder is a reconciliation amount, NEVER a weight-1 provider. */
export const recentAttributionSchema=z.object({unknownProvider:recentWindowsSchema,attributionComplete:flags,unpriced:flags}).strip();
export const recentPresentationSchema=z.object({title:z.string().trim().min(1).max(512).nullable(),navigation:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('personal')}).strip(),z.object({kind:z.literal('project'),projectId:id}).strip(),
]).nullable()}).strip();
export type RecentPresentation=z.infer<typeof recentPresentationSchema>;
/** Compact pricing/model provenance is independent of observation completeness.
 * Per-model rate associations remain available through readV1/detail. */
export const recentApproximationSchema=z.object({approximate:z.boolean(),reasons:z.array(z.enum(['closest-model','provider-default','model-attribution','bucket-boundary','missing-price','source-gap'])).max(6)}).strip().superRefine((v,c)=>{if(!v.approximate&&v.reasons.length)c.addIssue({code:'custom',message:'Approximation reasons require approximate flag'});});
const provider=z.object({providerId:id,windows:recentWindowsSchema,approximation:recentApproximationSchema}).strip();
/** Token observations are independent of prices. Positive unpriced tokens
 * remain supported floors; absence/legacy unknown never becomes zero. */
export const recentTokenValueSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('estimate'),value:UsageVectorSchema}).strip(),
 z.object({kind:z.literal('floor'),value:UsageVectorSchema}).strip(),
 z.object({kind:z.literal('unavailable'),value:z.null()}).strip(),
]);
export const recentTokenWindowsSchema=windowShape(recentTokenValueSchema);
export const recentUsageSchema=z.object({
 windows:recentTokenWindowsSchema,
 providers:z.array(z.object({providerId:id,windows:recentTokenWindowsSchema}).strip()).max(RECENT_LIMITS.providers),
 omittedProviders:count,descendants:z.object({count,exact:z.boolean()}).strip(),
}).strip();
export type RecentTokenValue=z.infer<typeof recentTokenValueSchema>;
export type RecentUsage=z.infer<typeof recentUsageSchema>;
export const recentScopeSchema=z.object({
 memberCount:count,coverage,coverageReasons:reasons,priceVersion:revision,approximation:recentApproximationSchema,
 usage:recentUsageSchema.optional(),
 attribution:recentAttributionSchema.optional(),
 windows:recentWindowsSchema,scores:recentWindowsSchema,providers:z.array(provider).max(RECENT_LIMITS.providers),omittedProviders:count,
 dollarRanks:z.object({m20:rank,h24:rank,d7:rank}).strip(),scoreRanks:z.object({m20:rank,h24:rank,d7:rank}).strip(),
}).strip().superRefine((v,c)=>{if(new Set(v.providers.map(x=>x.providerId)).size!==v.providers.length)c.addIssue({code:'custom',message:'Duplicate providers'});if(v.omittedProviders&&v.coverage==='complete')c.addIssue({code:'custom',message:'Omitted providers require partial coverage'});
 if(v.usage){
  const u=v.usage,fail=(message:string)=>c.addIssue({code:'custom',path:['usage'],message});
  const providers=new Set(v.providers.map(p=>p.providerId));
  if(u.providers.length!==providers.size||new Set(u.providers.map(p=>p.providerId)).size!==u.providers.length||u.providers.some(p=>!providers.has(p.providerId))||u.omittedProviders!==v.omittedProviders)fail('Token provider attribution mismatch');
  if(u.descendants.count!==Math.max(0,v.memberCount-1))fail('Descendant/member count mismatch');
  if(u.descendants.exact&&v.coverageReasons.some(reason=>['member-cap','depth-cap','edge-cap'].includes(reason)))fail('Membership caps cannot carry an exact descendant count');
  const near=(a:number,b:number)=>Math.abs(a-b)<=4*Number.EPSILON*Math.max(a,b);
  for(const w of ['m20','h24','d7','lifetime'] as const){
   const total=u.windows[w],known=u.providers.filter(p=>p.windows[w].value!==null),all=!u.omittedProviders&&known.length===u.providers.length;
   if(total.kind==='estimate'&&(u.omittedProviders>0||u.providers.some(p=>p.windows[w].kind!=='estimate')))fail('Incomplete provider tokens cannot carry an aggregate estimate');
   for(const k of ['inputUncached','cacheRead','cacheWrite','output'] as const){
    const sum=known.reduce((n,p)=>n+p.windows[w].value![k],0),value=total.value?.[k];
    if(!Number.isFinite(sum)||value===undefined&&sum>0||value!==undefined&&(sum>value&&!near(sum,value)||all&&!near(sum,value)))fail('Token provider conservation mismatch');
   }
  }
 }
});
export const recentSnapshotInputSchema=z.object({ifRevision:revision.optional()}).strict();
const thresholds=windowShape(z.number().finite().min(0).max(1_000_000));
const weights=z.record(id,z.number().finite().min(0).max(3)).refine(v=>Object.keys(v).length<=RECENT_LIMITS.providers,'Too many provider weights');
const configBase={schemaVersion:z.literal(2),providerWeights:weights};
export const scoringConfigV2Schema=z.discriminatedUnion('mode',[
 z.object({...configBase,mode:z.literal('percentile'),gates:z.object({m20:z.number().finite().min(0).max(1),h24:z.number().finite().min(0).max(1),d7:z.number().finite().min(0).max(1)}).strip()}).strip(),
 z.object({...configBase,mode:z.literal('absolute'),thresholds,lifetimeEnabled:z.boolean().optional()}).strip(),
]);
export type ScoringConfigV2=z.infer<typeof scoringConfigV2Schema>;
export const DEFAULT_SCORING_CONFIG_V2:Readonly<ScoringConfigV2>=Object.freeze({schemaVersion:2,mode:'percentile',providerWeights:Object.freeze({}),gates:Object.freeze({m20:0.9,h24:0.9,d7:0.9})});
/** New unpublished config meaning is explicit; V2 remains a legacy decoder. */
export const ROOT_FAMILY_HEAT_DOMAIN_V1=Object.freeze({version:1 as const,kind:'root-family' as const});
export const rootFamilyHeatDomainV1Schema=z.object({version:z.literal(1),kind:z.literal('root-family')}).strip();
export type RootFamilyHeatDomainV1=z.infer<typeof rootFamilyHeatDomainV1Schema>;
const configV3Base={schemaVersion:z.literal(3),domain:rootFamilyHeatDomainV1Schema,providerWeights:weights};
export const scoringConfigV3Schema=z.discriminatedUnion('mode',[
 z.object({...configV3Base,mode:z.literal('percentile'),gates:z.object({m20:z.number().finite().min(0).max(1),h24:z.number().finite().min(0).max(1),d7:z.number().finite().min(0).max(1)}).strip()}).strip(),
 z.object({...configV3Base,mode:z.literal('absolute'),thresholds,lifetimeEnabled:z.literal(false).optional()}).strip(),
]);
export type ScoringConfigV3=z.infer<typeof scoringConfigV3Schema>;
export type StoredScoringConfig=ScoringConfigV2|ScoringConfigV3;
export const storedScoringConfigSchema=z.union([scoringConfigV2Schema,scoringConfigV3Schema]);
export const DEFAULT_SCORING_CONFIG_V3:Readonly<Extract<ScoringConfigV3,{mode:'percentile'}>>=Object.freeze({schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:'percentile',providerWeights:Object.freeze({}),gates:Object.freeze({m20:.90,h24:.80,d7:.80})});
export const HEAT_WINDOWS=['m20','h24','d7'] as const;
export type HeatWindow=typeof HEAT_WINDOWS[number];
const rankWindows=z.object({m20:rank,h24:rank,d7:rank}).strip();
export const rootTopologyV1Schema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('attested'),parentThreadId:id.nullable(),lifecycleOwnerThreadId:id.nullable(),deleted:z.boolean()}).strip(),
 z.object({kind:z.literal('unknown'),reasons}).strip(),
]);
export type RootTopologyV1=z.infer<typeof rootTopologyV1Schema>;
export function rootFamilyEligibilityV1(input:RootTopologyV1):'eligible-root'|'ineligible-child'|'deleted'|'unknown'{
 const topology=rootTopologyV1Schema.parse(input);
 if(topology.kind==='unknown')return 'unknown';
 if(topology.deleted)return 'deleted';
 return topology.parentThreadId===null&&topology.lifecycleOwnerThreadId===null?'eligible-root':'ineligible-child';
}
const coveredPopulation=z.object({count,coverage,reasons}).strip();
const rootPopulations=z.object({m20:coveredPopulation,h24:coveredPopulation,d7:coveredPopulation}).strip();
const interval=z.object({start:time,end:time}).strip();
export const rootFamilyHeatContextV1Schema=z.object({
 version:z.literal(1),domain:rootFamilyHeatDomainV1Schema,contextRevision:revision,configRevision:revision,topologyRevision:revision,rankRevision:revision,rankAsOf:time,
 windows:z.object({m20:interval,h24:interval,d7:interval}).strip(),population:z.object({dollars:rootPopulations,scores:rootPopulations}).strip(),
}).strip().superRefine((v,c)=>{
 const duration={m20:20*60*1000,h24:24*60*60*1000,d7:7*24*60*60*1000};
 for(const w of HEAT_WINDOWS)if(v.windows[w].end!==v.rankAsOf||v.windows[w].start!==Math.max(0,v.rankAsOf-duration[w]))c.addIssue({code:'custom',message:'Invalid root heat window provenance',path:['windows',w]});
});
export type RootFamilyHeatContextV1=z.infer<typeof rootFamilyHeatContextV1Schema>;
const decision=z.object({decision:z.enum(['qualifies','below','suppressed','unavailable']),reason:z.enum(['threshold-met','below-threshold','gate-met','below-gate','not-root','deleted','topology-unknown','unsupported-value','zero','insufficient-population','rank-unavailable','context-unavailable'])}).strip();
export const rootFamilyDecisionSetV1Schema=z.object({contextRevision:revision,signals:z.object({m20:decision,h24:decision,d7:decision}).strip(),winner:z.enum(['on-fire','hot','heavy']).nullable()}).strip();
export type RootFamilyDecisionSetV1=z.infer<typeof rootFamilyDecisionSetV1Schema>;
export const recentRootHeatSchema=z.object({topology:rootTopologyV1Schema,rootDollarRanks:rankWindows,rootScoreRanks:rankWindows,decisions:rootFamilyDecisionSetV1Schema}).strip();
export type RecentRootHeat=z.infer<typeof recentRootHeatSchema>;
export type FamilyScoreAndRootRanks={contextRevision:string;configRevision:string;scores:Pick<RecentScope['scores'],HeatWindow>;rootScoreRanks:Record<HeatWindow,number|null>};
/** Root policy and all three decisions are shared by codec and draft preview.
 * No fallback to a context-free legacy helper; provenance lives in the context. */
export function rootFamilyHeatV1(input:{topology:RootTopologyV1;family:FamilyScoreAndRootRanks;context:RootFamilyHeatContextV1;config:ScoringConfigV3}):RootFamilyDecisionSetV1{
 const context=rootFamilyHeatContextV1Schema.parse(input.context),config=scoringConfigV3Schema.parse(input.config),family=input.family;
 if(family.configRevision!==context.configRevision||family.contextRevision!==context.contextRevision)throw new Error('Root heat configuration/context mismatch');
 const eligibility=rootFamilyEligibilityV1(input.topology),signals={} as RootFamilyDecisionSetV1['signals'];
 for(const w of HEAT_WINDOWS){
  const score=recentDollarSchema.parse(family.scores[w]),r=rank.parse(family.rootScoreRanks[w]),pop=context.population.scores[w];
  if(r!==null&&(pop.count===0||(pop.count===1&&r!==0)||pop.coverage==='unknown'))throw new Error('Root rank population mismatch');
  if(eligibility!=='eligible-root'){signals[w]={decision:eligibility==='unknown'?'unavailable':'suppressed',reason:eligibility==='unknown'?'topology-unknown':eligibility==='deleted'?'deleted':'not-root'};continue;}
  if(score.amount===null){signals[w]={decision:'unavailable',reason:'unsupported-value'};continue;}
  if(score.amount===0){signals[w]=score.kind==='floor'?{decision:'unavailable',reason:'unsupported-value'}:{decision:'suppressed',reason:'zero'};continue;}
  if(config.mode==='absolute'){
   const hit=score.amount>=config.thresholds[w];
   signals[w]=!hit&&score.kind==='floor'?{decision:'unavailable',reason:'unsupported-value'}:{decision:hit?'qualifies':'below',reason:hit?'threshold-met':'below-threshold'};
  }else if(pop.coverage==='unknown')signals[w]={decision:'unavailable',reason:'rank-unavailable'};
  else if(pop.count<2)signals[w]={decision:'suppressed',reason:'insufficient-population'};
  else if(r===null)signals[w]={decision:'unavailable',reason:'rank-unavailable'};
  else{const hit=r>=config.gates[w];signals[w]={decision:hit?'qualifies':'below',reason:hit?'gate-met':'below-gate'};}
 }
 const winner=signals.m20.decision==='qualifies'?'on-fire':signals.h24.decision==='qualifies'?'hot':signals.d7.decision==='qualifies'?'heavy':null;
 return {contextRevision:context.contextRevision,signals,winner};
}
export const recentRowSchema=z.object({threadId:id,revision,configRevision:revision,asOf:time,presentation:recentPresentationSchema.optional(),ownLastFoldAt:time.nullable(),familyLastFoldAt:time.nullable(),own:recentScopeSchema,family:recentScopeSchema,heat:recentRootHeatSchema.optional()}).strip();
export const recentRootInputSchema=z.object({threadId:id,asOf:time,configRevision:revision,presentation:recentPresentationSchema.optional(),family:recentScopeSchema,heat:recentRootHeatSchema}).strip();
/** Unique all-window inputs from the IMMUTABLE rank capture, independent of
 * newer72h display rows. Cohort completeness does not upgrade value coverage. */
export const recentHeatInputsSchema=z.object({contextRevision:revision,topologyRevision:revision,cohortComplete:z.boolean(),pending:count,omitted:z.object({count,exact:z.boolean()}).strip(),rows:z.array(recentRootInputSchema).max(RECENT_LIMITS.rows)}).strip();
export type RecentRootInput=z.infer<typeof recentRootInputSchema>;
export type RecentHeatInputs=z.infer<typeof recentHeatInputsSchema>;
/** Missing weights mean1; weighting influences heat, never the retained dollar estimate. */
export function weightedScoreV2(values:readonly {providerId:string;amount:number|null}[],providerWeights:ScoringConfigV2['providerWeights']):number|null{
 if(values.length>RECENT_LIMITS.providers)throw new Error('Too many score providers');weights.parse(providerWeights);let sum=0,unknown=false;const seen=new Set<string>();
 for(const v of values){id.parse(v.providerId);if(seen.has(v.providerId))throw new Error('Duplicate score provider');seen.add(v.providerId);if(v.amount===null){unknown=true;continue;}if(!Number.isFinite(v.amount)||v.amount<0)throw new Error('Invalid provider dollars');const w=Object.hasOwn(providerWeights,v.providerId)?providerWeights[v.providerId]!:1;sum+=w*v.amount;if(!Number.isFinite(sum))throw new Error('Weighted dollar overflow');}
 return unknown?null:sum;
}
const population=z.object({count,coverage}).strip();
const populations=z.object({m20:population,h24:population,d7:population}).strip();
const scopedPopulations=z.object({dollars:populations,scores:populations}).strip();
/** Ordered across writer instances within one durable source history. External
 * database rollback/replacement requires explicit consumer source replacement;
 * an opaque new instance alone never authorizes resetting a retained watermark. */
export const recentPublicationIdentitySchema=z.object({instance:z.string().min(1).max(128),sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strip();
export type RecentPublicationIdentity=z.infer<typeof recentPublicationIdentitySchema>;
export const recentSnapshotFullSchema=z.object({
 version:z.literal(1),revision,publication:recentPublicationIdentitySchema.optional(),unchanged:z.literal(false),currency:z.literal('USD'),estimated:z.literal(true),cutoffLastFoldAt:time.nullable(),asOf:time,rankAsOf:time,recentWindowMs:z.literal(RECENT_LIMITS.windowMs),
 config:z.object({revision,value:storedScoringConfigSchema}).strip(),
 heat:rootFamilyHeatContextV1Schema.optional(),
 heatInputs:recentHeatInputsSchema.optional(),
 coverage,coverageReasons:reasons,materializationPending:count,omittedRows:z.object({count,exact:z.boolean()}).strip(),
 population:z.object({own:scopedPopulations,family:scopedPopulations}).strip(),
 rows:z.array(recentRowSchema).max(RECENT_LIMITS.rows),
}).strip();
export const recentSnapshotResultSchema=z.union([z.object({version:z.literal(1),revision,unchanged:z.literal(true)}).strip(),recentSnapshotFullSchema]);
export type RecentSnapshotInput=z.infer<typeof recentSnapshotInputSchema>;
export type RecentSnapshotResult=z.infer<typeof recentSnapshotResultSchema>;
export type RecentSnapshot=z.infer<typeof recentSnapshotFullSchema>;
export type RecentRow=z.infer<typeof recentRowSchema>;
export type RecentScope=z.infer<typeof recentScopeSchema>;
export function validateRecentSnapshot(input:RecentSnapshotInput,value:unknown):RecentSnapshotResult{
 recentSnapshotInputSchema.parse(input);const bytes=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
 if(bytes(value)>RECENT_LIMITS.bytes)throw new Error('Snapshot byte limit');
 const raw=value as {rows?:unknown[];heatInputs?:{rows?:unknown[]}}|null;let entries=0;
 for(const rows of [raw?.rows,raw?.heatInputs?.rows])if(rows!==undefined){if(!Array.isArray(rows)||(entries+=rows.length)>RECENT_LIMITS.rows)throw new Error('Snapshot aggregate row limit');for(const row of rows)if(bytes(row)>RECENT_LIMITS.rowBytes)throw new Error('Snapshot row byte limit');}
 if(value&&typeof value==='object'&&(value as {unchanged?:unknown}).unchanged===true){
  for(const field of Object.keys(recentSnapshotFullSchema.shape))if(!['version','revision','unchanged'].includes(field)&&Object.hasOwn(value,field))throw new Error('Unchanged snapshot carries recognized full content');
 }
 const out=recentSnapshotResultSchema.parse(value);
 if(out.unchanged){if(input.ifRevision!==out.revision)throw new Error('Unmatched snapshot revision');return out;}
 if(out.config.value.schemaVersion===3&&!out.heat)throw new Error('Root-family configuration requires heat context');
 if(out.heat&&(out.config.value.schemaVersion!==3||out.heat.configRevision!==out.config.revision||out.heat.rankAsOf!==out.rankAsOf))throw new Error('Root heat configuration/rank epoch mismatch');
 if(out.rankAsOf>out.asOf)throw new Error('Future rank time');if((out.materializationPending||out.omittedRows.count||!out.omittedRows.exact)&&out.coverage==='complete')throw new Error('Pending/capped snapshot must disclose coverage');
 let previousActivity=Infinity,previousId='';const ids=new Set<string>();for(const row of out.rows){if(ids.has(row.threadId))throw new Error('Duplicate snapshot thread');ids.add(row.threadId);if(row.asOf>out.asOf)throw new Error('Future row time');if(row.configRevision!==out.config.revision)throw new Error('Row score configuration mismatch');if(row.ownLastFoldAt===null&&row.familyLastFoldAt===null)throw new Error('Missing fold activity timestamp');const activity=Math.max(row.ownLastFoldAt??0,row.familyLastFoldAt??0);if(activity>out.asOf||activity<Math.max(0,out.asOf-out.recentWindowMs))throw new Error('Row outside recent activity window');if(activity>previousActivity||(activity===previousActivity&&row.threadId<previousId))throw new Error('Rows must be newest first with ID tie-break');previousActivity=activity;previousId=row.threadId;for(const scope of ['own','family'] as const){validateProjection(row[scope],out.config.value.providerWeights);validateRanks(row[scope],out.population[scope],out.rankAsOf>=row.asOf);}validateRootHeatRow(row,out.heat,out.config.value); }
 if(out.heat){for(const [axis,field] of [['dollars','windows'],['scores','scores']] as const){for(const w of HEAT_WINDOWS){
  const pop=out.heat.population[axis][w],supported=out.rows.filter(row=>row.heat&&rootFamilyEligibilityV1(row.heat.topology)==='eligible-root'&&row.asOf<=out.heat!.rankAsOf&&(row.family[field][w].amount??0)>0).length;
  if(pop.coverage==='complete'&&pop.count<supported)throw new Error('Root population below supported displayed members');
 }}}
 if(out.heatInputs)validateHeatInputs(out);
 if(out.omittedRows.count&&out.rows.length&&out.cutoffLastFoldAt!==previousActivity)throw new Error('Missing eviction cutoff');return out;
}


function validateProjection(projection:RecentScope,providerWeights:ScoringConfigV2['providerWeights']){
 if(projection.coverageReasons.includes('unpriced')&&!projection.approximation.reasons.includes('missing-price'))throw new Error('Unpriced coverage requires missing-price provenance');
 const observationGap=projection.coverage!=='complete'&&!projection.coverageReasons.includes('unpriced')&&projection.approximation.reasons.includes('source-gap')&&projection.coverageReasons.some(r=>['source-gap','root-unattested','history-unavailable','missing-thread'].includes(r));
 const unavailableProvenance=(approximation:RecentScope['approximation'])=>approximation.reasons.includes('missing-price')||(observationGap&&approximation.reasons.includes('source-gap'));
 for(const p of projection.providers){
  if(p.approximation.approximate&&(!projection.approximation.approximate||p.approximation.reasons.some(reason=>!projection.approximation.reasons.includes(reason))))throw new Error('Aggregate must retain provider approximation provenance');
  if(Object.values(p.windows).some(v=>v.kind==='unavailable')&&!unavailableProvenance(p.approximation))throw new Error('Unavailable provider requires missing-price provenance');
 }
 if([...Object.values(projection.windows),...Object.values(projection.scores)].some(v=>v.kind==='unavailable')&&!unavailableProvenance(projection.approximation))throw new Error('Unavailable total requires missing-price provenance');
 for(const window of ['m20','h24','d7','lifetime'] as const){
  const known=projection.providers.filter(p=>p.windows[window].kind!=='unavailable');
  const parts=known.map(p=>({providerId:p.providerId,amount:p.windows[window].amount}));
  const dollars=parts.reduce((sum,p)=>sum+p.amount!,0),score=weightedScoreV2(parts,providerWeights)!;
  if(!Number.isFinite(dollars))throw new Error('Provider dollar overflow');
  const incomplete=projection.omittedProviders>0||known.length!==projection.providers.length;
  const floor=incomplete||known.some(p=>p.windows[window].kind==='floor');
  const equal=(a:number,b:number)=>Math.abs(a-b)<=8*Number.EPSILON*Math.max(a,b);
  const attribution=projection.attribution;
  if(projection.windows[window].kind==='unavailable'&&(dollars>0||(attribution?.unknownProvider[window].amount??0)>0))throw new Error('Supported provider dollars require an aggregate floor or estimate');
  if(attribution){
   const unknown=attribution.unknownProvider[window],complete=attribution.attributionComplete[window];
   if(complete&&(projection.omittedProviders>0||unknown.kind!=='estimate'||unknown.amount!==0))throw new Error('Complete attribution requires no unknown provider remainder');
   if(attribution.unpriced[window]&&!projection.approximation.reasons.includes('missing-price'))throw new Error('Unpriced attribution requires missing-price provenance');
   if(projection.windows[window].kind==='estimate'&&(!complete||attribution.unpriced[window]||unknown.kind!=='estimate'||unknown.amount!==0))throw new Error('Incomplete attribution cannot carry an estimate');
   const total=projection.windows[window],reconciled=dollars+(unknown.amount??0);
   if(!Number.isFinite(reconciled)||total.amount!==null&&(reconciled>total.amount&&!equal(reconciled,total.amount)||unknown.kind==='estimate'&&!equal(reconciled,total.amount)))throw new Error('Unknown provider reconciliation mismatch');
  }
  for(const [total,subtotal,label] of [[projection.windows[window],dollars,'dollar'],[projection.scores[window],score,'score']] as const){
   if(total.kind==='unavailable')continue;
   if(floor&&total.kind==='estimate')throw new Error('Partial/provider floor cannot become an exact estimate');
   if(incomplete){if(total.amount<subtotal&&!equal(total.amount,subtotal))throw new Error(`Known provider ${label} subtotal exceeds total`);}
   else if(!equal(total.amount,subtotal))throw new Error(`Provider ${label} total mismatch`);
  }
 }
}
function validateRanks(projection:RecentScope,population:z.infer<typeof scopedPopulations>,contemporaneous:boolean){
 for(const [values,ranks,pops] of [[projection.windows,projection.dollarRanks,population.dollars],[projection.scores,projection.scoreRanks,population.scores]] as const){
  for(const w of ['m20','h24','d7'] as const){const r=ranks[w],n=pops[w].count;
   if(r!==null&&(n===0||(n===1&&r!==0)))throw new Error('Rank contradicts empty/singleton population');
   if(contemporaneous&&r!==null&&(values[w].amount===null||values[w].amount!<=0))throw new Error('Rank requires supported positive contemporaneous amount');
  }
 }
}
/** Older rank epochs may be retained; a heat decision must also check CURRENT
 * supported positive amounts. Legacy heat(ranks) alone is insufficient here. */
export function recentPercentileHeat(projection:RecentScope,gates={m20:.9,h24:.9,d7:.9},population?:Record<'m20'|'h24'|'d7',{count:number}>):'on-fire'|'hot'|'heavy'|null{
 for(const w of ['m20','h24','d7'] as const)if(!Number.isFinite(gates[w])||gates[w]<0||gates[w]>1)throw new Error('Invalid gate');
 // A positive validated rank already proves at least2 members. Rank0 needs
 // explicit population evidence (it can represent a singleton OR a tied group).
 for(const [w,label] of [['m20','on-fire'],['h24','hot'],['d7','heavy']] as const){const amount=projection.scores[w].amount,r=projection.scoreRanks[w],n=population?.[w].count??(r!==null&&r>0?2:0);if(n>=2&&amount!==null&&amount>0&&r!==null&&r>=gates[w])return label;}
 return null;
}

// Complete first-index ranks lie on k/(n-1). Allow only bounded floating
// representation error (at most 4 EPS in rank units), never infer row ordering.
function isFirstIndexRank(r:number,n:number){const nearest=Math.round(r*(n-1))/(n-1);return Math.abs(r-nearest)<=4*Number.EPSILON*Math.max(r,nearest);}
function validateRootHeatRow(row:Pick<RecentRow,'asOf'|'family'|'heat'|'configRevision'>,context:RootFamilyHeatContextV1|undefined,config:StoredScoringConfig){
 if(!context){if(row.heat)throw new Error('Root row requires context');return;}
 if(!row.heat||config.schemaVersion!==3)throw new Error('Missing root row topology/decisions');
 const heat=row.heat,eligible=rootFamilyEligibilityV1(heat.topology)==='eligible-root';
 for(const [ranks,population,values] of [[heat.rootDollarRanks,context.population.dollars,row.family.windows],[heat.rootScoreRanks,context.population.scores,row.family.scores]] as const){
  for(const w of HEAT_WINDOWS){const r=ranks[w],n=population[w].count;
   if(!eligible&&r!==null)throw new Error('Ineligible thread carries root-domain rank');
   if(r!==null&&(n===0||(n===1&&r!==0)||population[w].coverage==='unknown'))throw new Error('Root rank population mismatch');
   if(r!==null&&n>=2&&population[w].coverage==='complete'&&!isFirstIndexRank(r,n))throw new Error('Root rank outside complete first-index grid');
   if(context.rankAsOf>=row.asOf&&r!==null&&population[w].coverage==='complete'&&values[w].kind!=='estimate')throw new Error('Uncertified value cannot carry a complete root rank');
   if(context.rankAsOf>=row.asOf&&r!==null&&(values[w].amount===null||values[w].amount!<=0))throw new Error('Root rank needs supported positive amount');
  }
 }
 const expected=rootFamilyHeatV1({topology:heat.topology,family:{contextRevision:heat.decisions.contextRevision,configRevision:row.configRevision,scores:row.family.scores,rootScoreRanks:heat.rootScoreRanks},context,config});
 if(JSON.stringify(expected)!==JSON.stringify(heat.decisions))throw new Error('Root heat decisions/winner mismatch');
}

function validateHeatInputs(snapshot:RecentSnapshot){
 const input=snapshot.heatInputs!,context=snapshot.heat;
 if(!context||snapshot.config.value.schemaVersion!==3||input.contextRevision!==context.contextRevision||input.topologyRevision!==context.topologyRevision)throw new Error('Root input context mismatch');
 if(!input.cohortComplete&&snapshot.coverage==='complete')throw new Error('Incomplete root inputs require partial snapshot');
 if(input.cohortComplete&&(input.pending||input.omitted.count||!input.omitted.exact))throw new Error('Incomplete root input cohort');
 const ids=new Set<string>();
 for(const row of input.rows){
  if(ids.has(row.threadId))throw new Error('Duplicate root input');ids.add(row.threadId);
  if(row.asOf>context.rankAsOf||row.configRevision!==snapshot.config.revision||rootFamilyEligibilityV1(row.heat.topology)!=='eligible-root'||!row.family.attribution)throw new Error('Invalid root input capture');
  validateProjection(row.family,snapshot.config.value.providerWeights);validateRootHeatRow(row,context,snapshot.config.value);
 }
 for(const [axis,field,ranks] of [['dollars','windows','rootDollarRanks'],['scores','scores','rootScoreRanks']] as const)for(const w of HEAT_WINDOWS){
  const pop=context.population[axis][w],supported=input.rows.filter(row=>(row.family[field][w].amount??0)>0);
  if(input.cohortComplete&&pop.count>input.rows.length)throw new Error('Root cohort below declared population');
  if(pop.coverage==='complete'&&pop.count<supported.length)throw new Error('Root input population below supported members');
  if(!input.cohortComplete||pop.coverage!=='complete')continue;
  if(supported.some(row=>row.family[field][w].kind!=='estimate')||pop.count!==supported.length)throw new Error('Complete root input population mismatch');
  const sorted=supported.slice().sort((a,b)=>a.family[field][w].amount!-b.family[field][w].amount!||(a.threadId<b.threadId?-1:1)),expected=new Map<string,number>();let first=0;
  for(let i=0;i<sorted.length;i++){if(!i||sorted[i]!.family[field][w].amount!==sorted[i-1]!.family[field][w].amount)first=i;expected.set(sorted[i]!.threadId,sorted.length===1?0:first/(sorted.length-1));}
  for(const row of input.rows){const actual=row.heat[ranks][w],rank=expected.get(row.threadId)??null;if(actual!==rank)throw new Error('Root input rank/order mismatch');}
 }
}
