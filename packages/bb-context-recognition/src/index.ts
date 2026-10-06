/** Data-only wire contract and deterministic helpers. Root runtime dependency: Zod only. */
import { z } from 'zod';
export const LIMITS = Object.freeze({ plugins:32, concurrency:4, describeMs:500, discoveryMs:3000,
  linkifyMs:500, linkifyStageMs:1500, resolveMs:1500, resolveStageMs:4000, overallMs:6000,
  textChars:65536, windows:16, excludedRanges:512, links:64, remotes:8, candidatesPerCall:64,
  identitiesPerResolve:32, responseBytes:65536, explanationChars:200, excerptChars:1024,
  reasonCount:8, metaEntries:8, providersPerClaim:16, kindsPerProvider:16 } as const);
export const METHODS = Object.freeze({describe:'contextRecognitionDescribe',linkify:'contextRecognitionV1Linkify',resolve:'contextRecognitionV1Resolve'} as const);
export const WIRE_VERSIONS = Object.freeze([1] as const);
export const RESERVED_PROVIDER_PREFIX = 'bb.';
export const UnknownResultSchema = z.unknown();
const control = /\p{Cc}/u;
const identifier = () => z.string().min(1).max(256).refine(v=>!control.test(v),'Control characters are not allowed.');
export const ProviderSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}$/);
export const KindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const identityShape = {provider:ProviderSchema,id:z.string().min(1).max(2048).refine(v=>!control.test(v)),kind:KindSchema.optional()};
export const SourceIdentitySchema = z.object(identityShape);
const InputSourceIdentitySchema = z.strictObject(identityShape);
const spanShape = {start:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),end:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)};
export const SpanSchema = z.object(spanShape).refine(v=>v.start<v.end);
const InputSpanSchema = z.strictObject(spanShape).refine(v=>v.start<v.end);
export const SafeHrefSchema = z.string().min(1).max(4096).refine(v=>{
  if (/[\s\\\p{Cc}]/u.test(v)) return false;
  if (v.startsWith('/')) return !v.startsWith('//') && !/^\/%(?:2f|5c)/i.test(v);
  try {const u=new URL(v);return /^https?:\/\//i.test(v) && ['http:','https:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password;} catch{return false;}
},'Expected a credential-free HTTP(S) URL or root-relative route.');
const path = z.string().min(1).max(4096).refine(v=>!control.test(v));
export const FileTargetSchema = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('workspace'),environmentId:identifier(),path}),
  z.object({kind:z.literal('thread-storage'),threadId:identifier(),path}),
]);
export const REASON_CODES = Object.freeze(['not-found','forbidden','unauthenticated','rate-limited','timeout','source-error','unsupported','stale','informational'] as const);
export const ReasonCodeSchema = z.enum(REASON_CODES);
export const ReasonSchema = z.object({code:z.string().transform(v=>ReasonCodeSchema.safeParse(v).success?v as z.infer<typeof ReasonCodeSchema>:'source-error'),summary:z.string().max(512)});
export const ProviderClaimV1Schema = z.object({provider:ProviderSchema,kinds:z.array(KindSchema).min(1).max(LIMITS.kindsPerProvider),specificity:z.enum(['typed','generic']).default('typed')});
const ResolveProviderClaimV1Schema = z.object({provider:ProviderSchema,kinds:z.array(KindSchema).min(1).max(LIMITS.kindsPerProvider)});
const claims = <T extends z.ZodType<{provider:string}>>(s:T)=>z.array(s).min(1).max(LIMITS.providersPerClaim).refine(v=>new Set(v.map(x=>x.provider)).size===v.length,'Duplicate provider claims.');
export const CapabilitiesV1Schema = z.object({revision:z.string().min(1).max(64),
  linkify:z.object({providers:claims(ProviderClaimV1Schema)}).optional(),resolve:z.object({providers:claims(ResolveProviderClaimV1Schema)}).optional()
}).refine(v=>!!v.linkify||!!v.resolve,'At least one stage is required.');
export const DescribeEnvelopeSchema = z.object({protocol:z.literal('bb-context-recognition'),versions:z.array(z.number().int().min(1).max(1000)).min(1).max(16),capabilities:z.unknown()}).refine(v=>Object.hasOwn(v,'capabilities'),'Capabilities field is required.');
const consumerShape = {pluginId:identifier(),surface:identifier().optional()};
const locale = z.string().min(1).max(35).refine(v=>{try{return Intl.getCanonicalLocales(v).length===1;}catch{return false;}});
const timeZone = z.string().min(1).max(64).refine(v=>{if (/^[+-]|:/u.test(v)) return false;try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}});
const contextBaseShape = {consumer:z.strictObject(consumerShape),threadId:identifier().optional(),locale:locale.optional(),timeZone:timeZone.optional()};
export const ResolveContextV1Schema = z.strictObject(contextBaseShape);
// Remote syntax includes SCP-style SSH names. Credentials must already be stripped by the consumer.
const remoteUrl = z.string().min(1).max(4096).refine(v=>{
 if(control.test(v)||/\s/u.test(v))return false;
 if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {try{const u=new URL(v);return !u.username&&!u.password&&!/[?&](?:access_token|token|auth|password)=/i.test(u.search);}catch{return false;}}
 return !/[?&](?:access_token|token|auth|password)=/i.test(v);
});
export const ContextBundleV1Schema = z.strictObject({...contextBaseShape,projectId:identifier().optional(),environmentId:identifier().optional(),
 git:z.strictObject({branch:z.string().max(256).optional(),upstream:z.strictObject({remote:identifier(),branch:z.string().min(1).max(256)}).optional(),remotes:z.array(z.strictObject({name:identifier(),url:remoteUrl})).max(LIMITS.remotes)}).optional(),
 links:z.array(z.strictObject({href:SafeHrefSchema,span:InputSpanSchema.optional()})).max(LIMITS.links),
});
export const LinkifyInputV1Schema = z.strictObject({version:z.literal(1),text:z.string().max(LIMITS.textChars),format:z.enum(['markdown','plain']),excluded:z.array(InputSpanSchema).max(LIMITS.excludedRanges),context:ContextBundleV1Schema}).superRefine((v,ctx)=>{
 for(let i=0;i<v.excluded.length;i++){const s=v.excluded[i]!;if(s.end>v.text.length||(i>0&&v.excluded[i-1]!.end>s.start))ctx.addIssue({code:'custom',path:['excluded',i],message:'Excluded spans must be in text, sorted and non-overlapping.'});}
 for(let i=0;i<v.context.links.length;i++)if((v.context.links[i]!.span?.end??0)>v.text.length)ctx.addIssue({code:'custom',path:['context','links',i,'span'],message:'Link span is outside text.'});
});
export const CandidateV1Schema = z.object({span:SpanSchema,match:z.string().min(1).max(LIMITS.textChars),source:SourceIdentitySchema,confidence:z.enum(['high','medium','low']),
 provenance:z.object({basis:z.enum(['explicit','text-url','existing-link','git-remote','context']),explanation:z.string().min(1).max(LIMITS.explanationChars),evidence:z.object({span:SpanSchema.optional(),link:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),remote:identifier().optional()}).optional()})});
export const LinkifyOutputV1Schema = z.object({candidates:z.array(CandidateV1Schema).max(LIMITS.candidatesPerCall)});
export const CardV1Schema = z.object({title:z.string().min(1).max(256),subtitle:z.string().max(512).optional(),status:z.string().max(256).optional(),tone:z.enum(['neutral','info','success','warning','danger','muted']).optional(),meta:z.array(z.object({label:z.string().max(256),value:z.string().max(512)})).max(LIMITS.metaEntries).optional(),updatedAt:z.iso.datetime({offset:true}).max(128).optional(),excerptMarkdown:z.string().max(LIMITS.excerptChars).optional()});
export const ResolutionV1Schema = z.object({source:SourceIdentitySchema,state:z.enum(['ready','unrecognized','unavailable']),kind:KindSchema.optional(),revision:z.string().max(256).optional(),label:z.string().max(256).optional(),href:SafeHrefSchema.optional(),fileTarget:FileTargetSchema.optional(),card:CardV1Schema.optional(),maxAgeSeconds:z.number().min(0).max(3600).optional(),reasons:z.array(ReasonSchema).max(LIMITS.reasonCount)}).refine(v=>v.card===undefined||v.state==='ready','Only ready resolutions may contain cards.');
export const ResolveInputV1Schema = z.strictObject({version:z.literal(1),context:ResolveContextV1Schema,sources:z.array(InputSourceIdentitySchema).min(1).max(LIMITS.identitiesPerResolve),detail:z.enum(['label','card'])}).refine(v=>new Set(v.sources.map(identityKey)).size===v.sources.length,'Duplicate source identity.');
export const ResolveOutputV1Schema = z.object({resolutions:z.array(ResolutionV1Schema).max(LIMITS.identitiesPerResolve)});
export type SourceIdentity=z.infer<typeof SourceIdentitySchema>;
export type Span=z.infer<typeof SpanSchema>;
export type SafeHref=z.infer<typeof SafeHrefSchema>;
export type FileTarget=z.infer<typeof FileTargetSchema>;
export type Reason=z.infer<typeof ReasonSchema>;
export type ProviderClaimV1=z.input<typeof ProviderClaimV1Schema>;
export type CapabilitiesV1=z.infer<typeof CapabilitiesV1Schema>;
export type DescribeEnvelope=z.infer<typeof DescribeEnvelopeSchema>;
export type ContextBundleV1=z.infer<typeof ContextBundleV1Schema>;
export type ResolveContextV1=z.infer<typeof ResolveContextV1Schema>;
export type LinkifyInputV1=z.infer<typeof LinkifyInputV1Schema>;
export type CandidateV1=z.infer<typeof CandidateV1Schema>;
export type LinkifyOutputV1=z.infer<typeof LinkifyOutputV1Schema>;
export type CardV1=z.infer<typeof CardV1Schema>;
export type ResolutionV1=z.infer<typeof ResolutionV1Schema>;
export type ResolveInputV1=z.infer<typeof ResolveInputV1Schema>;
export type ResolveOutputV1=z.infer<typeof ResolveOutputV1Schema>;
export type JsonValue = null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
/** Canonical JSON: recursively UTF-16 sorted object keys, array order retained; rejects non-JSON values. */
export function canonicalJson(value:unknown):string {
 const seen=new Set<object>();
 function encode(v:unknown):string {
  if(v===null||typeof v==='boolean'||typeof v==='string')return JSON.stringify(v);
  if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(typeof v!=='object'||v===null)throw new TypeError('Expected a JSON value.');
  if(seen.has(v))throw new TypeError('Cyclic JSON value.');
  seen.add(v);
  try {
   if(Array.isArray(v)){const items=[];for(let i=0;i<v.length;i++){if(!Object.hasOwn(v,i))throw new TypeError('Sparse JSON array.');items.push(encode(v[i]));}return '['+items.join(',')+']';}
   const prototype=Object.getPrototypeOf(v);if(prototype!==Object.prototype&&prototype!==null)throw new TypeError('Expected a plain JSON object.');
   return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode((v as Record<string,unknown>)[k])).join(',')+'}';
  } finally {seen.delete(v);}
 }
 return encode(value);
}
export function identityKey(source:Pick<SourceIdentity,'provider'|'id'>):string {return canonicalJson([source.provider,source.id]);}
export type VersionNegotiation = {state:'ready';version:1;capabilities:CapabilitiesV1}|{state:'incompatible';reason:'schema'|'version'};
export function negotiateVersion(value:unknown,local:readonly number[]=WIRE_VERSIONS):VersionNegotiation {
 const env=DescribeEnvelopeSchema.safeParse(value);if(!env.success)return {state:'incompatible',reason:'schema'};
 const version=env.data.versions.filter(v=>local.includes(v)).sort((a,b)=>b-a)[0];
 if(version===undefined||version!==1)return {state:'incompatible',reason:'version'};
 const cap=CapabilitiesV1Schema.safeParse(env.data.capabilities);
 return cap.success?{state:'ready',version,capabilities:cap.data}:{state:'incompatible',reason:'schema'};
}
export interface CandidateCheckContext {text:string;excluded:readonly Span[];providers?:readonly string[];context?:ContextBundleV1}
export function checkCandidate(candidate:unknown,options:CandidateCheckContext):{valid:boolean;reason?:string} {
 const decoded=CandidateV1Schema.safeParse(candidate);if(!decoded.success)return {valid:false,reason:'schema'};
 const c=decoded.data;
 if(c.span.end>options.text.length||options.text.slice(c.span.start,c.span.end)!==c.match)return {valid:false,reason:'span'};
 if(options.excluded.some(e=>overlaps(c.span,e)))return {valid:false,reason:'excluded'};
 if(options.providers&&!options.providers.includes(c.source.provider))return {valid:false,reason:'unadvertised'};
 const evidence=c.provenance.evidence;
 if(evidence?.span&&evidence.span.end>options.text.length)return {valid:false,reason:'evidence-span'};
 if(options.context&&evidence?.link!==undefined&&evidence.link>=options.context.links.length)return {valid:false,reason:'evidence-link'};
 if(options.context&&evidence?.remote!==undefined&&!options.context.git?.remotes.some(r=>r.name===evidence.remote))return {valid:false,reason:'evidence-remote'};
 return {valid:true};
}
function overlaps(a:Span,b:Span):boolean{return a.start<b.end&&b.start<a.end;}
/** Distance between spans; ties prefer the preceding span, then UTF-16 offsets. */
export function nearestSpan<T extends Span>(target:Span,spans:readonly T[]):T|undefined {
 const distance=(s:Span)=>Math.max(0,target.start-s.end,s.start-target.end);
 return [...spans].sort((a,b)=>distance(a)-distance(b)||Number(b.end<=target.start)-Number(a.end<=target.start)||a.start-b.start||a.end-b.end)[0];
}
export interface TaggedCandidateV1 {candidate:CandidateV1;origin:'builtin'|'contributed';pluginId:string;specificity:'typed'|'generic';providers:readonly string[]}
export interface RankedCandidateV1 extends TaggedCandidateV1 {alsoBy:string[]}
export interface ArbitrationOccurrenceV1 extends RankedCandidateV1 {fallback?:RankedCandidateV1}
export interface ArbitrationResultV1 {occurrences:ArbitrationOccurrenceV1[];identities:SourceIdentity[];dropped:Record<string,number>}
const compareText=(a:string,b:string)=>a<b?-1:a>b?1:0;
function rank(a:TaggedCandidateV1,b:TaggedCandidateV1):number {
 const c=a.candidate,d=b.candidate;
 return (d.span.end-d.span.start)-(c.span.end-c.span.start)||Number(d.provenance.basis==='explicit')-Number(c.provenance.basis==='explicit')||Number(b.specificity==='typed')-Number(a.specificity==='typed')||({high:0,medium:1,low:2}[c.confidence]-{high:0,medium:1,low:2}[d.confidence])||c.span.start-d.span.start||Number(b.origin==='builtin')-Number(a.origin==='builtin')||compareText(a.pluginId,b.pluginId)||compareText(c.source.provider,d.source.provider)||compareText(c.source.id,d.source.id);
}
export function arbitrate(tagged:readonly TaggedCandidateV1[],options:{text:string;excluded:readonly Span[];implementedProviders?:readonly string[]}):ArbitrationResultV1 {
 const dropped:Record<string,number>=Object.create(null) as Record<string,number>;
 const reserved=new Set([...(options.implementedProviders??[]),...tagged.filter(t=>t.origin==='builtin').flatMap(t=>t.providers)].filter(p=>p.startsWith(RESERVED_PROVIDER_PREFIX)));
 const valid:TaggedCandidateV1[]=[];
 for(const t of tagged){if(!checkCandidate(t.candidate,{...options,providers:t.providers}).valid||(t.origin==='contributed'&&reserved.has(t.candidate.source.provider))){dropped[t.pluginId]=(dropped[t.pluginId]??0)+1;}else valid.push(t);}
 const merged=new Map<string,RankedCandidateV1>();
 for(const t of valid.sort(rank)){
  const key=canonicalJson([t.candidate.span.start,t.candidate.span.end,identityKey(t.candidate.source)]),old=merged.get(key);
  if(!old)merged.set(key,{...t,alsoBy:[]});else if(t.pluginId!==old.pluginId&&!old.alsoBy.includes(t.pluginId))old.alsoBy.push(t.pluginId);
 }
 const accepted:ArbitrationOccurrenceV1[]=[],rejected:RankedCandidateV1[]=[];
 for(const t of [...merged.values()].sort(rank)){if(accepted.some(a=>overlaps(a.candidate.span,t.candidate.span)))rejected.push(t);else accepted.push(t);}
 for(const a of accepted){a.alsoBy.sort(compareText);const f=rejected.find(t=>t.candidate.span.start===a.candidate.span.start&&t.candidate.span.end===a.candidate.span.end&&identityKey(t.candidate.source)!==identityKey(a.candidate.source));if(f)a.fallback={...f,alsoBy:[...f.alsoBy].sort(compareText)};}
 accepted.sort((a,b)=>a.candidate.span.start-b.candidate.span.start||a.candidate.span.end-b.candidate.span.end);
 const identities:SourceIdentity[]=[],keys=new Set<string>();
 for(const a of accepted)for(const c of [a.candidate,a.fallback?.candidate])if(c&&!keys.has(identityKey(c.source))){keys.add(identityKey(c.source));identities.push(c.source);}
 return {occurrences:accepted,identities,dropped};
}
