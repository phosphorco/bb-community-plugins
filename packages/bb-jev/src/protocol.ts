import {z} from 'zod';
export const PROTOCOL='bb-jev' as const;
export const VERSION=1 as const;
export const DEFAULT_OWNER='jev-topics';
export const METHODS=Object.freeze({describe:'sharedJevDescribeV1',submit:'sharedJevSubmitV1',lookup:'sharedJevLookupV1'});
export const LIMITS=Object.freeze({requestBytes:1_048_576,responseBytes:1_114_112,wireResponseBytes:1_048_576,describeBytes:16_384,depth:48,deadlineMs:60_000,concurrency:4});
export type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
/** Validate finite plain JSON before decoding; never invoke toJSON or silently drop undefined. */
export function canonical(value:unknown,maxBytes:number=LIMITS.responseBytes):string {
  const seen=new Set<object>();
  let spent=0;
  const charge=(n:number)=>{spent+=n;if(spent>maxBytes)throw Error('JSON byte budget exceeded');};
  const leaf=(v:null|boolean|string|number)=>{const text=JSON.stringify(v);charge(new TextEncoder().encode(text).byteLength);return text;};
  function visit(v:unknown,depth:number):string {
    if(depth>LIMITS.depth)throw Error('JSON depth exceeded');
    if(v===null||typeof v==='boolean'||typeof v==='string')return leaf(v);
    if(typeof v==='number'&&Number.isFinite(v))return leaf(v);
    if(!v||typeof v!=='object'||seen.has(v))throw Error('Expected finite acyclic JSON');
    seen.add(v);
    try {
      if(Array.isArray(v)) {
        if(Reflect.ownKeys(v).length!==v.length+1)throw Error('Sparse or decorated JSON array');
        charge(2+Math.max(0,v.length-1));
        const elements:string[]=[];
        for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value' in d))throw Error('JSON array accessor');elements.push(visit(d.value,depth+1));}
        return '['+elements.join(',')+']';
      }
      if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('Expected plain JSON object');
      if(Reflect.ownKeys(v).some(k=>typeof k!=='string'))throw Error('JSON symbol key');
      const keys=Object.keys(v).sort();charge(2+Math.max(0,keys.length-1));
      return '{'+keys.map(k=>{
        const descriptor=Object.getOwnPropertyDescriptor(v,k);
        if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)throw Error('JSON accessor/property');
        charge(new TextEncoder().encode(JSON.stringify(k)).byteLength+1);
        return JSON.stringify(k)+':'+visit(descriptor.value,depth+1);
      }).join(',')+'}';
    }finally{seen.delete(v);}
  }
  const bytes=visit(value,0);
  if(new TextEncoder().encode(bytes).byteLength>maxBytes)throw Error('JSON byte budget exceeded');
  return bytes;
}
export async function fingerprint(value:unknown):Promise<string>{
  const bytes=new TextEncoder().encode(canonical(value,LIMITS.requestBytes));
  const hash=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return 'sha256:'+Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
export const JsonSchema:z.ZodType<Json>=z.custom<Json>(value=>{try{canonical(value);return true;}catch{return false;}},'Expected bounded finite plain JSON');
const id=z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
export const OperationKeySchema=z.strictObject({namespace:id,operationId:id});
export type OperationKey=z.infer<typeof OperationKeySchema>;
export const SubmitSchema=z.strictObject({version:z.literal(1),operation:OperationKeySchema,
  work:z.strictObject({consumerPluginId:id,kind:id,attribution:JsonSchema}),
  wire:JsonSchema,deadlineAt:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxResponseBytes:z.number().int().min(1024).max(LIMITS.wireResponseBytes)});
export type Submit=z.infer<typeof SubmitSchema>;
export const LookupSchema=z.strictObject({version:z.literal(1),operation:OperationKeySchema});
export const SourceSchema=z.looseObject({ownerPluginId:id,kind:z.literal('plugin-setting'),field:id});
export const UsageSchema=z.discriminatedUnion('status',[
  z.looseObject({status:z.literal('reported'),inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),cost:JsonSchema}),
  z.looseObject({status:z.enum(['missing','invalid']),cost:JsonSchema})]);
export const RecordSchema=z.looseObject({version:z.literal(1),operation:z.looseObject(OperationKeySchema.shape),
  requestFingerprint:z.string().regex(/^sha256:[a-f0-9]{64}$/),work:z.looseObject(SubmitSchema.shape.work.shape),
  state:z.enum(['not-invoked','effect-possible','succeeded','failed','uncertain']),invoked:z.boolean(),
  source:SourceSchema,createdAt:z.number().int().nonnegative(),settledAt:z.number().int().nonnegative().nullable(),
  latencyMs:z.number().nonnegative().nullable(),httpStatus:z.number().int().min(100).max(599).nullable(),
  response:JsonSchema,usage:UsageSchema,error:z.looseObject({code:id,message:z.string().max(8192)}).nullable()
}).superRefine((v,c)=>{
  if(v.state==='not-invoked'&&v.invoked)c.addIssue({code:'custom',message:'Not-invoked cannot claim invocation'});
  if(v.state!=='not-invoked'&&!v.invoked)c.addIssue({code:'custom',message:'Possible invocation must be retained'});
  if(v.state==='effect-possible'&&v.settledAt!==null)c.addIssue({code:'custom',message:'Active work cannot be settled'});
  if(v.state!=='effect-possible'&&v.settledAt===null)c.addIssue({code:'custom',message:'Final observation requires settlement time'});
  if(v.state==='succeeded'&&(v.error!==null||v.response===null))c.addIssue({code:'custom',message:'Success requires a response and no transport error'});
});
export type OperationRecord=z.infer<typeof RecordSchema>;
export const DescribeEnvelopeSchema=z.looseObject({protocol:z.string(),versions:z.array(z.number().int()).max(16)});
export const DescribeSchema=z.looseObject({protocol:z.literal(PROTOCOL),versions:z.array(z.number().int()).max(16),ownerPluginId:id,configured:z.boolean(),source:SourceSchema,
  workKinds:z.array(id).max(32),limits:z.looseObject({requestBytes:z.number().int().positive(),responseBytes:z.number().int().positive(),deadlineMs:z.number().int().positive(),concurrency:z.number().int().positive()})});
export type Description=z.infer<typeof DescribeSchema>;
export function decode<T>(schema:z.ZodType<T>,value:unknown,maxBytes:number=LIMITS.responseBytes):T{canonical(value,maxBytes);return schema.parse(value);}
/** Bind every response to the requested operation; immutable request identity cannot drift on replay. */
export async function decodeRecord(input:Submit|{operation:OperationKey},value:unknown):Promise<OperationRecord|null>{
  if(value===null)return null;
  const record=decode(RecordSchema,value);
  if(record.operation.namespace!==input.operation.namespace||record.operation.operationId!==input.operation.operationId)throw Error('JEV response operation mismatch');
  if('wire' in input && record.requestFingerprint!==await fingerprint(input))throw Error('JEV response immutable request mismatch');
  if('wire' in input && canonical({consumerPluginId:record.work.consumerPluginId,kind:record.work.kind,attribution:record.work.attribution})!==canonical(input.work))throw Error('JEV response work mismatch');
  return record;
}
