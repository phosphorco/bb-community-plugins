import type {BbPluginApi,StandardSchemaV1} from '@get-bb/plugin-sdk';
import {z} from 'zod';
import * as p from './protocol.js';
function sdkSchema<T>(schema:z.ZodType<T>):StandardSchemaV1<T>{
  return {'~standard':{version:1,vendor:'bb-jev',jsonSchema:{
    input:()=>schema.toJSONSchema({io:'input',unrepresentable:'any'}),output:()=>schema.toJSONSchema({io:'output',unrepresentable:'any'})},
    validate(value){const parsed=schema.safeParse(value);return parsed.success?{value:parsed.data}:{issues:parsed.error.issues.map(issue=>({message:issue.message,path:issue.path.map(k=>typeof k==='symbol'?String(k):k)}))};}
  }} as StandardSchemaV1<T>;
}
export interface OwnerPort {
  describe():p.Description|Promise<p.Description>;
  submit(input:p.Submit):Promise<p.OperationRecord>;
  lookup(input:z.infer<typeof p.LookupSchema>):p.OperationRecord|null|Promise<p.OperationRecord|null>;
}
export function registerJevOwner(bb:Pick<BbPluginApi,'rpc'>,port:OwnerPort):void{
  bb.rpc.register({
    [p.METHODS.describe]:{input:sdkSchema(z.null()),output:sdkSchema(p.DescribeSchema)},
    [p.METHODS.submit]:{input:sdkSchema(p.SubmitSchema),output:sdkSchema(p.RecordSchema)},
    [p.METHODS.lookup]:{input:sdkSchema(p.LookupSchema),output:sdkSchema(p.RecordSchema.nullable())}
  },{
    [p.METHODS.describe]:async()=>p.decode(p.DescribeSchema,await port.describe(),p.LIMITS.describeBytes),
    [p.METHODS.submit]:async(input:p.Submit)=>{
      const captured=p.decode(p.SubmitSchema,JSON.parse(p.canonical(input,p.LIMITS.requestBytes)),p.LIMITS.requestBytes);
      const record=await p.decodeRecord(captured,await port.submit(captured));
      if(!record)throw Error('JEV owner omitted submitted operation');return record;
    },
    [p.METHODS.lookup]:async(input:z.infer<typeof p.LookupSchema>)=>p.decodeRecord(input,await port.lookup(input))
  },{experimental_discoverable:true});
}
export class JevCallError extends Error {
  constructor(readonly outcome:'not-invoked'|'unknown'|'read-failed'|'incompatible',message:string,readonly original?:unknown){super(message);this.name='JevCallError';}
}
function bounded<T>(run:(signal:AbortSignal)=>Promise<T>,ms:number,outer?:AbortSignal):Promise<T>{
  const ctrl=new AbortController();
  return new Promise((resolve,reject)=>{
    let done=false;
    const finish=(fn:()=>void)=>{if(done)return;done=true;clearTimeout(timer);outer?.removeEventListener('abort',abort);fn();};
    const abort=()=>{ctrl.abort();finish(()=>reject(Error('JEV observation cancelled; remote work may continue')));};
    const timer=setTimeout(()=>{ctrl.abort();finish(()=>reject(Error('JEV observation deadline; remote work may continue')));},Math.max(1,ms));
    outer?.addEventListener('abort',abort,{once:true});
    if(outer?.aborted){abort();return;}
    Promise.resolve().then(()=>run(ctrl.signal)).then(v=>finish(()=>resolve(v)),e=>finish(()=>reject(e)));
  });
}
/** Select one explicit owner. No secret discovery, write retry, or availability polling. */
export function createJevClient(sdk:Pick<BbPluginApi['sdk'],'plugins'>,ownerPluginId=p.DEFAULT_OWNER){
  const physical={submit:0,read:0,reconcile:0};
  async function call(method:string,input:p.Json,ms:number,signal?:AbortSignal,reconcile=false):Promise<unknown>{
    const lane=method===p.METHODS.submit?'submit':reconcile?'reconcile':'read';
    if(physical[lane]>=p.LIMITS.concurrency)throw Error('JEV client unsettled-call capacity exceeded');
    return bounded(s=>{
      if(physical[lane]>=p.LIMITS.concurrency)throw Error('JEV client unsettled-call capacity exceeded');
      physical[lane]++;
      let pending:Promise<unknown>;
      try{pending=Promise.resolve(sdk.plugins.callRpc({pluginId:ownerPluginId,method,input,outputSchema:z.unknown(),signal:s}));}
      catch(e){physical[lane]--;throw e;}
      pending.then(()=>physical[lane]--,()=>physical[lane]--);return pending;
    },ms,signal);
  }
  async function lookup(operation:p.OperationKey,signal?:AbortSignal,reconcile=false){
    const input=p.LookupSchema.parse({version:1,operation});
    try{return await p.decodeRecord(input,await call(p.METHODS.lookup,input,2000,signal,reconcile));}
    catch(e){throw new JevCallError('read-failed','Shared JEV operation lookup failed',e);}
  }
  return {ownerPluginId,
    async describe(signal?:AbortSignal):Promise<p.Description>{
      try{
        const listed=await bounded(s=>sdk.plugins.list({signal:s}),2000,signal);
        if(!listed.plugins.some(plugin=>plugin.id===ownerPluginId&&plugin.status==='running'))throw Error(`Shared JEV owner ${ownerPluginId} is missing, disabled or not running`);
        const raw=await call(p.METHODS.describe,null,2000,signal);
        const envelope=p.decode(p.DescribeEnvelopeSchema,raw,p.LIMITS.describeBytes);
        if(envelope.protocol!==p.PROTOCOL||!envelope.versions.includes(1))throw Error('Shared JEV protocol version is incompatible');
        const value=p.decode(p.DescribeSchema,raw,p.LIMITS.describeBytes);
        if(value.ownerPluginId!==ownerPluginId||value.source.ownerPluginId!==ownerPluginId)throw Error('Shared JEV connection owner mismatch');
        return value;
      }catch(e){throw new JevCallError('incompatible',e instanceof Error?e.message:String(e),e);}
    },lookup,
    async submit(raw:p.Submit,signal?:AbortSignal):Promise<p.OperationRecord>{
      let input:p.Submit;
      try{input=p.decode(p.SubmitSchema,JSON.parse(p.canonical(raw,p.LIMITS.requestBytes)),p.LIMITS.requestBytes);
        if(signal?.aborted||input.deadlineAt<=Date.now())throw Error('JEV deadline/cancellation before submit');
      }catch(e){throw new JevCallError('not-invoked','Shared JEV request refused before submit',e);}
      try{
        const value=await p.decodeRecord(input,await call(p.METHODS.submit,input,Math.min(p.LIMITS.deadlineMs,input.deadlineAt-Date.now())+250,signal));
        if(!value)throw Error('JEV owner returned no operation');return value;
      }catch(e){
        // One independent read, including after caller abort. Never replay a write.
        try{const retained=await lookup(input.operation,undefined,true);if(retained){const checked=await p.decodeRecord(input,retained);if(checked)return checked;}}catch{/* Original uncertainty retained. */}
        throw new JevCallError('unknown','Shared JEV submit outcome unknown; retain operation and reconcile without resending',e);
      }
    }
  };
}
