import {z} from 'zod';
export const PROTOCOL = 'phosphor.bb-inbox-rows';
export const METHODS = Object.freeze({describe:'inboxRowsV1Describe',read:'inboxRowsV1Read'});
export const ROW_PLUGIN_ID = 'inbox-sidebar-nerd';
export const ROW_SCHEMA = 'inbox-sidebar-nerd/thread-row@1';
export const LIMITS = Object.freeze({occurrences:16,stampBytes:4096,responseBytes:60*1024,inputBytes:16*1024,describeBytes:2048,supplierMs:3500,callMs:4500,senderEvents:25,senderConcurrency:2,profileKeys:200});
const token=z.string().min(1).max(256), key=z.string().min(1).max(512), text=z.string().max(1024);
const count=z.number().int().min(0).max(1_000_000), time=z.number().finite().nonnegative();
const faceSchema=z.object({key,name:text.nullable(),imageUrl:z.string().max(2048).nullable(),label:text,external:z.boolean()}).passthrough();
/** Every evolving output object preserves additive fields; raw bytes are checked before decoding. */
export const rowDataSchema=z.object({
 v:z.literal(1),threadId:token,title:text,groupPath:text.nullable(),tags:z.array(z.string().max(256)).max(3),tagOverflow:count,
 owners:z.array(faceSchema).max(2),ownerOverflow:count,ownerOverflowLabel:text,
 participants:z.array(faceSchema).max(2),participantOverflow:count,senderDescription:text,
 status:z.object({tone:z.enum(['done','snoozed','waiting-for-reset','failed','needs-you','working','woke','ready','quiet']),label:text}).passthrough(),
 time:z.object({at:time,text:z.string().max(128),title:z.string().max(256)}).passthrough(),
}).passthrough();
export type RowData=z.infer<typeof rowDataSchema>;
export const readInputSchema=z.object({version:z.literal(1),occurrences:z.array(z.object({key:token,threadId:token}).strict()).min(1).max(LIMITS.occurrences),archiveMode:z.enum(['active','include-archived']),viewAs:key.nullable().optional()}).strict().superRefine((v,ctx)=>{
 if(new Set(v.occurrences.map(r=>r.key)).size!==v.occurrences.length)ctx.addIssue({code:'custom',message:'Duplicate occurrence key'});
});
export type ReadInput=z.infer<typeof readInputSchema>;
export const unavailableReasonSchema=z.enum(['not-found','not-top-level','excluded','timeout','source-error','oversize']);
export type UnavailableReason=z.infer<typeof unavailableReasonSchema>;
const ready=z.object({key:token,threadId:token,state:z.literal('ready'),revision:token,data:rowDataSchema}).passthrough();
const unavailable=z.object({key:token,threadId:token,state:z.literal('unavailable'),reason:unavailableReasonSchema}).passthrough();
export const readOutputSchema=z.object({version:z.literal(1),ownerKey:key.nullable(),revision:token,rows:z.array(z.discriminatedUnion('state',[ready,unavailable])).min(1).max(LIMITS.occurrences)}).passthrough();
export type ReadOutput=z.infer<typeof readOutputSchema>;
export const describeEnvelopeSchema=z.object({protocol:z.literal(PROTOCOL),versions:z.array(z.number().int().positive()).max(16)}).passthrough();
export const describeSchema=describeEnvelopeSchema.extend({schema:z.literal(ROW_SCHEMA),readMethod:z.literal(METHODS.read),limits:z.object({occurrences:z.literal(16),stampBytes:z.literal(4096),responseBytes:z.literal(61440),supplierMs:z.literal(3500)}).passthrough()});
export const DESCRIPTION={protocol:PROTOCOL,versions:[1],schema:ROW_SCHEMA,readMethod:METHODS.read,limits:{occurrences:16,stampBytes:4096,responseBytes:61440,supplierMs:3500}} as const;
/** Canonical transport JSON size, including Unicode, escapes and additive fields. Not raw HTTP bytes. */
export function canonicalBytes(value:unknown):number {const json=JSON.stringify(value);if(json===undefined)throw Error('Expected JSON');return new TextEncoder().encode(json).byteLength;}
export function parseBounded<T>(schema:z.ZodType<T>,raw:unknown,max:number):T {if(canonicalBytes(raw)>max)throw RangeError('Inbox rows byte limit');return schema.parse(raw);}
export function parseReadInput(raw:unknown):ReadInput{return parseBounded(readInputSchema,raw,LIMITS.inputBytes);}
export function rowPresentation(raw:RowData){return {pluginId:ROW_PLUGIN_ID,schema:ROW_SCHEMA,data:raw};}
export function parseRowData(raw:unknown):RowData{
 if(canonicalBytes({pluginId:ROW_PLUGIN_ID,schema:ROW_SCHEMA,data:raw})>LIMITS.stampBytes)throw RangeError('Inbox stamp byte limit');
 const visit=(value:unknown,depth:number):void=>{if(depth>8)throw RangeError('Inbox stamp depth limit');if(value&&typeof value==='object')for(const child of Object.values(value))visit(child,depth+1);};visit(raw,0);
 return rowDataSchema.parse(raw);
}
export function validateReadOutput(input:ReadInput,output:ReadOutput):ReadOutput {
 if(input.viewAs!=null&&output.ownerKey!==input.viewAs)throw Error('Inbox row owner lens mismatch');
 if(output.rows.length!==input.occurrences.length)throw Error('Missing Inbox row occurrence');
 const requested=new Map(input.occurrences.map(o=>[o.key,o.threadId])),seen=new Set<string>();
 for(const row of output.rows){
  if(seen.has(row.key)||requested.get(row.key)!==row.threadId)throw Error('Unexpected Inbox row occurrence');
  seen.add(row.key);
  if(row.state==='ready'){if(row.data.threadId!==row.threadId)throw Error('Inbox row data identity mismatch');parseRowData(row.data);}
 }
 return output;
}
export function parseReadOutput(input:ReadInput,raw:unknown):ReadOutput{return validateReadOutput(input,parseBounded(readOutputSchema,raw,LIMITS.responseBytes));}
/** Deterministic occurrence-order admission. A stamp never loses portraits to fit. */
export function boundReadOutput(input:ReadInput,raw:ReadOutput):ReadOutput {
 const rows=raw.rows.map(row=>{if(row.state==='unavailable')return row;try{parseRowData(row.data);return row;}catch{let oversized=false;try{oversized=canonicalBytes(rowPresentation(row.data))>LIMITS.stampBytes;}catch{}return {key:row.key,threadId:row.threadId,state:'unavailable' as const,reason:oversized?'oversize' as const:'source-error' as const};}});
 const output={...raw,rows};
 // Reserve the complete envelope and every occurrence before admitting ready payloads.
 for(let index=rows.length-1;canonicalBytes(output)>LIMITS.responseBytes&&index>=0;index--){const row=rows[index]!;if(row.state==='ready')rows[index]={key:row.key,threadId:row.threadId,state:'unavailable',reason:'oversize'};}
 return parseReadOutput(input,output);
}
/** Presentation metadata is data-only; registration still belongs to Inbox's content script. */
export function assertRowPresentation(entry:{schema:string;methods:readonly string[]}):void {if(entry.schema!==ROW_SCHEMA||!entry.methods.includes(METHODS.read))throw Error('Inbox row registration must allow the fixed batch read method');}
