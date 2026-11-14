import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {createJevClient,JevCallError} from '@phosphorco/bb-jev/bb';
import {canonical,type Description} from '@phosphorco/bb-jev';
import type {Connection} from '../contracts/model.ts';
import type {Transport} from './evaluator.ts';
import {createHttpTransport,TransportError} from './transport.ts';
export type ConnectionSelection={source:'shared'|'dedicated';credential:string|null};
export function createSelectedJevTransport(sdk:Pick<BbPluginApi['sdk'],'plugins'>,config:Connection,selection:()=>Promise<ConnectionSelection>,fetcher?:typeof fetch):Transport{
  const shared=createJevClient(sdk);
  return async(wire,signal,_context,invocation)=>{
    const deadlineAt=Math.min(invocation?.deadlineAt??Infinity,Date.now()+config.timeoutMs);
    let selected:ConnectionSelection;try{selected=await selection();}catch(e){throw new TransportError('Message Rules connection settings could not be read before invocation.',false,{message:e instanceof Error?e.message:String(e)});}
    if(selected.source==='dedicated'){
      const source={ownerPluginId:'message-rules',kind:'plugin-setting',field:'apiKey'},started=performance.now();
      invocation?.observe({source,selection:'dedicated',state:'not-invoked',invoked:false});
      try{const response=await createHttpTransport(config,async()=>selected.credential,fetcher)(wire,signal,_context,invocation);invocation?.observe({source,selection:'dedicated',state:'observed',invoked:true,latencyMs:performance.now()-started});return response;}
      catch(e){if(e instanceof TransportError){invocation?.observe({source,selection:'dedicated',state:e.invoked?'uncertain':'not-invoked',invoked:e.invoked,latencyMs:performance.now()-started});throw new TransportError(e.message,e.invoked,{source,observation:e.observation});}throw e;}
    }
    if(!invocation)throw new TransportError('Shared JEV requires the existing retained MR paid-attempt identity.',false);
    if(Buffer.byteLength(JSON.stringify(wire))>config.maxWireBytes)throw new TransportError('Shared JEV request exceeds frozen MR wire budget.',false);
    if(signal.aborted)throw new TransportError('Shared JEV cancelled before owner invocation.',false);
    let description:Description;
    try{description=await shared.describe(signal);}catch(e){throw new TransportError(e instanceof Error?e.message:String(e),false);}
    if(!description.configured)throw new TransportError('Topics shared JEV key is not configured. The dedicated MR override is a separate explicit setting.',false,{source:description.source});
    if(!description.workKinds.includes(invocation.kind))throw new TransportError('Topics does not support the requested named MR work.',false,{source:description.source});
    try{
      const record=await shared.submit({version:1,operation:invocation.operation,work:{consumerPluginId:'message-rules',kind:invocation.kind,attribution:invocation.attribution},wire:JSON.parse(canonical(wire,config.maxWireBytes)),deadlineAt:Math.min(deadlineAt,Date.now()+description.limits.deadlineMs),maxResponseBytes:Math.min(config.maxResponseBytes,description.limits.responseBytes)},signal);
      invocation.observe(record);
      if(record.state!=='succeeded')throw new TransportError(record.error?.message??`Shared JEV operation is ${record.state}; no replay.`,record.invoked,{sharedJev:record});
      if(signal.aborted)throw new TransportError('Late shared JEV observation cannot accept a retired MR attempt.',true,{sharedJev:record});
      canonical(record.response,config.maxResponseBytes);
      return record.response;
    }catch(e){if(e instanceof TransportError)throw e;throw new TransportError(e instanceof Error?e.message:String(e),!(e instanceof JevCallError&&e.outcome==='not-invoked'));}
  };
}
