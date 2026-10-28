import { z } from 'zod';
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
/** Compact pricing/model provenance is independent of observation completeness.
 * Per-model rate associations remain available through readV1/detail. */
export const recentApproximationSchema=z.object({approximate:z.boolean(),reasons:z.array(z.enum(['closest-model','provider-default','model-attribution','bucket-boundary','missing-price','source-gap'])).max(6)}).strip().superRefine((v,c)=>{if(!v.approximate&&v.reasons.length)c.addIssue({code:'custom',message:'Approximation reasons require approximate flag'});});
const provider=z.object({providerId:id,windows:recentWindowsSchema,approximation:recentApproximationSchema}).strip();
export const recentScopeSchema=z.object({
 memberCount:count,coverage,coverageReasons:reasons,priceVersion:revision,approximation:recentApproximationSchema,
 windows:recentWindowsSchema,scores:recentWindowsSchema,providers:z.array(provider).max(RECENT_LIMITS.providers),omittedProviders:count,
 dollarRanks:z.object({m20:rank,h24:rank,d7:rank}).strip(),scoreRanks:z.object({m20:rank,h24:rank,d7:rank}).strip(),
}).strip().superRefine((v,c)=>{if(new Set(v.providers.map(x=>x.providerId)).size!==v.providers.length)c.addIssue({code:'custom',message:'Duplicate providers'});if(v.omittedProviders&&v.coverage==='complete')c.addIssue({code:'custom',message:'Omitted providers require partial coverage'});});
export const recentRowSchema=z.object({threadId:id,revision,configRevision:revision,asOf:time,ownLastFoldAt:time.nullable(),familyLastFoldAt:time.nullable(),own:recentScopeSchema,family:recentScopeSchema}).strip();
export const recentSnapshotInputSchema=z.object({ifRevision:revision.optional()}).strict();
const thresholds=windowShape(z.number().finite().nonnegative());
const weights=z.record(id,z.number().finite().nonnegative()).refine(v=>Object.keys(v).length<=RECENT_LIMITS.providers,'Too many provider weights');
const configBase={schemaVersion:z.literal(2),providerWeights:weights};
export const scoringConfigV2Schema=z.discriminatedUnion('mode',[
 z.object({...configBase,mode:z.literal('percentile'),gates:z.object({m20:z.number().finite().min(0).max(1),h24:z.number().finite().min(0).max(1),d7:z.number().finite().min(0).max(1)}).strip()}).strip(),
 z.object({...configBase,mode:z.literal('absolute'),thresholds}).strip(),
]);
export type ScoringConfigV2=z.infer<typeof scoringConfigV2Schema>;
export const DEFAULT_SCORING_CONFIG_V2:Readonly<ScoringConfigV2>=Object.freeze({schemaVersion:2,mode:'percentile',providerWeights:Object.freeze({}),gates:Object.freeze({m20:0.9,h24:0.9,d7:0.9})});
/** Missing weights mean1; weighting influences heat, never the retained dollar estimate. */
export function weightedScoreV2(values:readonly {providerId:string;amount:number|null}[],providerWeights:ScoringConfigV2['providerWeights']):number|null{
 if(values.length>RECENT_LIMITS.providers)throw new Error('Too many score providers');weights.parse(providerWeights);let sum=0,unknown=false;const seen=new Set<string>();
 for(const v of values){id.parse(v.providerId);if(seen.has(v.providerId))throw new Error('Duplicate score provider');seen.add(v.providerId);if(v.amount===null){unknown=true;continue;}if(!Number.isFinite(v.amount)||v.amount<0)throw new Error('Invalid provider dollars');const w=Object.hasOwn(providerWeights,v.providerId)?providerWeights[v.providerId]!:1;sum+=w*v.amount;if(!Number.isFinite(sum))throw new Error('Weighted dollar overflow');}
 return unknown?null:sum;
}
const population=z.object({count,coverage}).strip();
const populations=z.object({m20:population,h24:population,d7:population}).strip();
const scopedPopulations=z.object({dollars:populations,scores:populations}).strip();
export const recentSnapshotFullSchema=z.object({
 version:z.literal(1),revision,unchanged:z.literal(false),currency:z.literal('USD'),estimated:z.literal(true),cutoffLastFoldAt:time.nullable(),asOf:time,rankAsOf:time,recentWindowMs:z.literal(RECENT_LIMITS.windowMs),
 config:z.object({revision,value:scoringConfigV2Schema}).strip(),
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
 const raw=value as {rows?:unknown[]}|null;if(raw?.rows!==undefined){if(!Array.isArray(raw.rows)||raw.rows.length>RECENT_LIMITS.rows)throw new Error('Snapshot row limit');for(const row of raw.rows)if(bytes(row)>RECENT_LIMITS.rowBytes)throw new Error('Snapshot row byte limit');}
 if(value&&typeof value==='object'&&(value as {unchanged?:unknown}).unchanged===true){
  for(const field of Object.keys(recentSnapshotFullSchema.shape))if(!['version','revision','unchanged'].includes(field)&&Object.hasOwn(value,field))throw new Error('Unchanged snapshot carries recognized full content');
 }
 const out=recentSnapshotResultSchema.parse(value);
 if(out.unchanged){if(input.ifRevision!==out.revision)throw new Error('Unmatched snapshot revision');return out;}
 if(out.rankAsOf>out.asOf)throw new Error('Future rank time');if((out.materializationPending||out.omittedRows.count||!out.omittedRows.exact)&&out.coverage==='complete')throw new Error('Pending/capped snapshot must disclose coverage');
 let previousActivity=Infinity,previousId='';const ids=new Set<string>();for(const row of out.rows){if(ids.has(row.threadId))throw new Error('Duplicate snapshot thread');ids.add(row.threadId);if(row.asOf>out.asOf)throw new Error('Future row time');if(row.configRevision!==out.config.revision)throw new Error('Row score configuration mismatch');if(row.ownLastFoldAt===null&&row.familyLastFoldAt===null)throw new Error('Missing fold activity timestamp');const activity=Math.max(row.ownLastFoldAt??0,row.familyLastFoldAt??0);if(activity>out.asOf||activity<Math.max(0,out.asOf-out.recentWindowMs))throw new Error('Row outside recent activity window');if(activity>previousActivity||(activity===previousActivity&&row.threadId<previousId))throw new Error('Rows must be newest first with ID tie-break');previousActivity=activity;previousId=row.threadId;for(const scope of ['own','family'] as const){validateProjection(row[scope],out.config.value.providerWeights);validateRanks(row[scope],out.population[scope],out.rankAsOf>=row.asOf);}}
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
export function recentPercentileHeat(projection:RecentScope,gates={m20:.9,h24:.9,d7:.9}):'on-fire'|'hot'|'heavy'|null{
 for(const w of ['m20','h24','d7'] as const)if(!Number.isFinite(gates[w])||gates[w]<0||gates[w]>1)throw new Error('Invalid gate');
 for(const [w,label] of [['m20','on-fire'],['h24','hot'],['d7','heavy']] as const){const amount=projection.scores[w].amount,r=projection.scoreRanks[w];if(amount!==null&&amount>0&&r!==null&&r>=gates[w])return label;}
 return null;
}
