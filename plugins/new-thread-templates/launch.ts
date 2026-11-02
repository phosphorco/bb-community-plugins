import {eligibleCreatedThreadActor} from './inbox-assignment-contract';
import { randomUUID } from 'node:crypto';
import type { ActorSnapshot } from '@phosphorco/bb-identity/model';
import { PLUGIN_ID, validateDefinition, validateInputs,createRenderContext } from './model';
import { launchRequestSchema, type LaunchRequest, type LaunchStatus } from './rpc-contract';
import { actorSummary, canonical, fingerprint, TemplatesStore, type LaunchRecord } from './store';
import { nativeRequestSchema, matchesNativeReceipt, type NativePort } from './native';

export interface LaunchActor {
  actor:ActorSnapshot;
  expected:{actor:string;session:string};
  /** Package-issued target commit validation; synchronous and lifecycle bound. */
  validate():void;
}
function message(error:unknown) {return error instanceof Error?error.message:String(error);}
export class LaunchService {
  private active=true;
  constructor(readonly store:TemplatesStore,readonly native:NativePort,readonly changed:()=>void=()=>{}) {
    // Rotate pre-effect claims so an older generation can never progress on resume.
    // Claimed effects become unknown and remain read-only until a receipt is found.
    store.recoverInterrupted();
  }
  dispose() {this.active=false;}
  private sample(id:string) {try{this.store.captureSample(id);}catch(error){try{const row=this.store.launch(id);if(row?.sampleIntent&&!row.sampleRecorded)this.store.transition(id,row.token,['succeeded'],r=>({...r,status:{...r.status,sampleCapture:{state:'unavailable',message:'Recent input sample could not be saved.'}}}));}catch{/* A sample failure cannot revoke the committed native receipt. */}}}
  private validate(context:LaunchActor,request:LaunchRequest) {
    if(!this.active)throw new Error('Templates backend was disposed before dispatch.');
    if(context.expected.actor!==request.expectedActor || context.expected.session!==request.expectedSession || context.actor.identity.key!==request.expectedActor)throw new Error('Captured actor/session changed. Refresh before starting a new launch.');
    context.validate();
  }
  async launch(raw:LaunchRequest,context:LaunchActor):Promise<LaunchStatus> {
    const request=launchRequestSchema.parse(raw);const {expectedSession:_session,...businessRequest}=request;const hash=fingerprint(businessRequest);
    // Existing immutable work survives edits, unpublish and current identity changes.
    let record=this.store.launch(request.operationId);
    if(record) {
      if(context.actor.identity.key!==record.capturedActor.identity.key)throw new Error('This launch belongs to a different captured actor');
      if(record.fingerprint!==hash)throw new Error('Operation id already belongs to a different immutable launch');
      if(record.status.phase==='failed'&&record.status.retryable) {
        this.validate(context,request);
        const resumed=this.store.resume(request.operationId,()=>this.validate(context,request));
        if(!resumed)return (await this.status(request.operationId))!;
        record=resumed;
      } else return (await this.status(request.operationId))!;
    } else {
      const reject=(reason:string):LaunchStatus=>({operationId:request.operationId,templateId:request.templateId,revision:request.revision,phase:'rejected',projectId:null,threadId:null,message:reason,retryable:false,actor:actorSummary(context.actor),inputs:request.inputs,nativeAttribution:'plugin-origin',createdAt:this.store.now(),updatedAt:this.store.now()});
      try{this.validate(context,request);}catch(error){return reject(message(error));}
      const entry=this.store.get(request.templateId);
      const revision=this.store.revision(request.templateId,request.revision);
      if(!revision)return reject('Published revision not found. Reload before launching.');
      const checked=validateInputs(revision.definition,request.inputs);
      const issues=[...validateDefinition(revision.definition),...checked.issues];
      const rejected=!entry?.published||entry.published.revision!==request.revision?'Published template revision changed or was unpublished. Reload before launching.':issues.length?issues.map(i=>`${i.path}: ${i.message}`).join('\n'):null;
      const now=this.store.now();
      const admittedContext=request.renderContext??createRenderContext(revision.definition.timeZone??'UTC',now);
      const proposed:LaunchRecord={renderContext:admittedContext,sampleIntent:true,request,revision,fingerprint:hash,token:randomUUID(),capturedActor:context.actor,effects:null,nativeRequest:null,creation:null,projectClaim:null,spawnClaim:null,confirmation:null,status:{renderContext:admittedContext,operationId:request.operationId,templateId:request.templateId,revision:request.revision,phase:rejected?'rejected':'preparing',projectId:null,threadId:null,message:rejected,retryable:false,actor:actorSummary(context.actor),inputs:checked.inputs,nativeAttribution:'plugin-origin',...(eligibleCreatedThreadActor(context.actor)?{assignment:{operationId:'new-thread-templates:'+request.operationId,actorKey:context.actor.identity.key,threadId:null,state:'pending' as const,message:'Thread creation must be confirmed before assignment.',retryable:false}}:{}),createdAt:now,updatedAt:now}};
      const inserted=this.store.insertLaunch(proposed,()=>this.validate(context,request));
      if(!inserted.created)return (await this.status(request.operationId))!;
      record=inserted.record;
      if(rejected){this.changed();return record.status;}
    }
    this.changed();
    const id=record.status.operationId;const token=record.token;
    try {
      this.validate(context,request);
      let preparation=request.nativeSubmission?await this.native.resolveNative(record.revision.definition,record.status.inputs,request.nativeSubmission,request.projectId,record.renderContext):await this.native.resolve(record.revision.definition,record.status.inputs,request.projectId,record.status.projectId??undefined,record.renderContext);
      const prepared=this.store.transition(id,token,['preparing'],r=>({...r,effects:preparation.effects,creation:preparation.creation,status:{...r.status,projectId:preparation.effects.projectId}}),()=>this.validate(context,request));
      if(!prepared)return (await this.status(id))!;
      record=prepared;
      if(preparation.creation) {
        const effectClaim=randomUUID();
        const claimed=this.store.transition(id,token,['preparing'],r=>({...r,projectClaim:effectClaim,status:{...r.status,phase:'project-claimed'}}),()=>this.validate(context,request));
        if(!claimed)return (await this.status(id))!;
        this.changed();
        let projectId:string;
        try {projectId=await this.native.createProject(preparation.creation);}catch(error) {
          const unknown=this.store.transition(id,token,['project-claimed'],r=>({...r,status:{...r.status,phase:'project-unknown',retryable:false,message:`Project creation outcome is unknown: ${message(error)}. Check the source receipt before continuing.`}}));
          this.changed();return (unknown??this.store.launch(id))!.status;
        }
        // This records only the completed effect. It does not grant another effect.
        const saved=this.store.completeEffect(id,'project',effectClaim,token,projectId);
        if(!saved)return (await this.status(id))!;
        record=saved;
        this.validate(context,request);
        // FINAL project defaults and catalog, including a native dedup winner.
        preparation=await this.native.resolve(record.revision.definition,record.status.inputs,request.projectId,projectId,record.renderContext);
      }
      const nativeRequest=nativeRequestSchema.parse({projectId:record.status.projectId??preparation.effects.projectId,...(request.nativeSubmission?{input:request.nativeSubmission.input}:{prompt:preparation.effects.prompt}),...(preparation.effects.title.trim()?{title:preparation.effects.title}:{}),environment:preparation.environment,...preparation.execution,pluginMetadata:{operationId:id,fingerprint:record.fingerprint,templateId:record.revision.templateId,revision:record.revision.revision,actor:record.capturedActor,inputs:record.status.inputs,mode:request.nativeSubmission?'native':'template',nativeAttribution:'plugin-origin'}});
      const spawnClaim=randomUUID();
      const claimed=this.store.transition(id,token,['preparing','ready'],r=>({...r,spawnClaim,effects:preparation.effects,nativeRequest:JSON.parse(JSON.stringify(nativeRequest)),status:{...r.status,phase:'spawn-claimed',retryable:false}}),()=>this.validate(context,request));
      if(!claimed)return (await this.status(id))!;
      this.changed();
      let threadId:string;
      try {threadId=await this.native.spawn(nativeRequest);}catch(error) {
        const unknown=this.store.rejectSpawn(id,spawnClaim,'Native creation was not acknowledged: '+message(error)+'. Check the receipt; this launch will not be sent again.');
        this.changed();return (unknown??this.store.launch(id))!.status;
      }
      const success=this.store.completeEffect(id,'spawn',spawnClaim,token,threadId);
      if(success?.status.phase==='succeeded')this.sample(id);
      this.changed();return this.store.launch(id)!.status;
    }catch(error) {
      // Only pre-effect phases can become retryable. Claimed native calls remain unknown.
      const failed=this.store.transition(id,token,['preparing','ready'],r=>({...r,status:{...r.status,phase:'failed',retryable:true,message:message(error)}}));
      this.changed();if(failed)return failed.status;
      const current=this.store.launch(id);if(current)return current.status;throw error;
    }
  }
  observeNativeReceipt(threadId:string,metadata:unknown,evidence:'pending'|'accepted'|'failed'):void {
    if(!this.active||!metadata||typeof metadata!=='object'||!('operationId' in metadata)||typeof metadata.operationId!=='string')return;
    const record=this.store.launch(metadata.operationId);
    if(!record?.spawnClaim||this.store.wasThreadRemoved(threadId)||!['spawn-claimed','indeterminate'].includes(record.status.phase)||!matchesNativeReceipt(metadata,record))return;
    const completed=evidence==='accepted'
      ?this.store.completeEffect(record.status.operationId,'spawn',record.spawnClaim,record.token,threadId,'lifecycle')
      :this.store.transition(record.status.operationId,record.token,['spawn-claimed','indeterminate'],r=>({...r,status:{...r.status,phase:'indeterminate',threadId:null,candidate:{threadId,state:evidence==='failed'?'failed':'pending'},retryable:false,message:evidence==='failed'?'A provisional thread failed before native creation was confirmed. This launch will not be sent again.':'A provisional thread exists, but native creation has not been confirmed. Check its status; this launch will not be sent again.'}}));
    if(evidence==='accepted'&&completed?.status.phase==='succeeded')this.sample(record.status.operationId);
    if(completed&&canonical(completed.status)!==canonical(record.status))this.changed();
  }
  observeNativeRemoval(threadId:string,metadata?:unknown):void {
    if(!this.active)return;
    this.store.markThreadRemoved(threadId);
    let record=this.store.launchForThread(threadId);
    if(!record&&metadata&&typeof metadata==='object'&&'operationId' in metadata&&typeof metadata.operationId==='string') {
      const candidate=this.store.launch(metadata.operationId);
      if(candidate&&matchesNativeReceipt(metadata,candidate))record=candidate;
    }
    if(!record||record.confirmation==='native-ack')return;
    const updated=this.store.transition(record.status.operationId,record.token,['spawn-claimed','indeterminate','succeeded'],r=>({...r,token:randomUUID(),confirmation:null,status:{...r.status,phase:'indeterminate',threadId:null,candidate:{threadId,state:'deleted'},retryable:false,message:'The provisional thread was deleted before native creation was confirmed. This launch will not be sent again.'}}));
    if(updated&&canonical(updated.status)!==canonical(record.status))this.changed();
  }
  async status(id:string):Promise<LaunchStatus|null> {
    const record=this.store.launch(id);if(!record)return null;
    if(record.status.candidate?.state==='deleted'&&record.status.phase!=='succeeded')return record.status;
    if(['project-claimed','project-unknown'].includes(record.status.phase)&&record.creation) {
      try {
        const projectId=await this.native.findProject(record.creation);
        if(projectId) {
          // Revoke the old continuation before a later explicit preparation retry.
          const recovered=this.store.transition(id,record.token,['project-claimed','project-unknown'],r=>({...r,token:randomUUID(),status:{...r.status,phase:'failed',projectId,retryable:true,message:'Recovered the native project source receipt. Retry this same operation to start the thread.'}}));
          if(recovered){this.changed();return recovered.status;}
        }
      }catch(error) {
        const updated=this.store.transition(id,record.token,['project-claimed','project-unknown'],r=>({...r,status:{...r.status,message:`Project receipt unavailable: ${message(error)}. No provisioning was resent.`}}));
        return (updated??this.store.launch(id))!.status;
      }
      return this.store.launch(id)!.status;
    }
    if(record.status.phase==='spawn-claimed'||record.status.phase==='indeterminate') {
      try {
        const receipt=await this.native.findThread(record);
        const updated=this.store.transition(id,record.token,['spawn-claimed','indeterminate'],r=>({...r,confirmation:receipt.threadId?'lifecycle':r.confirmation,status:{...r.status,...(r.sampleIntent&&!r.sampleRecorded&&receipt.threadId&&!this.store.wasThreadRemoved(receipt.threadId)?{sampleCapture:{state:'unavailable' as const,message:'Recent input sample has not been saved.'}}:{}),phase:receipt.threadId&&!this.store.wasThreadRemoved(receipt.threadId)?'succeeded':'indeterminate',threadId:receipt.threadId&&!this.store.wasThreadRemoved(receipt.threadId)?receipt.threadId:null,candidate:receipt.candidate??r.status.candidate??null,retryable:false,message:!receipt.threadId&&r.status.candidate?.state==='deleted'?'The provisional thread was deleted before native creation was confirmed. This launch will not be sent again.':receipt.message}}));
        if(updated){if(updated.status.phase==='succeeded')this.sample(id);if(canonical(updated.status)!==canonical(record.status))this.changed();return this.store.launch(id)!.status;}
      }catch(error) {
        const updated=this.store.transition(id,record.token,['spawn-claimed','indeterminate'],r=>({...r,status:{...r.status,phase:'indeterminate',retryable:false,message:`Native receipt unavailable: ${message(error)}. This launch will not be sent again.`}}));
        return (updated??this.store.launch(id))!.status;
      }
    }
    return this.store.launch(id)!.status;
  }
}
