import type {StandardSchemaV1} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import {DESCRIPTION,LIMITS,METHODS,readInputSchema,describeEnvelopeSchema,describeSchema,parseBounded,parseReadInput,parseReadOutput,boundReadOutput,type ReadInput,type ReadOutput} from './index.js';
function sdkSchema<T>(schema:z.ZodType<T>):StandardSchemaV1<T>{return {'~standard':{version:1,vendor:'bb-inbox-rows',jsonSchema:{input:()=>schema.toJSONSchema({io:'input',unrepresentable:'any'}),output:()=>schema.toJSONSchema({io:'output',unrepresentable:'any'})},validate(value:unknown){const r=schema.safeParse(value);return r.success?{value:r.data}:{issues:r.error.issues};}}} as StandardSchemaV1<T>;}
export const inboxRowsRpcContract={
 [METHODS.describe]:{input:sdkSchema(z.null()),output:sdkSchema(z.unknown())},
 // Preserve raw input for canonical size + strict validation inside the handler.
 [METHODS.read]:{input:sdkSchema(readInputSchema),output:sdkSchema(z.unknown())},
};
export interface InboxRowsSupplier<Context=void>{read(input:ReadInput,context:Context|undefined,signal:AbortSignal):Promise<ReadOutput>;}
export function createInboxRowsHandlers<Context>(supplier:InboxRowsSupplier<Context>){
 let pending=0;
 return {
  describe(raw:unknown=null){z.null().parse(raw);return DESCRIPTION;},
  async read(raw:unknown,context?:Context):Promise<ReadOutput>{
   const input=parseReadInput(raw);
   const failed=(reason:'source-error'|'timeout'):ReadOutput=>({version:1,ownerKey:input.viewAs??null,revision:'unavailable',rows:input.occurrences.map(o=>({...o,state:'unavailable',reason}))});
   // No unbounded queue, including when an underlying SDK ignores cancellation.
   if(pending>=2)return failed('source-error');
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   pending++;
   const flight=Promise.resolve().then(()=>supplier.read(input,context,controller.signal)).finally(()=>{pending--;});
   const deadline=new Promise<ReadOutput>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(failed('timeout'));},LIMITS.supplierMs);});
   try{return boundReadOutput(input,await Promise.race([flight,deadline]));}
   catch{return failed(controller.signal.aborted?'timeout':'source-error');}
   finally{clearTimeout(timer);controller.abort();}
  },
 };
}
/** Inject the public SDK registrar, or an identity binding's registrar preserving invocation. */
export function registerInboxRowsSupplier<Context,Result>(register:(contract:typeof inboxRowsRpcContract,handlers:{[METHODS.describe]:(input:unknown)=>unknown;[METHODS.read]:(input:unknown,context?:Context)=>Promise<ReadOutput>})=>Result,supplier:InboxRowsSupplier<Context>):Result {
 const h=createInboxRowsHandlers(supplier);
 return register(inboxRowsRpcContract,{[METHODS.describe]:input=>h.describe(input),[METHODS.read]:(input,context)=>h.read(input,context)});
}
export type InboxRowsTransport=(call:{pluginId:string;method:string;input:unknown;signal:AbortSignal})=>Promise<unknown>;
/** One shared caller resource. Selection changes must not invoke this client. */
export function createInboxRowsClient(transport:InboxRowsTransport,pluginId:string){
 let pending=false;
 async function call(method:string,input:unknown,outer?:AbortSignal){
  if(pending)throw Error('Inbox row request still outstanding');
  outer?.throwIfAborted();pending=true;
  const controller=new AbortController(),signal=outer?AbortSignal.any([outer,controller.signal]):controller.signal;
  let timer:ReturnType<typeof setTimeout>|undefined,abort:(()=>void)|undefined;
  const flight=Promise.resolve().then(()=>{signal.throwIfAborted();return transport({pluginId,method,input,signal});}).finally(()=>{pending=false;});
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('Inbox row read timed out'));controller.abort();},LIMITS.callMs);});
  const aborted=new Promise<never>((_,reject)=>{abort=()=>reject(new DOMException('Aborted','AbortError'));signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([flight,deadline,aborted]);}finally{clearTimeout(timer);if(abort)signal.removeEventListener('abort',abort);controller.abort();}
 }
 return {
  pluginId,
  async describe(signal?:AbortSignal){const raw=await call(METHODS.describe,null,signal),envelope=parseBounded(describeEnvelopeSchema,raw,LIMITS.describeBytes);if(!envelope.versions.includes(1))throw Error('Unsupported Inbox rows version');return parseBounded(describeSchema,raw,LIMITS.describeBytes);},
  async read(raw:ReadInput,signal?:AbortSignal){const input=parseReadInput(raw);return parseReadOutput(input,await call(METHODS.read,input,signal));},
 };
}
