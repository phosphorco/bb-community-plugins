import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import type {PersonRequest} from '@phosphorco/bb-identity/server';
import {identityKeyCodec,type Codec,type Result} from '@phosphorco/bb-identity/model';
import {canonical,TemplatesStore,type LaunchRecord} from './store';
import {CREATED_THREAD_ASSIGNMENT_METHODS as METHODS,CREATED_THREAD_ASSIGNMENT_LIMITS as LIMITS,createdThreadClaimResultSchema,createdThreadLookupResultSchema,createdThreadDescribeSchema,eligibleCreatedThreadActor,type AssignmentStatus,type CreatedThreadClaimResult,type CreatedThreadLookupResult} from './inbox-assignment-contract';
const PROVIDER='inbox-sidebar-nerd';
function codec<T>(schema:z.ZodType<T>):Codec<T>{return {decode(value){try{if(new TextEncoder().encode(canonical(value)).length>LIMITS.responseBytes)throw new Error('Inbox assignment response exceeds 64 KiB');const parsed=schema.safeParse(value);return parsed.success?{ok:true,value:parsed.data}:{ok:false,error:{code:'incompatible',message:'Inbox assignment response is incompatible.',retry:'never'}};}catch{return {ok:false,error:{code:'incompatible',message:'Inbox assignment response is incompatible or too large.',retry:'never'}};}},encode(value){return JSON.parse(JSON.stringify(value));}};}
type Person=PersonRequest<unknown>;
/** Journal owns recovery; raw slots only prevent overlapping local claims while their calls settle. */
export class InboxAssignmentService {
  private active=true;private generation=randomUUID();private rawClaims=new Map<string,Promise<Result<CreatedThreadClaimResult>>>();private attempts=new Map<string,Promise<void>>();private lookups=new Map<string,Promise<void>>();private rawLookups=new Map<string,Promise<Result<CreatedThreadLookupResult>>>();private rawDescribes=new Map<string,Promise<Result<z.infer<typeof createdThreadDescribeSchema>>>>();
  constructor(readonly store:TemplatesStore,readonly sdk:Pick<BbPluginApi['sdk'],'threads'>,readonly changed:()=>void=()=>{}){}
  dispose(){this.active=false;}
  private allowed(row:LaunchRecord,person:Person,validate:()=>void){if(!this.active||person.signal.aborted||!row.status.assignment||!eligibleCreatedThreadActor(person.actor)||!identityKeyCodec.decode(person.actor.identity.key).ok||person.actor.identity.key!==row.capturedActor.identity.key||person.actor.identity.key!==row.status.assignment.actorKey)throw new Error('Assignment recovery requires its original live person.');validate();}
  private patch(id:string,update:(value:AssignmentStatus,row:LaunchRecord)=>{value:AssignmentStatus;dispatch?:LaunchRecord['assignmentDispatch']},validate:()=>void=()=>{}){
    const before=this.store.launch(id);const result=this.store.patchAssignment(id,row=>update(row.status.assignment!,row),validate);if(this.active&&result&&canonical(before?.status.assignment)!==canonical(result.status.assignment))this.changed();return result;
  }
  private async wait<T>(promise:Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Inbox assignment response timed out.')),ms);})]);}finally{if(timer)clearTimeout(timer);}}
  private creationEligible(row:LaunchRecord,threadId:string){return row.status.phase==='succeeded'&&row.status.threadId===threadId&&!!row.confirmation&&!this.store.wasThreadRemoved(threadId);}
  private async confirmed(row:LaunchRecord):Promise<boolean>{if(row.status.phase!=='succeeded'||!row.status.threadId||!row.confirmation||this.store.wasThreadRemoved(row.status.threadId))return false;const t=await this.wait(this.sdk.threads.get({threadId:row.status.threadId}),LIMITS.providerReadMs);return t.id===row.status.threadId&&t.deletedAt===null&&t.archivedAt===null&&t.parentThreadId===null&&(t.lifecycleOwnerThreadId??null)===null&&(row.confirmation==='native-ack'||t.status==='active'||t.status==='idle');}
  private apply(id:string,result:CreatedThreadClaimResult|CreatedThreadLookupResult,source:'claim'|'lookup'='claim'){
    if(result.status!=='final'&&result.status!=='found')return;
    this.patch(id,(value,row)=>{
      const receipt=result.receipt;if(value.receipt&&canonical(value.receipt)!==canonical(receipt))throw new Error('Inbox changed an immutable assignment receipt');if(result.current.threadId!==receipt.threadId||result.current.revision<receipt.ownerRevision)throw new Error('Inbox current ownership does not match receipt');if(receipt.operationId!==value.operationId||receipt.actorKey!==value.actorKey||receipt.threadId!==(value.threadId??row.status.threadId))throw new Error('Inbox assignment receipt identity mismatch');
      const current=!value.current||result.current.revision>=value.current.revision?result.current:value.current;
      // A failed lookup owns its read error even before the first receipt arrives.
      return {value:{...value,threadId:receipt.threadId,state:receipt.outcome,receipt,current,retryable:false,message:source==='claim'&&(value.receipt||value.state==='unavailable')?value.message:receipt.outcome==='claimed'?'Initial assignment recorded.':'Existing assignment decision preserved.'}};
    });
  }
  async check(id:string,person:Person,validate:()=>void):Promise<void>{
    const row=this.store.launch(id);if(!row?.status.assignment)return;this.allowed(row,person,validate);
    if(!row.status.assignment.threadId&&(!row.status.threadId||row.status.phase!=='succeeded'||!row.confirmation))return;
    const flight=this.lookups.get(id);if(flight)return flight;
    const work=(async()=>{
      try{
        const input={operationId:row.status.assignment!.operationId,threadId:row.status.assignment!.threadId??row.status.threadId!};
        let raw=this.rawLookups.get(id);if(!raw){raw=person.callPlugin({pluginId:PROVIDER,method:METHODS.lookup,payload:input,output:codec(createdThreadLookupResultSchema)});this.rawLookups.set(id,raw);const captured=raw;void raw.then(()=>{if(this.rawLookups.get(id)===captured)this.rawLookups.delete(id);},()=>{if(this.rawLookups.get(id)===captured)this.rawLookups.delete(id);});}const response=await this.wait(raw,LIMITS.lookupWaitMs);
        if(!response.ok)throw new Error(response.error.message);const result=response.value;
        if(result.status==='found'){this.apply(id,result,'lookup');return;}
        if(result.status==='rejected')throw new Error(result.message);
        if(result.operationId!==input.operationId||result.threadId!==input.threadId||result.current.threadId!==input.threadId)throw new Error('Inbox absent receipt identity mismatch');
        this.allowed(this.store.launch(id)!,person,validate);
        this.patch(id,value=>({value:{...value,threadId:input.threadId,state:value.receipt?value.receipt.outcome:value.state==='pending'?'pending':'unknown',message:value.receipt?value.message:'No retained assignment receipt is visible. Retry only this same conditional operation.',retryable:!value.receipt&&!this.rawClaims.has(id),current:!value.current||result.current.revision>=value.current.revision?result.current:value.current}}));
      }catch(error){if(this.active)this.patch(id,value=>({value:{...value,message:error instanceof Error?error.message:'Inbox assignment lookup unavailable.',retryable:false,state:value.receipt?value.state:'unavailable'}}));}
    })();this.lookups.set(id,work);try{await work;}finally{if(this.lookups.get(id)===work)this.lookups.delete(id);}
  }
  attempt(id:string,person:Person,validate:()=>void,explicit=false):Promise<void>{
    const row=this.store.launch(id);if(!row?.status.assignment)return Promise.resolve();this.allowed(row,person,validate);
    const existing=this.attempts.get(id);if(existing)return existing;
    const work=this.performAttempt(id,person,validate,explicit);this.attempts.set(id,work);const clear=()=>{if(this.attempts.get(id)===work)this.attempts.delete(id);};void work.then(clear,clear);return work;
  }
  private async performAttempt(id:string,person:Person,validate:()=>void,explicit=false):Promise<void>{
    let row=this.store.launch(id);if(!row?.status.assignment)return;this.allowed(row,person,validate);
    if(this.rawClaims.has(id))return;
    if(explicit){await this.check(id,person,validate);row=this.store.launch(id)!;this.allowed(row,person,validate);if(!row.status.assignment!.retryable||row.status.assignment!.receipt)return;}
    else if(row.assignmentDispatch?.attempted)return;
    if(row.status.phase!=='succeeded'||!row.status.threadId||!row.confirmation)return;
    const expectedThreadId=row.status.threadId;
    this.patch(id,value=>({value,dispatch:{attempted:true,generation:this.generation,claim:randomUUID(),rawPending:false,sent:false}}),()=>this.allowed(this.store.launch(id)!,person,validate));
    try{
      this.allowed(this.store.launch(id)!,person,validate);
      let rawDescribe=this.rawDescribes.get(id);if(!rawDescribe){rawDescribe=person.callPlugin({pluginId:PROVIDER,method:METHODS.describe,payload:null,output:codec(createdThreadDescribeSchema)});this.rawDescribes.set(id,rawDescribe);const captured=rawDescribe;void rawDescribe.then(()=>{if(this.rawDescribes.get(id)===captured)this.rawDescribes.delete(id);},()=>{if(this.rawDescribes.get(id)===captured)this.rawDescribes.delete(id);});}const describe=await this.wait(rawDescribe,LIMITS.describeWaitMs);if(!describe.ok||!describe.value.versions.includes(1))throw new Error('Inbox automatic assignment is unavailable or incompatible.');
      row=this.store.launch(id)!;this.allowed(row,person,validate);if(!this.creationEligible(row,expectedThreadId)||!await this.confirmed(row))throw new Error('The confirmed thread is no longer eligible for automatic assignment.');this.allowed(this.store.launch(id)!,person,validate);
      const claim=randomUUID(),input={operationId:row.status.assignment!.operationId,threadId:row.status.threadId!};
      this.patch(id,value=>({value:{...value,threadId:input.threadId,state:'unknown',retryable:false,message:'Inbox assignment request is awaiting its receipt.'},dispatch:{attempted:true,generation:this.generation,claim,rawPending:true,sent:true}}),()=>{const latest=this.store.launch(id)!;this.allowed(latest,person,validate);if(!this.creationEligible(latest,expectedThreadId))throw new Error('Native creation evidence was retired before assignment dispatch.');});
      const raw=person.callPlugin({pluginId:PROVIDER,method:METHODS.claim,payload:input,output:codec(createdThreadClaimResultSchema)});this.rawClaims.set(id,raw);
      // A late callback records factual outcome only; it never dispatches or reuses a person.
      const settled=raw.then(result=>{
        try{if(result.ok)this.apply(id,result.value);}finally{this.patch(id,(value,latest)=>({value,dispatch:latest.assignmentDispatch?.claim===claim?{...latest.assignmentDispatch,rawPending:false}:latest.assignmentDispatch}));if(this.rawClaims.get(id)===raw)this.rawClaims.delete(id);}return result;
      },error=>{this.patch(id,(value,latest)=>({value,dispatch:latest.assignmentDispatch?.claim===claim?{...latest.assignmentDispatch,rawPending:false}:latest.assignmentDispatch}));if(this.rawClaims.get(id)===raw)this.rawClaims.delete(id);throw error;});
      const result=await this.wait(settled,LIMITS.claimWaitMs);if(!result.ok)throw new Error(result.error.message);if(result.value.status==='rejected')throw new Error(result.value.message);
    }catch(error){if(this.active)this.patch(id,value=>({value:value.receipt||value.state==='unavailable'?value:{...value,state:this.store.launch(id)?.assignmentDispatch?.sent?'unknown':'unavailable',message:error instanceof Error?error.message:'Inbox assignment is unavailable.',retryable:false}}));}
  }
}
