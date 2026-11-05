/** Data only. Supplier-owned summaries are context, never human testimony or exact conversational support. */
import {z} from 'zod';
import {canonicalJsonWithin} from './json.js';
export {canonicalJsonWithin} from './json.js';
export const PROTOCOL='bb.thread-context' as const;
export const WIRE_VERSIONS=Object.freeze([1] as const);
export const METHODS=Object.freeze({describe:'threadContextDescribe',read:'threadContextReadV1'});
export const LIMITS=Object.freeze({threadIdChars:512,revisionChars:256,fieldBytes:4096,responseBytes:16384,describeBytes:2048,describeMs:1000,readMs:2500,supplierReadMs:2000,supplierRawReads:2});
const text=(n:number)=>z.string().max(n);
const id=text(LIMITS.threadIdChars).min(1).refine(s=>!/[\p{Cc}]/u.test(s));
export const describeSchema=z.object({protocol:z.literal(PROTOCOL),versions:z.array(z.number().int().positive()).max(16)}).passthrough();
export const readInputSchema=z.strictObject({threadId:id});
const fieldSchema=z.object({state:z.enum(['present','missing']),text:text(LIMITS.fieldBytes),truncated:z.boolean(),heading:text(256).nullable()}).passthrough().superRefine((v,c)=>{
 if(new TextEncoder().encode(v.text).length>LIMITS.fieldBytes)c.addIssue({code:'custom',message:'Field exceeds UTF-8 byte bound'});
 if(v.state==='missing'&&(v.text!==''||v.truncated||v.heading!==null))c.addIssue({code:'custom',message:'Missing fields have no content or heading'});
 if(v.state==='present'&&!v.text.trim())c.addIssue({code:'custom',message:'Present fields require authored text'});
});
const timestamp=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const readySchema=z.object({state:z.literal('ready'),threadId:id,
 source:z.object({document:z.literal('brief'),revision:text(LIMITS.revisionChars).min(1),observedAt:timestamp,modifiedAt:timestamp.nullable(),readBasis:z.enum(['validated-read','accepted-cache']),completeness:z.enum(['complete','partial'])}).passthrough(),
 fields:z.object({goal:fieldSchema,whereItStands:fieldSchema,decisions:fieldSchema}).passthrough(),
}).passthrough();
export const unavailableSchema=z.object({state:z.literal('unavailable'),threadId:id,reason:z.string().transform(value=>['missing','source-error','too-large','timeout','unsupported','busy','other'].includes(value)?value as 'missing'|'source-error'|'too-large'|'timeout'|'unsupported'|'busy'|'other':'other')}).passthrough();
export const readOutputSchema=z.discriminatedUnion('state',[readySchema,unavailableSchema]);
export type ReadInput=z.input<typeof readInputSchema>;
export type ReadOutput=z.output<typeof readOutputSchema>;
export type ThreadContext=Extract<ReadOutput,{state:'ready'}>;
export function negotiateVersion(value:unknown):{version:1}|null {
 const envelope=describeSchema.safeParse(value);return envelope.success&&envelope.data.versions.includes(1)?{version:1}:null;
}
export function decodeRead(input:ReadInput,value:unknown):ReadOutput {
 if(canonicalJsonWithin(value,LIMITS.responseBytes)===null)throw new Error('Thread context response exceeds byte bound');
 const result=readOutputSchema.parse(value);if(result.threadId!==input.threadId)throw new Error('Thread context belongs to another thread');return result;
}
