import { z } from 'zod';
import { UsageVectorSchema } from '@phosphorco/bb-usage-algebra/vector';
export type { UsageVector } from '@phosphorco/bb-usage-algebra/vector';

export const LIMITS = Object.freeze({ threadIds:200, seriesPoints:288, detailRows:200, inputBytes:65536, outputBytes:2097152, describeBytes:16384, candidates:128, listedPlugins:10000, concurrency:4, callMs:2000, discoveryMs:5000, familyEdges:50000, familyMembers:10000, familyDepth:256 });
export const METRIC_BUCKET_MS=300000;
const WINDOW_BUCKETS={m20:4,h24:288,d7:2016,lifetime:2016} as const;
/** Retained last-N fixed buckets; lifetime time rows still obey seven-day retention. */
export function retainedWindowStart(asOf:number,window:z.infer<typeof windowSchema>):number {
 time.parse(asOf);windowSchema.parse(window);return Math.max(0,Math.floor(asOf/METRIC_BUCKET_MS)*METRIC_BUCKET_MS-(WINDOW_BUCKETS[window]-1)*METRIC_BUCKET_MS);
}
export const METHODS = Object.freeze({describe:'threadMetricsDescribe',read:'threadMetricsReadV1',detail:'threadMetricsDetailV1'});
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const text = z.string().min(1).max(256);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().nonnegative().nullable();
const scope = z.enum(['own','family']);
export const windowSchema = z.enum(['m20','h24','d7','lifetime']);
export const coverageSchema = z.enum(['complete','partial','unknown']);
export const coverageReasonSchema = z.enum(['source-gap','history-unavailable','member-cap','depth-cap','edge-cap','missing-thread','unpriced','retention','row-cap','pagination','population-incomplete']);
const reasons = z.array(coverageReasonSchema).max(16);
export const approximationSchema = z.object({
 approximate:z.boolean(), reasons:z.array(z.enum(['closest-model','provider-default','model-attribution','bucket-boundary','missing-price','source-gap'])).max(6),
 rates:z.array(z.object({providerId:id,modelId:text,rateId:text.nullable(),basis:z.enum(['matched','closest-model','provider-default','unpriced'])})).max(32).optional(),
}).strip().superRefine((v,ctx)=>{if(!v.approximate&&(v.reasons.length||v.rates?.some(r=>r.basis!=='matched')))ctx.addIssue({code:'custom',message:'Approximation provenance requires approximate flag'});});
const rank = z.number().finite().min(0).max(1).nullable();
export const ranksSchema = z.object({m20:rank,h24:rank,d7:rank}).strip();
const population = z.object({asOf:time,count:z.number().int().nonnegative(),coverage:coverageSchema}).strip();
export const rankPopulationSchema = z.object({m20:population,h24:population,d7:population}).strip();
export const windowValueSchema = z.object({tokens:UsageVectorSchema,amount:money}).strip();
export const windowsSchema = z.object({m20:windowValueSchema,h24:windowValueSchema,d7:windowValueSchema,lifetime:windowValueSchema}).strip();
export const bucketSchema = z.object({start:time,amount:money}).strip();
const metadata = {
 threadId:id,scope,memberCount:z.number().int().nonnegative().max(LIMITS.familyMembers),coverage:coverageSchema,coverageReasons:reasons,excluded:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
 asOf:time,revision:text,priceVersion:text,currency:z.literal('USD'),estimated:z.literal(true),approximation:approximationSchema,
 ranks:ranksSchema,rankPopulation:rankPopulationSchema,
 reported:z.object({amount:z.number().finite().nonnegative(),currency:z.string().min(1).max(16),asOf:time}).strip().optional(),
};
export const summaryRowSchema = z.discriminatedUnion('changed',[
 z.object({...metadata,changed:z.literal(true),windows:windowsSchema,buckets:z.array(bucketSchema).max(LIMITS.seriesPoints).optional()}).strip(),
 z.object({...metadata,changed:z.literal(false),windows:z.never().optional(),buckets:z.never().optional()}).strip(),
]);
export const readInputSchema = z.object({
 threadIds:z.array(id).min(1).max(LIMITS.threadIds),scope,includeArchived:z.boolean().optional(),
 knownRevisions:z.record(id,text).optional(),
 series:z.object({activeThreadId:id,maxPoints:z.number().int().min(1).max(LIMITS.seriesPoints)}).strict().optional(),
}).strict().superRefine((v,ctx)=>{
 if(new Set(v.threadIds).size!==v.threadIds.length)ctx.addIssue({code:'custom',message:'Duplicate thread IDs'});
 if(v.series&&!v.threadIds.includes(v.series.activeThreadId))ctx.addIssue({code:'custom',message:'Series requires requested active thread'});
 if(v.knownRevisions&&Object.keys(v.knownRevisions).some(k=>!v.threadIds.includes(k)))ctx.addIssue({code:'custom',message:'Unrequested revision key'});
});
export const readResultSchema = z.object({version:z.literal(1),rows:z.array(summaryRowSchema).max(LIMITS.threadIds)}).strip();
export const detailInputSchema = z.object({threadId:id,scope,includeArchived:z.boolean().optional(),axis:z.enum(['model','time']),window:windowSchema,cursor:z.string().min(1).max(1024).optional(),limit:z.number().int().min(1).max(LIMITS.detailRows).optional()}).strict();
const detailBase={amount:money,tokens:UsageVectorSchema,approximation:approximationSchema};
export const detailRowSchema=z.discriminatedUnion('axis',[
 z.object({...detailBase,axis:z.literal('model'),providerId:id,modelId:text}).strip(),
 z.object({...detailBase,axis:z.literal('time'),start:time,end:time}).strip().refine(v=>v.end>v.start,{message:'Empty time interval'}),
]);
export const detailResultSchema=z.object({version:z.literal(1),threadId:id,scope,axis:z.enum(['model','time']),window:windowSchema,asOf:time,revision:text,priceVersion:text,currency:z.literal('USD'),estimated:z.literal(true),coverage:coverageSchema,coverageReasons:reasons,excluded:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),approximation:approximationSchema,total:windowValueSchema,rows:z.array(detailRowSchema).max(LIMITS.detailRows),nextCursor:z.string().min(1).max(1024).optional()}).strip();
export const describeInputSchema=z.object({}).strict();
export const describeEnvelopeSchema=z.object({protocol:z.literal('bb-thread-metrics'),versions:z.array(z.number().int().positive()).max(16)}).passthrough();
export const capabilitiesSchema=z.object({summary:z.literal(true),series:z.boolean(),detail:z.boolean()}).strip();
export const describeV1Schema=describeEnvelopeSchema.extend({capabilities:capabilitiesSchema});
export type ReadInput=z.infer<typeof readInputSchema>;
export type ReadResult=z.infer<typeof readResultSchema>;
export type SummaryRow=z.infer<typeof summaryRowSchema>;
export type DetailInput=z.infer<typeof detailInputSchema>;
export type DetailResult=z.infer<typeof detailResultSchema>;
export type Capabilities=z.infer<typeof capabilitiesSchema>;
export type Ranks=z.infer<typeof ranksSchema>;
export type CoverageReason=z.infer<typeof coverageReasonSchema>;
export function parseBounded<T>(schema:z.ZodType<T>,value:unknown,maxBytes:number):T{
 // Byte admission includes unknown additive fields, before schema traversal.
 const json=JSON.stringify(value);
 if(json===undefined||new TextEncoder().encode(json).byteLength>maxBytes){const error=new Error('Payload byte limit');error.name='MetricsCodecError';throw error;}
 return schema.parse(value);
}
export function negotiateVersion(value:unknown): {kind:'ready';version:1;capabilities:Capabilities}|{kind:'incompatible'}{
 const env=describeEnvelopeSchema.safeParse(value);
 if(!env.success||!env.data.versions.includes(1))return {kind:'incompatible'};
 const v=describeV1Schema.safeParse(value);
 return v.success?{kind:'ready',version:1,capabilities:v.data.capabilities}:{kind:'incompatible'};
}
/** Host population must use the same scope/archive policy as the numerator. */
export function dollarPercentiles(population:readonly {threadId:string;amount:number|null}[]):Map<string,number|null>{
 const seen=new Set<string>();
 for(const p of population){if(seen.has(p.threadId))throw new Error('Duplicate population thread');seen.add(p.threadId);if(p.amount!==null&&(!Number.isFinite(p.amount)||p.amount<0))throw new Error('Invalid dollars');}
 const active=population.filter((p):p is {threadId:string;amount:number}=>p.amount!==null&&p.amount>0);
 const sorted=active.map(p=>p.amount).sort((a,b)=>a-b);
 const lower=new Map<number,number>();sorted.forEach((x,i)=>{if(!lower.has(x))lower.set(x,i);});
 return new Map(population.map(p=>[p.threadId,p.amount===null||p.amount===0?null:active.length<2?0:lower.get(p.amount)!/(active.length-1)]));
}
export function heat(ranks:Ranks,gates={m20:0.9,h24:0.9,d7:0.9}):'on-fire'|'hot'|'heavy'|null{
 for(const w of ['m20','h24','d7'] as const)if(!Number.isFinite(gates[w])||gates[w]<0||gates[w]>1)throw new Error('Invalid gate');
 return ranks.m20!==null&&ranks.m20>=gates.m20?'on-fire':ranks.h24!==null&&ranks.h24>=gates.h24?'hot':ranks.d7!==null&&ranks.d7>=gates.d7?'heavy':null;
}
export interface ThreadEdge {threadId:string;parentThreadId?:string|null;lifecycleOwnerThreadId?:string|null;hidden?:boolean;archived?:boolean;deleted?:boolean}
export interface FamilyPolicy {includeArchived?:boolean;maxMembers?:number;maxDepth?:number;maxEdges?:number;sourceCoverage?:'complete'|'partial'|'unknown'}
export interface FamilyResult {members:string[];coverage:'complete'|'partial'|'unknown';coverageReasons:CoverageReason[];excluded?:number}
export function familyClosure(edges:readonly ThreadEdge[],roots:readonly string[],policy:FamilyPolicy={}):FamilyResult{
 const cap=(n:number|undefined,fallback:number)=>{const v=n??fallback;if(!Number.isInteger(v)||v<1||v>fallback)throw new Error('Invalid family cap');return v;};
 const maxMembers=cap(policy.maxMembers,LIMITS.familyMembers),maxDepth=cap(policy.maxDepth,LIMITS.familyDepth),maxEdges=cap(policy.maxEdges,LIMITS.familyEdges);
 if(roots.length>LIMITS.threadIds)throw new Error('Too many roots');
 const why=new Set<CoverageReason>(),nodes=new Map<string,ThreadEdge>(),children=new Map<string,Set<string>>();
 if(edges.length>maxEdges)why.add('edge-cap');
 for(const e of edges.slice(0,maxEdges)){if(nodes.has(e.threadId))throw new Error('Duplicate edge thread');nodes.set(e.threadId,e);for(const p of [e.parentThreadId,e.lifecycleOwnerThreadId])if(p){let c=children.get(p);if(!c)children.set(p,c=new Set());c.add(e.threadId);}}
 const queue=Array.from(new Set(roots),threadId=>({threadId,depth:0})),seen=new Set<string>(),members:string[]=[];
 for(let i=0;i<queue.length;i++){
  const {threadId,depth}=queue[i]!;if(seen.has(threadId))continue;seen.add(threadId);
  const node=nodes.get(threadId);if(!node){why.add('missing-thread');continue;}if(node.deleted)continue;
  // Archived nodes remain traversable, so a live grandchild is still reachable.
  if(policy.includeArchived!==false||!node.archived){if(members.length>=maxMembers){why.add('member-cap');break;}members.push(threadId);}
  const next=children.get(threadId);if(next){if(depth>=maxDepth){if([...next].some(c=>!seen.has(c)))why.add('depth-cap');}else for(const c of next)if(!seen.has(c))queue.push({threadId:c,depth:depth+1});}
 }
 const source=coverageSchema.parse(policy.sourceCoverage??'complete');if(source==='partial')why.add('source-gap');if(source==='unknown')why.add('history-unavailable');
 return {members,coverage:source==='unknown'?'unknown':why.size?'partial':'complete',coverageReasons:[...why]};
}
export function validateReadResult(input:ReadInput,value:unknown):ReadResult{
 const out=parseBounded(readResultSchema,value,LIMITS.outputBytes),seen=new Set<string>();
 for(const row of out.rows){
  if(!input.threadIds.includes(row.threadId)||row.scope!==input.scope||seen.has(row.threadId))throw new Error('Unrequested, duplicate or wrong-scope row');seen.add(row.threadId);
  if(!row.changed&&input.knownRevisions?.[row.threadId]!==row.revision)throw new Error('Unmatched unchanged revision');
  if(row.changed&&Object.values(row.windows).some(w=>w.amount===null)&&!row.approximation.reasons.includes('missing-price'))throw new Error('Unknown dollars require missing-price provenance');
  if(row.changed&&row.buckets){if(input.series?.activeThreadId!==row.threadId||row.buckets.length>input.series.maxPoints)throw new Error('Unrequested series');for(let i=0;i<row.buckets.length;i++){const b=row.buckets[i]!;if(b.amount===null&&!row.approximation.reasons.includes('missing-price'))throw new Error('Unknown bucket dollars require missing-price provenance');if(b.start%METRIC_BUCKET_MS!==0||b.start>row.asOf||b.start<retainedWindowStart(row.asOf,'h24')||(i>0&&b.start<=row.buckets[i-1]!.start))throw new Error('Invalid series range/order');}}
 }
 return out;
}
export function validateDetailResult(input:DetailInput,value:unknown):DetailResult{
 const out=parseBounded(detailResultSchema,value,LIMITS.outputBytes);
 if(out.total.amount===null&&!out.approximation.reasons.includes('missing-price'))throw new Error('Unknown total dollars require missing-price provenance');
 if(out.nextCursor&&out.coverage==='complete')throw new Error('Pagination must disclose incomplete coverage');
 if(out.threadId!==input.threadId||out.scope!==input.scope||out.axis!==input.axis||out.window!==input.window||out.rows.length>(input.limit??LIMITS.detailRows))throw new Error('Detail request mismatch');
 let priorEnd:number|undefined;
 const keys=new Set<string>();for(const row of out.rows){if(row.amount===null&&!row.approximation.reasons.includes('missing-price'))throw new Error('Unknown dollars require missing-price provenance');if(row.axis!==input.axis)throw new Error('Detail axis mismatch');
 if(row.axis==='time'){
  if(row.start<retainedWindowStart(out.asOf,input.window)||row.start>=out.asOf||row.end>out.asOf||row.start%METRIC_BUCKET_MS!==0||(row.end!==out.asOf&&row.end%METRIC_BUCKET_MS!==0)||(priorEnd!==undefined&&row.start<priorEnd))throw new Error('Invalid time detail range/order/overlap');
  priorEnd=row.end;
 }
 const key=row.axis==='model'?JSON.stringify([row.providerId,row.modelId]):String(row.start);if(keys.has(key))throw new Error('Duplicate detail row');keys.add(key);}
 if(out.coverage==='complete'&&!input.cursor&&!out.nextCursor){
  for(const key of ['inputUncached','cacheRead','cacheWrite','output'] as const){const sum=out.rows.reduce((n,r)=>n+r.tokens[key],0);if(!Number.isFinite(sum)||Math.abs(sum-out.total.tokens[key])>1e-8*Math.max(1,sum,out.total.tokens[key]))throw new Error('Detail token total mismatch');}
  const hasUnknown=out.rows.some(r=>r.amount===null);
  if(hasUnknown&&out.total.amount!==null)throw new Error('Unknown detail dollars must remain unknown');
  if(!hasUnknown){const sum=out.rows.reduce((n,r)=>n+(r.amount??0),0);if(out.total.amount===null||!Number.isFinite(sum)||Math.abs(sum-out.total.amount)>1e-8*Math.max(1,sum,out.total.amount))throw new Error('Detail dollar total mismatch');}
 }
 return out;
}
export type OwnerErrorKind='absent'|'disabled'|'timeout'|'aborted'|'malformed'|'failed';
export function classifyOwnerError(error:unknown):OwnerErrorKind{
 const e=error as {status?:number;code?:string;name?:string};
 if(e?.status===404||e?.code==='unknown_method')return 'absent';if(e?.status===503)return 'disabled';if(e?.name==='TimeoutError')return 'timeout';if(e?.name==='AbortError')return 'aborted';if(e?.name==='ZodError'||e?.name==='MetricsCodecError')return 'malformed';return 'failed';
}
