/** Pure V2 evidence wire. V1 schemas and projection meanings are independent. */
import { z } from 'zod';
import { ContextBundleV1Schema, SafeHrefSchema, CandidateV1Schema, SourceIdentitySchema } from '@phosphorco/bb-context-recognition';
import { canonicalizeIdentity, canonicalizeResource, hasSensitiveUrlParameter, utf8ByteLength } from './canonical.js';
import { VerifiedFileTargetSchema } from './recognition.js';
export const MENTION_V2_LIMITS = Object.freeze({responseBytes:1048576,inputBytes:65536,pageSize:100,cursorBytes:4096,
  excerptCodePoints:320,excerptBytes:1280,rowBytes:131072,readMs:2000,callMs:5000,lookupMs:1500,lookupCalls:8});
export const MENTION_V2_METHODS = Object.freeze({list:'crossReferencesV2ListMentions',resolve:'crossReferencesV2ResolveLookup'} as const);
const integer=()=>z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time=()=>integer().max(8640000000000000);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const text=(n:number)=>z.string().max(n).refine(v=>utf8ByteLength(v)<=n,'UTF8 byte bound exceeded.');
const id=z.string().min(1).max(256).refine(v=>!/[\p{Cc}]/u.test(v));
const producer=z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const keys=z.record(z.string(),z.string()).refine(v=>Object.keys(v).length<=16);
/** UTF16 offsets may address only complete code points. No normalization or
 * replacement: a genuine U+FFFD remains ordinary source text. */
export function isUtf16CodePointBoundary(text:string,offset:number):boolean {
 if(!Number.isSafeInteger(offset)||offset<0||offset>text.length)return false;
 const before=text.charCodeAt(offset-1),after=text.charCodeAt(offset);
 return !(before>=0xd800&&before<=0xdbff&&after>=0xdc00&&after<=0xdfff);
}
function wellFormedUtf16(text:string):boolean {
 for(const point of text){const value=point.codePointAt(0)!;if(value>=0xd800&&value<=0xdfff)return false;}
 return true;
}
const identityShape={provider:z.string().min(1).max(64),keys};
export const identityInputV2Schema=z.strictObject(identityShape).superRefine((v,c)=>{try{canonicalizeIdentity(v);}catch{c.addIssue({code:'custom',message:'Invalid resource identity.'});}});
const presentation=z.object({label:text(256).min(1),url:text(2048).optional(),detail:text(1024).optional()}).passthrough();
export const resourceOutputV2Schema=z.object({...identityShape,presentation}).passthrough().superRefine((v,c)=>{
  try{canonicalizeResource({provider:v.provider,keys:v.keys,presentation:{label:v.presentation.label,...(v.presentation.url===undefined?{}:{url:v.presentation.url}),...(v.presentation.detail===undefined?{}:{detail:v.presentation.detail})}});}catch{c.addIssue({code:'custom',message:'Invalid resource.'});}
});
export const safeAuthoredHrefSchema=SafeHrefSchema.refine(v=>utf8ByteLength(v)<=16384 && !hasSensitiveUrlParameter(new URL(v,'https://local.invalid')),'Unsafe destination.');
export const mentionQueryV2Schema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('resource'),target:identityInputV2Schema,relation:z.enum(['self','github-pr-family'])}).refine(v=>v.relation==='self'||(v.target.provider==='recognition'&&v.target.keys.provider==='github'&&/^[a-f0-9]{64}$/.test(v.target.keys.identity??'')),'Expected a GitHub root identity.'),
 z.strictObject({kind:z.literal('authored-url'),href:safeAuthoredHrefSchema}),
]);
export const listMentionsInputV2Schema=z.strictObject({version:z.literal(2),query:mentionQueryV2Schema,source:identityInputV2Schema.optional(),producerPluginId:producer.optional(),
 pageSize:z.number().int().min(1).max(100).optional(),cursor:text(4096).optional(),ifSnapshot:digest.optional()}).refine(v=>!(v.cursor!==undefined&&v.ifSnapshot!==undefined),'Cursor and conditional are exclusive.');
const spanShape={start:integer(),end:integer()};
export const spanOutputV2Schema=z.object(spanShape).passthrough().refine(v=>v.end>v.start);
const readyShape={state:z.literal('ready'),text:z.string().refine(wellFormedUtf16,'Excerpt text must be well-formed UTF16.').refine(v=>[...v].length<=320&&utf8ByteLength(v)<=1280),sourceSpan:spanOutputV2Schema,matchSpan:spanOutputV2Schema,
 clippedBefore:z.boolean(),clippedAfter:z.boolean(),matchClippedBefore:z.boolean(),matchClippedAfter:z.boolean(),codecVersion:z.literal(1)};
const readyCoordinates=(v:{text:string;sourceSpan:{start:number;end:number};matchSpan:{start:number;end:number}})=>
 v.matchSpan.end<=v.text.length&&v.sourceSpan.end-v.sourceSpan.start===v.text.length&&
 isUtf16CodePointBoundary(v.text,v.matchSpan.start)&&isUtf16CodePointBoundary(v.text,v.matchSpan.end);
export const excerptV2Schema=z.discriminatedUnion('state',[
 z.object(readyShape).passthrough().refine(readyCoordinates,'Excerpt bounds must be code-point aligned.'),
 z.object({state:z.literal('unavailable'),reason:z.enum(['not-materialized','indivisible-word','no-eligible-context']),codecVersion:z.literal(1)}).passthrough(),
]);
/** Strict internal record; the store validates binding to admitted source bytes. */
export const excerptRecordV2Schema=z.discriminatedUnion('state',[
 z.strictObject({...readyShape,sourceSpan:z.strictObject(spanShape).refine(v=>v.end>v.start),matchSpan:z.strictObject(spanShape).refine(v=>v.end>v.start)}).refine(readyCoordinates,'Excerpt bounds must be code-point aligned.'),
 z.strictObject({state:z.literal('unavailable'),reason:z.enum(['indivisible-word','no-eligible-context']),codecVersion:z.literal(1)}),
]);
export const locatorOutputV2Schema=z.object({kind:z.literal('conversation'),threadId:id,messageId:id,messageSeq:integer(),anchorSeq:integer().nullable(),role:z.enum(['user','assistant'])}).passthrough();
const recognitionProvenance=z.object({pluginId:id,origin:z.enum(['builtin','contributed']),confidence:CandidateV1Schema.shape.confidence,
 recognition:z.object({basis:z.enum(['explicit','text-url','existing-link','git-remote','context']),explanation:z.string().min(1).max(200),
 evidence:z.object({span:spanOutputV2Schema.optional(),link:integer().optional(),remote:id.optional()}).passthrough().optional()}).passthrough(),
 source:SourceIdentitySchema.passthrough(),authoredHref:safeAuthoredHrefSchema.optional(),verifiedFile:VerifiedFileTargetSchema.optional()}).passthrough();
// Verified-file output must tolerate additional fields without loosening the strict write DTO.
const verifiedFileOutput=z.union([
 z.object({kind:z.literal('workspace'),environmentId:id,path:z.string().min(1).max(4096)}).passthrough(),
 z.object({kind:z.literal('thread-storage'),threadId:id,path:z.string().min(1).max(4096)}).passthrough(),
]);
const provenanceOutput=recognitionProvenance.extend({verifiedFile:verifiedFileOutput.optional()});
const claimShape={source:resourceOutputV2Schema,target:resourceOutputV2Schema,producerPluginId:producer,graphRevision:integer(),
 cap:z.object({state:z.enum(['uncapped','capped','unknown']),limit:z.literal(100).nullable(),sourceHistoryUnknown:z.boolean().nullable()}).passthrough()};
const knownItem=z.discriminatedUnion('kind',[
 z.object({...claimShape,kind:z.literal('occurrence'),evidenceRevision:integer().min(1),occurrenceKey:digest,locator:locatorOutputV2Schema,sourceContentRevision:digest,span:spanOutputV2Schema,
 excerpt:excerptV2Schema,messageCreatedAt:time(),observedAt:time(),confirmation:z.enum(['observed','retained-unconfirmed']),provenance:provenanceOutput,authoredUrlState:z.enum(['exact','not-url','unknown'])}).passthrough(),
 z.object({...claimShape,kind:z.literal('claim-without-evidence'),reason:z.enum(['legacy','producer-no-evidence','not-yet-collected']),matchBasis:z.enum(['primary-resource','primary-url-identity'])}).passthrough(),
 z.object({...claimShape,kind:z.literal('unsupported'),reason:z.literal('unsupported-format')}).passthrough(),
]);
/** Future item/locator/excerpt enums occupy a slot; malformed known items still reject. */
export const mentionItemV2Schema=z.unknown().transform((raw,ctx)=>{
 const r=raw as Record<string,any>;
 const unknown=(value:unknown,known:readonly string[])=>typeof value==='string'&&!known.includes(value);
 const future=!!r&&typeof r==='object'&&(unknown(r.kind,['occurrence','claim-without-evidence','unsupported'])||
  (r.kind==='occurrence'&&(unknown(r.locator?.kind,['conversation'])||unknown(r.excerpt?.state,['ready','unavailable'])||(typeof r.excerpt?.codecVersion==='number'&&r.excerpt.codecVersion!==1)||unknown(r.confirmation,['observed','retained-unconfirmed'])||unknown(r.authoredUrlState,['exact','not-url','unknown'])||unknown(r.locator?.role,['user','assistant'])||unknown(r.provenance?.origin,['builtin','contributed'])||unknown(r.provenance?.confidence,['high','medium','low'])||unknown(r.provenance?.recognition?.basis,['explicit','text-url','existing-link','git-remote','context'])||(r.excerpt?.state==='unavailable'&&unknown(r.excerpt.reason,['not-materialized','indivisible-word','no-eligible-context']))))||
  (r.kind==='claim-without-evidence'&&(unknown(r.reason,['legacy','producer-no-evidence','not-yet-collected'])||unknown(r.matchBasis,['primary-resource','primary-url-identity'])))||unknown(r.cap?.state,['uncapped','capped','unknown']));
 if(future&&(!r.cap||!z.object({state:z.string(),limit:z.literal(100).nullable(),sourceHistoryUnknown:z.boolean().nullable()}).safeParse(r.cap).success)){
  ctx.addIssue({code:'custom',message:'Invalid required claim cap.'});return z.NEVER;
 }
 const candidate=future?{source:r.source,target:r.target,producerPluginId:r.producerPluginId,graphRevision:r.graphRevision,
  cap:{state:'unknown',limit:null,sourceHistoryUnknown:null},kind:'unsupported',reason:'unsupported-format'}:raw;
 const parsed=knownItem.safeParse(candidate);if(parsed.success)return parsed.data;
 ctx.addIssue({code:'custom',message:'Invalid mention item.'});return z.NEVER;
});
export const mentionCountsV2Schema=z.object({retainedOccurrences:integer(),confirmedOccurrences:integer(),unconfirmedOccurrences:integer(),producerClaims:integer(),indexedSources:integer(),claimsWithoutLocations:integer(),excerptUnavailable:integer()}).passthrough().refine(v=>v.confirmedOccurrences+v.unconfirmedOccurrences===v.retainedOccurrences&&v.claimsWithoutLocations<=v.producerClaims&&v.indexedSources<=v.producerClaims&&v.excerptUnavailable<=v.retainedOccurrences);
export const coverageV2Schema=z.object({scope:z.literal('known-sources'),collectionIncomplete:z.boolean(),retentionLimited:z.boolean(),capHistoryUnknown:z.boolean(),legacyClaimsPresent:z.boolean(),evidenceStateUnknown:z.boolean(),
 authoredUrlCoverage:z.object({state:z.enum(['complete-for-known-locations','partial']),unknownLocations:integer(),scope:z.literal('known-locations'),watermark:digest}).passthrough(),
 reasons:z.array(text(128)).max(32),reasonsClipped:z.boolean(),checkedAt:time().nullable()}).passthrough();
export const listMentionsOutputV2Schema=z.discriminatedUnion('status',[
 z.object({version:z.literal(2),status:z.literal('page'),snapshot:digest,items:z.array(mentionItemV2Schema).max(100),counts:mentionCountsV2Schema,coverage:coverageV2Schema,nextCursor:text(4096).nullable()}).passthrough(),
 z.object({version:z.literal(2),status:z.literal('not-modified'),snapshot:digest,coverage:coverageV2Schema}).passthrough(),
 z.object({version:z.literal(2),status:z.literal('restart'),reason:z.literal('snapshot-changed'),snapshot:digest}).passthrough(),
 z.object({version:z.literal(2),status:z.literal('unavailable'),reason:z.enum(['index-warming','read-budget']),retryable:z.boolean()}).passthrough(),
]);
export const lookupContextV2Schema=ContextBundleV1Schema.omit({consumer:true,links:true}).extend({links:z.array(z.strictObject({href:safeAuthoredHrefSchema})).max(16).optional()});
export const resolveLookupInputV2Schema=z.strictObject({version:z.literal(2),text:z.string().min(1).max(4096).refine(v=>utf8ByteLength(v)<=16384),mode:z.enum(['recognize','exact-url']),context:lookupContextV2Schema.optional()});
const identityOutput=z.object(identityShape).passthrough().superRefine((v,c)=>{try{canonicalizeIdentity({provider:v.provider,keys:v.keys});}catch{c.addIssue({code:'custom',message:'Invalid lookup identity.'});}});
const queryOutput=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('resource'),target:identityOutput,relation:z.enum(['self','github-pr-family'])}).passthrough(),
 z.object({kind:z.literal('authored-url'),href:safeAuthoredHrefSchema}).passthrough(),
]);
export const resolveLookupOutputV2Schema=z.object({version:z.literal(2),state:z.enum(['ready','ambiguous','unrecognized','incomplete']),
 options:z.array(z.object({query:queryOutput,label:text(256),inputSpan:spanOutputV2Schema,basis:z.enum(['supplier','native','stored-codec']),reasons:z.array(text(128)).max(16)}).passthrough()).max(8),reasons:z.array(text(128)).max(16)}).passthrough();
export const crossReferencesV2RpcSchemas={
 crossReferencesV2ListMentions:{input:listMentionsInputV2Schema,output:listMentionsOutputV2Schema},
 crossReferencesV2ResolveLookup:{input:resolveLookupInputV2Schema,output:resolveLookupOutputV2Schema},
} as const;
export const mentionsChangedV2Schema=z.object({version:z.literal(2),producerPluginId:producer,sourceIdentityDigest:digest,graphRevision:integer(),evidenceRevision:integer().nullable(),affectedIdentityDigests:z.array(digest).max(512),scopeListClipped:z.boolean()}).passthrough();
export const MENTIONS_V2_CHANNEL='cross-references-mentions-v2-changed';
export type MentionQueryV2=z.infer<typeof mentionQueryV2Schema>;
export type ListMentionsInputV2=z.infer<typeof listMentionsInputV2Schema>;
export type ListMentionsOutputV2=z.infer<typeof listMentionsOutputV2Schema>;
export type ResolveLookupInputV2=z.infer<typeof resolveLookupInputV2Schema>;
export type ResolveLookupOutputV2=z.infer<typeof resolveLookupOutputV2Schema>;
export type ExcerptRecordV2=z.infer<typeof excerptRecordV2Schema>;
export type ExcerptV2=z.infer<typeof excerptV2Schema>;
export type MentionsChangedV2=z.infer<typeof mentionsChangedV2Schema>;
