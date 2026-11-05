/** Pure producer protocol and display policy. No SDK, React, storage or source I/O. */
import { z } from 'zod';
import { canonicalJson, SafeHrefSchema, SourceIdentitySchema } from '@phosphorco/bb-context-recognition';
import { canonicalizeIdentity, canonicalizeResource, hasSensitiveUrlParameter, sha256Hex, utf8ByteLength,
 type ResourceIdentity, type Presentation } from './canonical.js';
import type { ApplyProjectionInput } from './index.js';
import { VerifiedFileTargetSchema, verifiedFileIdentity, recognitionIdentity } from './recognition.js';

export const PRODUCER_METHODS = Object.freeze({describe:'crossReferencesProducer.describe',getState:'crossReferencesProducerV1GetState',apply:'crossReferencesProducerV1Apply',reportStatus:'crossReferencesProducerV1ReportStatus'} as const);
export const BRIEF_NAVIGATION_METHODS = Object.freeze({describe:'threadBriefNavigation.describe',resolve:'threadBriefNavigationV1ResolveHeading'} as const);
export const BRIEF_LIMITS = Object.freeze({inputBytes:1048576,statusBytes:16384,responseBytes:1048576,locations:512,perTarget:100,headingBytes:256,describeMs:1000,callMs:5000,readMs:2000,navigationInputBytes:8192,navigationOutputBytes:16384});
export const DISPLAY_POLICY_LIMITS = Object.freeze({valueChars:1048576,valueBytes:1048576,fields:8192,distinct:4096,sourceBytes:2097152,work:8388608,views:4,tokens:128,tokenChars:4096,tokenBytes:16384});
export const BRIEF_LIMIT_CODES = ['target-count','projection-bytes','occurrence-count','per-target-occurrences','heading-bytes','envelope-bytes','presentation-label-bytes','presentation-detail-bytes','presentation-url-bytes','presentation-bytes'] as const;
export type BriefLimitCode = typeof BRIEF_LIMIT_CODES[number];
export type DisplayRoleV1 = 'heading'|'source-label'|'target-label'|'detail'|'presentation-href'|'provenance'|'codec'|'authored-url'|'required-identity';
export type DisplayFieldKeyV1 = readonly number[];
export type DisplayFieldV1 = {key:DisplayFieldKeyV1;role:DisplayRoleV1;value:string};
export type UnsafeReasonV1 = 'url-credentials'|'sensitive-url-parameter'|'credential-shaped-token'|'unsafe-url-form';
export type IncompleteReasonV1 = 'ill-formed-unicode'|'control-character'|'input-limit'|'field-limit'|'source-work-limit'|'token-limit'|'encoding-limit'|'encoding-ambiguity';
export type DisplayClassificationV1 = {version:1;workUnits:number;decodedViews:number}&(
 {state:'safe';coverage:'complete'}|{state:'unsafe';coverage:'complete-for-hit';reason:UnsafeReasonV1}|{state:'unclassified';coverage:'incomplete';reason:IncompleteReasonV1});
export type DisplayFieldResultsV1 = {version:1;state:'classified';results:{key:DisplayFieldKeyV1;result:DisplayClassificationV1}[];usage:{distinctValues:number;originalUtf8Bytes:number;workUnits:number};complete:boolean}
 |{version:1;state:'unclassified';reason:'field-limit';results:[];usage:{distinctValues:0;originalUtf8Bytes:0;workUnits:0};complete:false};
const roles:readonly DisplayRoleV1[]=['heading','source-label','target-label','detail','presentation-href','provenance','codec','authored-url','required-identity'];
function wellFormed(s:string){for(const c of s){const n=c.codePointAt(0)!;if(n>=0xd800&&n<=0xdfff)return false;}return true;}
function control(s:string){for(const c of s){const n=c.codePointAt(0)!;if(n<32||n>=127&&n<=159)return true;}return false;}
const space=(c:string)=>c.trim()==='';
class PolicyStop {constructor(readonly reason:IncompleteReasonV1){}}
class PolicyHit {constructor(readonly reason:UnsafeReasonV1){}}
type Meter={work:number};
function charge(m:Meter,n:number){if(n<0||m.work+n>DISPLAY_POLICY_LIMITS.work)throw new PolicyStop('source-work-limit');m.work+=n;}
const entities:Readonly<Record<string,string>>={amp:'&',colon:':',sol:'/',bsol:'\\',quest:'?',num:'#',percnt:'%',equals:'=',commat:'@',semi:';',Tab:'\t',NewLine:'\n'};
/** Security views only: never substitute this text into presentation or identity. */
function decodeView(s:string,m:Meter):{text:string;changed:boolean}{
 charge(m,s.length*2);const out:string[]=[];let changed=false;
 for(let i=0;i<s.length;){const c=s[i]!;
  if(c==='%'&&/[0-9a-f]/i.test(s[i+1]??'')){
   const bytes:number[]=[];
   while(s[i]==='%') {const h=s.slice(i+1,i+3);if(h.length!==2||!/^[0-9a-f]{2}$/i.test(h))throw new PolicyStop('encoding-ambiguity');bytes.push(parseInt(h,16));i+=3;}
   try{out.push(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes)));}catch{throw new PolicyStop('encoding-ambiguity');}changed=true;continue;
  }
  if(c==='\\'){
   const n=s[i+1];if(n==='u'){
    const h=s.slice(i+2,i+6);if(!/^[0-9a-f]{4}$/i.test(h))throw new PolicyStop('encoding-ambiguity');let value=String.fromCharCode(parseInt(h,16));i+=6;
    if(value.charCodeAt(0)>=0xd800&&value.charCodeAt(0)<=0xdbff){if(s.slice(i,i+2)!=='\\u'||!/^[0-9a-f]{4}$/i.test(s.slice(i+2,i+6)))throw new PolicyStop('encoding-ambiguity');value+=String.fromCharCode(parseInt(s.slice(i+2,i+6),16));i+=6;}
    if(!wellFormed(value))throw new PolicyStop('encoding-ambiguity');out.push(value);changed=true;continue;
   }
   const escape:Readonly<Record<string,string>>={'/':'/','\\':'\\','"':'"',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'};
   if(n===undefined||escape[n]===undefined)throw new PolicyStop('encoding-ambiguity');out.push(escape[n]!);i+=2;changed=true;continue;
  }
  if(c==='&'&&(/[A-Za-z0-9_#]/.test(s[i+1]??''))){
   let j=i+1;while(j<s.length&&j-i<=32&&!space(s[j]!)&&s[j]!==';'&&s[j]!=='&')j++;
   if(s[j]===';'){
    const name=s.slice(i+1,j);let decoded:string|undefined;
    if(name.startsWith('#')){const hex=name[1]?.toLowerCase()==='x',digits=name.slice(hex?2:1);if(!(hex?/^[a-f0-9]+$/i:/^[0-9]+$/).test(digits))throw new PolicyStop('encoding-ambiguity');const cp=parseInt(digits,hex?16:10);if(cp>0x10ffff||cp>=0xd800&&cp<=0xdfff)throw new PolicyStop('encoding-ambiguity');decoded=String.fromCodePoint(cp);}
    else decoded=Object.hasOwn(entities,name)?entities[name]:undefined;
    if(decoded===undefined)throw new PolicyStop('encoding-ambiguity');out.push(decoded);i=j+1;changed=true;continue;
   }
   // A plain ampersand/query separator is not an entity. Partial KNOWN
   // names/prefixes and a bounded-out encoding cannot certify full coverage.
   const partial=s.slice(i+1,j);
   if(s[i+1]==='#'||j-i>32||!partial.includes('=')&&Object.keys(entities).some(name=>name.startsWith(partial)||partial.startsWith(name)))throw new PolicyStop('encoding-ambiguity');
  }
  out.push(c);i++;
 }
 return {text:out.join(''),changed};
}
function scanPolicy(s:string,m:Meter,tokens:{count:number}){
 charge(m,s.length*4);
 const token=(value:string)=>{if(++tokens.count>DISPLAY_POLICY_LIMITS.tokens)throw new PolicyStop('token-limit');if(value.length>DISPLAY_POLICY_LIMITS.tokenChars)throw new PolicyStop('token-limit');charge(m,value.length*2);if(utf8ByteLength(value)>DISPLAY_POLICY_LIMITS.tokenBytes)throw new PolicyStop('token-limit');};
 const url=(value:string)=>{token(value);let u:URL;try{u=new URL(value,'https://display-policy.invalid');}catch{throw new PolicyStop('encoding-ambiguity');}
  if(u.username||u.password)throw new PolicyHit('url-credentials');if(hasSensitiveUrlParameter(u))throw new PolicyHit('sensitive-url-parameter');if(!SafeHrefSchema.safeParse(value).success)throw new PolicyHit('unsafe-url-form');};
 for(let at=0;at<s.length;){while(at<s.length&&space(s[at]!))at++;const start=at;while(at<s.length&&!space(s[at]!))at++;const run=s.slice(start,at);if(!run)continue;
  let hasScheme=false;for(let i=0;i<run.length;i++){
   const tail=run.slice(i,i+8).toLowerCase();if(tail.startsWith('http://')||tail.startsWith('https://')){hasScheme=true;if(run.length-i>DISPLAY_POLICY_LIMITS.tokenChars)throw new PolicyStop('token-limit');url(run.slice(i));}
   else if(run[i]===':'&&run.slice(i+1,i+3)==='//'&&i>0&&!run.slice(Math.max(0,i-5),i).toLowerCase().endsWith('http')&&!run.slice(Math.max(0,i-5),i).toLowerCase().endsWith('https'))throw new PolicyHit('unsafe-url-form');
  }
  if(!hasScheme){const slash=run.indexOf('/');if(slash>=0){if(run.length-slash>DISPLAY_POLICY_LIMITS.tokenChars)throw new PolicyStop('token-limit');url(run.slice(slash));}}
  for(let i=0;i<run.length;i++)if(run[i]==='='){
   let begin=i;while(begin>0&&/[A-Za-z0-9_%.-]/.test(run[begin-1]!))begin--;const name=run.slice(begin,i);if(!name)continue;token(name);
   const u=new URL('https://display-policy.invalid');u.search='?'+name+'=value';if(hasSensitiveUrlParameter(u))throw new PolicyHit('credential-shaped-token');
  }
 }
}
function classify(value:string,m:Meter):DisplayClassificationV1 {
 const before=m.work;let views=0;const tokens={count:0};
 const result=(extra:{state:'safe';coverage:'complete'}|{state:'unsafe';coverage:'complete-for-hit';reason:UnsafeReasonV1}|{state:'unclassified';coverage:'incomplete';reason:IncompleteReasonV1}):DisplayClassificationV1=>({version:1,workUnits:m.work-before,decodedViews:views,...extra});
 try{
  if(value.length>DISPLAY_POLICY_LIMITS.valueChars)throw new PolicyStop('input-limit');charge(m,value.length*3);if(!wellFormed(value))throw new PolicyStop('ill-formed-unicode');if(utf8ByteLength(value)>DISPLAY_POLICY_LIMITS.valueBytes)throw new PolicyStop('input-limit');
  let current=value;for(let i=0;i<DISPLAY_POLICY_LIMITS.views;i++){
   views++;if(control(current))throw new PolicyStop('control-character');scanPolicy(current,m,tokens);const decoded=decodeView(current,m);if(!decoded.changed)return result({state:'safe',coverage:'complete'});
   if(i===DISPLAY_POLICY_LIMITS.views-1)throw new PolicyStop('encoding-limit');current=decoded.text;
  }
  throw new PolicyStop('encoding-limit');
 }catch(e){if(e instanceof PolicyHit)return result({state:'unsafe',coverage:'complete-for-hit',reason:e.reason});if(e instanceof PolicyStop)return result({state:'unclassified',coverage:'incomplete',reason:e.reason});throw e;}
}
export function classifyBriefDisplayTextV1(value:string):DisplayClassificationV1 {if(typeof value!=='string')throw new Error('Invalid display-policy argument.');return classify(value,{work:0});}
export function classifyBriefDisplayFieldsV1(fields:readonly DisplayFieldV1[]):DisplayFieldResultsV1 {
 if(!Array.isArray(fields)||fields.length>DISPLAY_POLICY_LIMITS.fields)return {version:1,state:'unclassified',reason:'field-limit',results:[],usage:{distinctValues:0,originalUtf8Bytes:0,workUnits:0},complete:false};
 for(const f of fields)if(!f||!Array.isArray(f.key)||f.key.length>8||f.key.some((n:unknown)=>typeof n!=='number'||!Number.isSafeInteger(n)||n<0||n>8191)||!roles.includes(f.role)||typeof f.value!=='string')throw new Error('Invalid display-policy field.');
 const ordered=fields.map((f,i)=>({f,i})).sort((a,b)=>Number(b.f.role==='required-identity')-Number(a.f.role==='required-identity')||compareNumbers(a.f.key,b.f.key)||a.i-b.i);
 const meter={work:0},cache=new Map<string,DisplayClassificationV1>(),results:DisplayFieldResultsV1 & {state:'classified'}={version:1,state:'classified',results:[],usage:{distinctValues:0,originalUtf8Bytes:0,workUnits:0},complete:true};
 for(const {f,i} of ordered){let r=cache.get(f.value);if(!r){
   const incomplete=(reason:IncompleteReasonV1):DisplayClassificationV1=>({version:1,state:'unclassified',coverage:'incomplete',reason,workUnits:0,decodedViews:0});
   if(cache.size>=DISPLAY_POLICY_LIMITS.distinct)r=incomplete('field-limit');
   else {try{
     if(f.value.length>DISPLAY_POLICY_LIMITS.valueChars)r=incomplete('input-limit');
     else {charge(meter,f.value.length);const bytes=utf8ByteLength(f.value);
       if(results.usage.originalUtf8Bytes+bytes>DISPLAY_POLICY_LIMITS.sourceBytes)r=incomplete('source-work-limit');
       else {results.usage.originalUtf8Bytes+=bytes;r=classify(f.value,meter);}}
    }catch(e){if(e instanceof PolicyStop)r=incomplete(e.reason);else throw e;}
    cache.set(f.value,r);
   }
  }
  results.results[i]={key:f.key,result:r};if(r.state!=='safe')results.complete=false;
 }
 results.usage.distinctValues=cache.size;results.usage.workUnits=meter.work;return results;
}
function compareNumbers(a:readonly number[],b:readonly number[]){for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]!-b[i]!;return a.length-b.length;}

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),positive=integer.min(1),digest=z.string().regex(/^[a-f0-9]{64}$/);
const bytes=(n:number)=>z.string().refine(wellFormed,'Malformed Unicode.').refine(v=>utf8ByteLength(v)<=n,'Text byte bound exceeded.');
const plugin=z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const identity=z.strictObject({provider:z.string(),keys:z.record(z.string(),z.string())}).superRefine((v,c)=>{try{canonicalizeIdentity(v);}catch{c.addIssue({code:'custom',message:'Invalid resource identity.'});}});
export const briefFileSchema=z.strictObject({kind:z.literal('thread-storage'),threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),path:z.literal('BRIEF.md')});
const safeHref=SafeHrefSchema.refine(v=>utf8ByteLength(v)<=16384&&!hasSensitiveUrlParameter(new URL(v,'https://display-policy.invalid')),'Unsafe URL.');
const cause=z.enum(['policy','unclassified']);
const withheld=<T extends string>(display:T)=>z.strictObject({state:z.literal('withheld'),digest,display:z.literal(display),cause});
export const briefHeadingSchema=z.union([z.null(),z.strictObject({state:z.literal('named'),text:bytes(256)}),withheld('Heading withheld')]);
const labelText=bytes(256).refine(v=>!control(v)&&v.trim().length>0,'Invalid label.');
export const briefSourceLabelSchema=z.union([z.strictObject({state:z.literal('safe'),text:labelText}),withheld('Brief')]);
export const briefTargetLabelSchema=z.union([z.strictObject({state:z.literal('safe'),text:labelText}),withheld('Reference')]);
const detail=z.union([z.null(),z.strictObject({state:z.literal('safe'),text:bytes(1024).refine(v=>!control(v)&&v.trim().length>0)}),withheld('Details withheld')]);
const presentationHref=z.union([z.strictObject({state:z.literal('absent')}),z.strictObject({state:z.literal('exact'),href:safeHref.refine(v=>utf8ByteLength(v)<=2048&&!control(v)&&v.trim().length>0)}),withheld('Destination withheld')]);
const presentation=<S extends z.ZodType>(label:S)=>z.strictObject({label,detail,url:presentationHref});
export const briefSourcePresentationSchema=presentation(briefSourceLabelSchema),briefTargetPresentationSchema=presentation(briefTargetLabelSchema);
const span=z.strictObject({start:integer,end:positive}).refine(v=>v.end>v.start);
const provenanceValue=z.strictObject({pluginId:plugin,origin:z.enum(['builtin','contributed']),confidence:z.enum(['high','medium','low']),
 recognition:z.strictObject({basis:z.enum(['explicit','text-url','existing-link','git-remote','context']),explanation:bytes(1024).min(1),evidence:z.strictObject({span:span.optional(),link:integer.optional(),remote:bytes(1024).optional()}).optional()}),
 source:SourceIdentitySchema.strict(),authoredHref:safeHref.optional(),verifiedFile:VerifiedFileTargetSchema.optional()});
const provenanceSummary=z.strictObject({pluginId:plugin,origin:z.enum(['builtin','contributed']),confidence:z.enum(['high','medium','low']),basis:z.enum(['explicit','text-url','existing-link','git-remote','context'])});
export const briefProvenanceSchema=z.union([z.strictObject({state:z.literal('safe'),value:provenanceValue}),withheld('Recognition details withheld').extend({summary:provenanceSummary})]);
const codecProof=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('recognition'),source:SourceIdentitySchema.strict()}),
 z.strictObject({kind:z.literal('thread'),source:SourceIdentitySchema.strict(),verified:z.strictObject({id:z.string(),projectId:z.string()})}),
 z.strictObject({kind:z.literal('file'),verified:VerifiedFileTargetSchema}),
 z.strictObject({kind:z.literal('url'),href:safeHref}),
]);
const codec=z.union([z.strictObject({state:z.literal('available'),value:codecProof}),withheld('Identity metadata withheld')]);
export const briefAuthoredUrlSchema=z.union([z.strictObject({state:z.literal('exact'),href:safeHref}),z.strictObject({state:z.literal('not-url')}),z.strictObject({state:z.literal('unknown')}),withheld('Destination withheld')]);
export const briefFrameSchema=z.strictObject({codec:z.literal('utf8-fatal-bom-consumed-v1'),rawBytes:integer.max(1048576),bomBytes:z.union([z.literal(0),z.literal(3)]),fileUtf16Length:integer.max(1048576),
 bodyBase:z.strictObject({startUtf16:integer,startLine:positive,utf16Length:integer}),lineMapping:z.strictObject({codec:z.literal('native-file-lines-v1'),fileLineCount:positive})}).superRefine((v,c)=>{
 if(v.rawBytes<v.bomBytes||v.bodyBase.startUtf16+v.bodyBase.utf16Length>v.fileUtf16Length||v.bodyBase.startLine>v.lineMapping.fileLineCount)c.addIssue({code:'custom',message:'Invalid source frame.'});
});
export const briefLocatorSchema=z.strictObject({kind:z.literal('thread-brief'),threadId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),file:briefFileSchema,sourceContentRevision:digest,
 section:z.strictObject({heading:briefHeadingSchema,line:positive}),location:z.strictObject({kind:z.literal('line'),line:positive,column:positive.nullable(),endLine:positive.nullable()}),
 span:z.strictObject({frame:z.enum(['file-utf16','body-utf16']),start:integer,end:positive}).refine(v=>v.end>v.start).optional()});
export const briefOccurrenceSchema=z.strictObject({occurrenceKey:digest,sourceOccurrenceId:bytes(256).regex(/^ref-(0|[1-9]\d{0,2})$/).refine(v=>Number(v.slice(4))<512),target:identity,locator:briefLocatorSchema,provenance:briefProvenanceSchema,authoredUrl:briefAuthoredUrlSchema});
export const briefTargetDescriptorSchema=z.strictObject({target:identity,presentation:briefTargetPresentationSchema,codec});
export const briefEvidenceSchema=z.strictObject({kind:z.literal('thread-brief'),sourceFile:briefFileSchema,sourceState:z.enum(['present','absent','empty']),sourceContentRevision:digest.nullable(),
 completeness:z.strictObject({state:z.literal('complete'),codecVersion:z.literal(1)}),metadataPolicyVersion:z.literal(1),frame:briefFrameSchema.nullable(),sourcePresentation:briefSourcePresentationSchema,
 targetDescriptors:z.array(briefTargetDescriptorSchema).max(256),occurrences:z.array(briefOccurrenceSchema).max(512)});
export type BriefHeadingV1=z.infer<typeof briefHeadingSchema>;
export type BriefFrameV1=z.infer<typeof briefFrameSchema>;
export type BriefOccurrenceV1=z.infer<typeof briefOccurrenceSchema>;
export type BriefEvidenceV1=z.infer<typeof briefEvidenceSchema>;
export type BriefTargetDescriptorV1=z.infer<typeof briefTargetDescriptorSchema>;
export type BriefAuthoredUrlV1=z.infer<typeof briefAuthoredUrlSchema>;
export type BriefProvenanceV1=z.infer<typeof briefProvenanceSchema>;
export type BriefFileV1=z.infer<typeof briefFileSchema>;
export type BriefPresentationV1=z.infer<typeof briefSourcePresentationSchema>|z.infer<typeof briefTargetPresentationSchema>;
export function briefWithheldDigest(role:DisplayRoleV1,original:unknown):string {if(!roles.includes(role))throw new Error('Invalid withheld role.');return sha256Hex(canonicalJson(['brief-withheld',1,role,original]));}
export function briefOccurrenceKey(rawRevision:string,target:ResourceIdentity,locator:BriefOccurrenceV1['locator'],sourceOccurrenceId:string):string {return sha256Hex(canonicalJson(['brief-occurrence',1,rawRevision,identityValue(target),locator,sourceOccurrenceId]));}
function identityValue(v:ResourceIdentity){const c=canonicalizeIdentity(v);return {provider:c.provider,keys:c.keys};}
export function briefEvidenceDigest(input:BriefEvidenceV1):string {
 const e=briefEvidenceSchema.parse(input);return sha256Hex(canonicalJson(['brief-evidence',1,{...e,targetDescriptors:e.targetDescriptors.map(d=>({...d,target:identityValue(d.target)})).sort((a,b)=>canonicalJson(a.target)<canonicalJson(b.target)?-1:canonicalJson(a.target)>canonicalJson(b.target)?1:0),
 occurrences:e.occurrences.map(o=>({...o,target:identityValue(o.target)})).sort((a,b)=>a.occurrenceKey<b.occurrenceKey?-1:a.occurrenceKey>b.occurrenceKey?1:0)}]));
}
export function briefPresentation(p:BriefPresentationV1):Presentation {return {label:p.label.state==='safe'?p.label.text:p.label.display,...(p.detail?.state==='safe'?{detail:p.detail.text}:{}),...(p.url.state==='exact'?{url:p.url.href}:{})};}
/** Size diagnosis is distinct from malformed known fields. Never rewrite a safe oversized value. */
export function briefApplyLimitCodes(input:ProducerApplyInput):BriefLimitCode[] {
 const codes=new Set<BriefLimitCode>();const e=input.evidence,p=input.projection;
 if(utf8ByteLength(JSON.stringify(input))>BRIEF_LIMITS.inputBytes)codes.add('envelope-bytes');
 if(p.targets.length>256)codes.add('target-count');if(e.occurrences.length>512)codes.add('occurrence-count');
 const per=new Map<string,number>();for(const o of e.occurrences){const k=canonicalJson(o.target);per.set(k,(per.get(k)??0)+1);if(o.locator.section.heading?.state==='named'&&utf8ByteLength(o.locator.section.heading.text)>256)codes.add('heading-bytes');}
 if([...per.values()].some(n=>n>100))codes.add('per-target-occurrences');
 for(const witness of [e.sourcePresentation,...e.targetDescriptors.map(d=>d.presentation)]){const v=briefPresentation(witness);if(witness.label.state==='safe'&&utf8ByteLength(witness.label.text)>256)codes.add('presentation-label-bytes');if(witness.detail?.state==='safe'&&utf8ByteLength(witness.detail.text)>1024)codes.add('presentation-detail-bytes');if(witness.url.state==='exact'&&utf8ByteLength(witness.url.href)>2048)codes.add('presentation-url-bytes');if(utf8ByteLength(JSON.stringify(v))>4096)codes.add('presentation-bytes');}
 for(const r of [p.source,...p.targets]){const v=r.presentation;if(typeof v.label==='string'&&utf8ByteLength(v.label)>256)codes.add('presentation-label-bytes');if(typeof v.detail==='string'&&utf8ByteLength(v.detail)>1024)codes.add('presentation-detail-bytes');if(typeof v.url==='string'&&utf8ByteLength(v.url)>2048)codes.add('presentation-url-bytes');if(utf8ByteLength(JSON.stringify(v))>4096)codes.add('presentation-bytes');}
 if(utf8ByteLength(JSON.stringify({protocolVersion:1,producerPluginId:p.producerPluginId,source:p.source,tombstone:p.tombstone,targets:p.targets}))>262144)codes.add('projection-bytes');
 return [...codes].sort();
}
export class BriefAdmissionError extends Error {constructor(readonly code:'invalid'|'over-limit'|'identity-unrepresentable',readonly limits:readonly BriefLimitCode[]=[]){super(code==='over-limit'?'Brief references exceed admitted limits.':code==='identity-unrepresentable'?'Brief identity cannot be represented safely.':'Invalid brief evidence.');this.name='BriefAdmissionError';}}
/** Full independent SAFE recomputation. Withheld originals intentionally cannot be reproved here. */
export function assertBriefDisplaySafe(e:BriefEvidenceV1):void {
 const fields:DisplayFieldV1[]=[];let index=0;
 const strings=(v:unknown,role:DisplayRoleV1)=>{if(typeof v==='string')fields.push({key:[index++],role,value:v});else if(Array.isArray(v))for(const x of v)strings(x,role);else if(v&&typeof v==='object')for(const x of Object.values(v))strings(x,role);};
 strings(verifiedFileIdentity(e.sourceFile),'required-identity');for(const d of e.targetDescriptors)strings(identityValue(d.target),'required-identity');
 const p=(v:BriefPresentationV1,source:boolean)=>{if(v.label.state==='safe')strings(v.label.text,source?'source-label':'target-label');if(v.detail?.state==='safe')strings(v.detail.text,'detail');if(v.url.state==='exact')strings(v.url.href,'presentation-href');};p(e.sourcePresentation,true);
 for(const d of e.targetDescriptors){p(d.presentation,false);if(d.codec.state==='available')strings(d.codec.value,'codec');}
 for(const o of e.occurrences){if(o.locator.section.heading?.state==='named')strings(o.locator.section.heading.text,'heading');if(o.provenance.state==='safe')strings(o.provenance.value,'provenance');if(o.authoredUrl.state==='exact')strings(o.authoredUrl.href,'authored-url');}
 const result=classifyBriefDisplayFieldsV1(fields);if(result.state!=='classified')throw new BriefAdmissionError('identity-unrepresentable');for(let i=0;i<result.results.length;i++)if(result.results[i]!.result.state!=='safe')throw new BriefAdmissionError(fields[i]!.role==='required-identity'?'identity-unrepresentable':'invalid');
}
/** Pure complete-snapshot admission, shared by ingress and producer preflight. */
export function validateBriefCommand(projection:ApplyProjectionInput,evidence:BriefEvidenceV1,evidenceDigest:string):BriefEvidenceV1 {
 const e=briefEvidenceSchema.parse(evidence);if(projection.producerPluginId!=='thread-brief'||canonicalJson(identityValue({provider:projection.source.provider,keys:projection.source.keys}))!==canonicalJson(verifiedFileIdentity(e.sourceFile)))throw new BriefAdmissionError('invalid');
 if(canonicalJson(projection.source.presentation)!==canonicalJson(briefPresentation(e.sourcePresentation)))throw new BriefAdmissionError('invalid');
 const targets=new Map(projection.targets.map(t=>{const c=canonicalizeResource(t);return [c.identityDigest,c] as const;}));if(targets.size!==projection.targets.length||targets.size!==e.targetDescriptors.length)throw new BriefAdmissionError('invalid');
 const descriptors=new Set<string>();for(const d of e.targetDescriptors){const key=canonicalizeIdentity(d.target).identityDigest,t=targets.get(key);if(!t||descriptors.has(key)||canonicalJson(t.presentation)!==canonicalJson(briefPresentation(d.presentation)))throw new BriefAdmissionError('invalid');descriptors.add(key);
  if(d.codec.state==='available'){const p=d.codec.value;const decoded=p.kind==='file'?verifiedFileIdentity(p.verified):p.kind==='url'?{provider:'url',keys:{href:new URL(p.href).href}}:recognitionIdentity(p.source,p.kind==='thread'?p.verified:undefined);if(canonicalJson(identityValue(decoded))!==canonicalJson(identityValue(d.target)))throw new BriefAdmissionError('invalid');}
 }
 const limits:BriefLimitCode[]=[],keys=new Set<string>(),ids=new Set<string>(),counts=new Map<string,number>();
 if(e.sourceState==='absent'){if(e.sourceContentRevision!==null||e.frame!==null||e.occurrences.length||targets.size||!projection.tombstone)throw new BriefAdmissionError('invalid');}
 else {if(e.sourceContentRevision===null||e.frame===null||e.sourceState==='empty'&&(e.occurrences.length>0||targets.size>0||!projection.tombstone)||e.sourceState==='present'&&projection.tombstone)throw new BriefAdmissionError('invalid');}
 if(e.sourceState==='empty'){const f=e.frame!;if(f.fileUtf16Length!==0||f.bodyBase.startUtf16!==0||f.bodyBase.utf16Length!==0||f.bodyBase.startLine!==1||f.lineMapping.fileLineCount!==1||f.rawBytes!==f.bomBytes||e.sourceContentRevision!==sha256Hex(f.bomBytes===3?'\uFEFF':''))throw new BriefAdmissionError('invalid');}
 for(const o of e.occurrences){const key=canonicalizeIdentity(o.target).identityDigest;counts.set(key,(counts.get(key)??0)+1);
  if(!targets.has(key)||keys.has(o.occurrenceKey)||ids.has(o.sourceOccurrenceId)||o.locator.threadId!==e.sourceFile.threadId||canonicalJson(o.locator.file)!==canonicalJson(e.sourceFile)||o.locator.sourceContentRevision!==e.sourceContentRevision||o.occurrenceKey!==briefOccurrenceKey(e.sourceContentRevision!,o.target,o.locator,o.sourceOccurrenceId))throw new BriefAdmissionError('invalid');
  const f=e.frame!;if(o.locator.section.line>f.lineMapping.fileLineCount||o.locator.location.line>f.lineMapping.fileLineCount||o.locator.location.endLine!==null&&(o.locator.location.endLine<o.locator.location.line||o.locator.location.endLine>f.lineMapping.fileLineCount)||o.locator.span&&o.locator.span.end>(o.locator.span.frame==='file-utf16'?f.fileUtf16Length:f.bodyBase.utf16Length))throw new BriefAdmissionError('invalid');keys.add(o.occurrenceKey);ids.add(o.sourceOccurrenceId);
 }
 if(counts.size!==targets.size)throw new BriefAdmissionError('invalid');if([...counts.values()].some(n=>n>100))limits.push('per-target-occurrences');if(limits.length)throw new BriefAdmissionError('over-limit',limits);
 assertBriefDisplaySafe(e);if(briefEvidenceDigest(e)!==evidenceDigest)throw new BriefAdmissionError('invalid');return e;
}
const limitCodes=z.array(z.enum(BRIEF_LIMIT_CODES)).max(10).refine(v=>new Set(v).size===v.length&&v.every((x,i)=>i===0||v[i-1]!<x));
const identityCodes=z.array(z.enum(['unsafe-required-identity','unsupported-required-codec','required-identity-bound'])).min(1).max(3).refine(v=>new Set(v).size===v.length&&v.every((x,i)=>i===0||v[i-1]!<x));
export const blockedBriefStatusSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('over-limit'),sourceContentRevision:digest,limits:limitCodes.refine(v=>v.length>0)}),
 z.strictObject({state:z.literal('identity-unrepresentable'),sourceContentRevision:digest,identityReasons:identityCodes,limits:limitCodes}),
]);
export type BlockedBriefStatusV1=z.infer<typeof blockedBriefStatusSchema>;
export function briefStatusDigest(producerPluginId:string,source:ResourceIdentity,sourceFile:BriefFileV1,status:BlockedBriefStatusV1):string {const s=blockedBriefStatusSchema.parse(status);return sha256Hex(canonicalJson(['brief-status',1,producerPluginId,identityValue(source),briefFileSchema.parse(sourceFile),{...s,limits:[...s.limits].sort(),...('identityReasons' in s?{identityReasons:[...s.identityReasons].sort()}: {})}]));}
export const producerGetStateInputSchema=z.strictObject({version:z.literal(1),producerPluginId:z.literal('thread-brief'),source:identity});
export const producerReportStatusInputSchema=producerGetStateInputSchema.extend({sourceFile:briefFileSchema,attemptRevision:positive,expectedRevision:integer,statusDigest:digest,status:blockedBriefStatusSchema}).superRefine((v,c)=>{
 if(canonicalJson(identityValue(v.source))!==canonicalJson(verifiedFileIdentity(v.sourceFile))||briefStatusDigest(v.producerPluginId,v.source,v.sourceFile,v.status)!==v.statusDigest)c.addIssue({code:'custom',message:'Invalid brief status binding.'});
});
const presentationOut=z.object({label:labelText,detail:bytes(1024).refine(v=>!control(v)&&v.trim().length>0).optional(),url:bytes(2048).optional()}).passthrough();
const resourceOut=z.object({provider:z.string(),keys:z.record(z.string(),z.string()),presentation:presentationOut}).passthrough();
const projectionOut=z.object({producerPluginId:plugin,source:resourceOut,revision:integer,mutationId:z.string(),payloadDigest:digest,tombstone:z.boolean(),targets:z.array(resourceOut).max(256)}).passthrough();
const statusOut=z.union([
 blockedBriefStatusSchema.options[0].extend({attemptRevision:positive,statusDigest:digest,sourceFile:briefFileSchema.passthrough(),applicability:z.enum(['current','superseded-by-graph'])}).passthrough(),
 blockedBriefStatusSchema.options[1].extend({attemptRevision:positive,statusDigest:digest,sourceFile:briefFileSchema.passthrough(),applicability:z.enum(['current','superseded-by-graph'])}).passthrough(),
]);
export const producerStateSchema=z.object({version:z.literal(1),projection:projectionOut.nullable(),evidence:z.object({kind:z.literal('thread-brief'),graphRevision:positive,graphPayloadDigest:digest,evidenceDigest:digest,sourceContentRevision:digest.nullable(),state:z.enum(['bound','unconfirmed']),sourceState:z.enum(['present','absent','empty']),occurrenceCount:integer.max(512)}).passthrough().nullable(),status:statusOut.nullable(),revisionHighWater:integer}).passthrough();
export type ProducerState=z.infer<typeof producerStateSchema>;
export type ProducerReportStatusInput=z.infer<typeof producerReportStatusInputSchema>;
export type ProducerGetStateInput=z.infer<typeof producerGetStateInputSchema>;
export const producerDescribeInputSchema=z.null();
export const producerDescribeOutputSchema=z.object({protocol:z.literal('cross-references-producer'),versions:z.array(positive).max(16),sourceKinds:z.array(z.literal('thread-brief')).max(1),limits:z.object({inputBytes:positive,statusBytes:positive,locations:positive,perTarget:positive,headingBytes:positive,limitCodes:z.array(z.string()).max(32)}).passthrough()}).passthrough();
export const producerDescribe=()=>({protocol:'cross-references-producer' as const,versions:[1],sourceKinds:['thread-brief' as const],limits:{inputBytes:BRIEF_LIMITS.inputBytes,statusBytes:BRIEF_LIMITS.statusBytes,locations:512,perTarget:100,headingBytes:256,limitCodes:[...BRIEF_LIMIT_CODES]}});
type ProjectionResourceDto=ResourceIdentity&{presentation:{label:string;detail?:string|undefined;url?:string|undefined}};
type ProjectionDto=Omit<ApplyProjectionInput,'source'|'targets'>&{source:ProjectionResourceDto;targets:ProjectionResourceDto[]};
/** Runs AFTER the supplied unchanged strict V1 schema. Preserve every present
 * valid field; only undefined optional values become ordinary JSON absence. */
function projectionValue(value:ProjectionDto):ApplyProjectionInput {
 const resource=(r:ProjectionResourceDto)=>({provider:r.provider,keys:r.keys,presentation:{label:r.presentation.label,...(r.presentation.detail===undefined?{}:{detail:r.presentation.detail}),...(r.presentation.url===undefined?{}:{url:r.presentation.url})}});
 return {protocolVersion:value.protocolVersion,producerPluginId:value.producerPluginId,mutationId:value.mutationId,source:resource(value.source),revision:value.revision,expectedRevision:value.expectedRevision,payloadDigest:value.payloadDigest,tombstone:value.tombstone,targets:value.targets.map(resource)};
}
export function createProducerSchemas<S extends z.ZodType<ProjectionDto>>(projection:S){const admittedProjection=projection.transform(projectionValue);return {
 [PRODUCER_METHODS.describe]:{input:producerDescribeInputSchema,output:producerDescribeOutputSchema},
 [PRODUCER_METHODS.getState]:{input:producerGetStateInputSchema,output:producerStateSchema},
 [PRODUCER_METHODS.apply]:{input:z.strictObject({version:z.literal(1),projection:admittedProjection,evidence:briefEvidenceSchema,evidenceDigest:digest}),output:z.object({version:z.literal(1),outcome:z.enum(['applied','duplicate','equal','stale','conflict','cas-mismatch']),currentRevision:integer,currentDigest:digest.nullable(),evidenceDisposition:z.enum(['installed','replayed','conflict','not-applied']),state:producerStateSchema}).passthrough()},
 [PRODUCER_METHODS.reportStatus]:{input:producerReportStatusInputSchema,output:z.object({version:z.literal(1),outcome:z.enum(['recorded','duplicate','stale','conflict','cas-mismatch']),state:producerStateSchema}).passthrough()},
} as const;}
export type ProducerApplyInput={version:1;projection:ApplyProjectionInput;evidence:BriefEvidenceV1;evidenceDigest:string};
export type ProducerApplyOutput={version:1;outcome:'applied'|'duplicate'|'equal'|'stale'|'conflict'|'cas-mismatch';currentRevision:number;currentDigest:string|null;evidenceDisposition:'installed'|'replayed'|'conflict'|'not-applied';state:ProducerState};
export type ProducerReportStatusOutput={version:1;outcome:'recorded'|'duplicate'|'stale'|'conflict'|'cas-mismatch';state:ProducerState};
/** A declared native plugin route, never an arbitrary href. Only these known
 * fields participate in navigation; additive output fields are ignored. */
export const BRIEF_READER_ROUTE=Object.freeze({kind:'thread-brief-reader',version:1,owner:'thread-brief',path:'reveal'} as const);
export const briefReaderDestinationSchema=z.object({kind:z.literal(BRIEF_READER_ROUTE.kind),version:z.literal(1),owner:z.literal(BRIEF_READER_ROUTE.owner),path:z.literal(BRIEF_READER_ROUTE.path),threadId:z.string().regex(/^thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u),token:z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)}).passthrough();
export type BriefReaderDestination=z.infer<typeof briefReaderDestinationSchema>;
export function encodeBriefReaderPath(raw:BriefReaderDestination):string {
 const d=briefReaderDestinationSchema.parse(raw);
 return `/plugins/${BRIEF_READER_ROUTE.owner}/${BRIEF_READER_ROUTE.path}/v1/${d.threadId}/${d.token}`;
}
export function decodeBriefReaderPath(path:string):BriefReaderDestination|null {
 if(path.length>256)return null;
 const match=/^\/plugins\/thread-brief\/reveal\/v1\/(thr_[23456789abcdefghijkmnpqrstuvwxyz]{10})\/([a-f0-9-]{36})$/u.exec(path);
 if(!match)return null;
 const parsed=briefReaderDestinationSchema.safeParse({...BRIEF_READER_ROUTE,threadId:match[1],token:match[2]});
 return parsed.success?parsed.data:null;
}
export const briefNavigationInputSchema=z.strictObject({version:z.literal(1),sourceFile:briefFileSchema,sourceContentRevision:digest,frame:briefFrameSchema,section:z.strictObject({heading:briefHeadingSchema,originalLine:positive})});
export const briefNavigationOutputSchema=z.discriminatedUnion('state',[
 z.object({version:z.literal(1),state:z.literal('ready'),sourceFile:briefFileSchema.passthrough(),sourceContentRevision:digest,location:z.object({kind:z.literal('line'),line:positive,column:z.null()}).passthrough(),proof:z.object({kind:z.literal('accepted-revision-revalidated'),acceptedRevision:digest,selection:z.literal('same-revision'),frame:briefFrameSchema.safeExtend({bodyBase:briefFrameSchema.shape.bodyBase.passthrough(),lineMapping:briefFrameSchema.shape.lineMapping.passthrough()}).passthrough()}).passthrough(),reader:briefReaderDestinationSchema.optional()}).passthrough(),
 z.object({version:z.literal(1),state:z.literal('fallback'),sourceFile:briefFileSchema.passthrough(),location:z.null(),reason:z.enum(['stale','no-accepted-document','ambiguous','heading-unavailable','source-unavailable','over-limit']),reader:briefReaderDestinationSchema.optional()}).passthrough(),
]);
export const briefNavigationDescribeOutputSchema=z.object({protocol:z.literal('thread-brief-navigation'),versions:z.array(positive).max(16),renderedReaderVersions:z.array(positive).max(16).optional()}).passthrough();
export const briefNavigationRpcSchemas={ [BRIEF_NAVIGATION_METHODS.describe]:{input:z.null(),output:briefNavigationDescribeOutputSchema},[BRIEF_NAVIGATION_METHODS.resolve]:{input:briefNavigationInputSchema,output:briefNavigationOutputSchema}} as const;
export type BriefNavigationInput=z.infer<typeof briefNavigationInputSchema>;
export type BriefNavigationOutput=z.infer<typeof briefNavigationOutputSchema>;

// Separate tolerant output schemas: never loosen the strict write DTOs above.
const outWithheld=<T extends string>(display:T)=>withheld(display).passthrough();
export const briefHeadingOutputSchema=z.union([z.null(),z.object({state:z.literal('named'),text:bytes(256)}).passthrough(),outWithheld('Heading withheld')]);
export const briefFileOutputSchema=briefFileSchema.passthrough();
export const briefFrameOutputSchema=briefFrameSchema.safeExtend({bodyBase:briefFrameSchema.shape.bodyBase.passthrough(),lineMapping:briefFrameSchema.shape.lineMapping.passthrough()}).passthrough();
export const briefLocatorOutputSchema=briefLocatorSchema.extend({file:briefFileOutputSchema,section:z.object({heading:briefHeadingOutputSchema,line:positive}).passthrough(),location:briefLocatorSchema.shape.location.passthrough(),span:briefLocatorSchema.shape.span.unwrap().passthrough().optional()}).passthrough();
const verifiedFileOutput=z.union([VerifiedFileTargetSchema.options[0].passthrough(),VerifiedFileTargetSchema.options[1].passthrough()]);
const provenanceValueOutput=provenanceValue.extend({source:SourceIdentitySchema.passthrough(),verifiedFile:verifiedFileOutput.optional(),recognition:provenanceValue.shape.recognition.extend({evidence:provenanceValue.shape.recognition.shape.evidence.unwrap().extend({span:span.passthrough().optional()}).passthrough().optional()}).passthrough()}).passthrough();
export const briefProvenanceOutputSchema=z.union([z.object({state:z.literal('safe'),value:provenanceValueOutput}).passthrough(),outWithheld('Recognition details withheld').extend({summary:provenanceSummary.passthrough()})]);
export const briefAuthoredUrlOutputSchema=z.union([z.object({state:z.literal('exact'),href:safeHref}).passthrough(),z.object({state:z.literal('not-url')}).passthrough(),z.object({state:z.literal('unknown')}).passthrough(),outWithheld('Destination withheld')]);

/** Verify only the public fresh-proof contract; never claims to read the file. */
export function validateBriefNavigationResultV1(input:BriefNavigationInput,raw:unknown):BriefNavigationOutput {
 const value=briefNavigationOutputSchema.parse(raw),file=value.sourceFile;
 if(file.kind!==input.sourceFile.kind||file.threadId!==input.sourceFile.threadId||file.path!==input.sourceFile.path)throw new Error('Brief navigation target mismatch.');
 if(value.reader&&value.reader.threadId!==input.sourceFile.threadId)throw new Error('Brief reader target mismatch.');
 if(value.state==='ready'&&(value.sourceContentRevision!==input.sourceContentRevision||value.proof.acceptedRevision!==input.sourceContentRevision||canonicalJson(knownFrame(value.proof.frame))!==canonicalJson(knownFrame(input.frame))||value.location.line!==input.section.originalLine||value.location.line>input.frame.lineMapping.fileLineCount))throw new Error('Brief navigation proof mismatch.');
 return value;
}
function knownFrame(f:BriefFrameV1){return {codec:f.codec,rawBytes:f.rawBytes,bomBytes:f.bomBytes,fileUtf16Length:f.fileUtf16Length,bodyBase:{startUtf16:f.bodyBase.startUtf16,startLine:f.bodyBase.startLine,utf16Length:f.bodyBase.utf16Length},lineMapping:{codec:f.lineMapping.codec,fileLineCount:f.lineMapping.fileLineCount}};}
