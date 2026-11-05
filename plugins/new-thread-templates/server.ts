import {InboxAssignmentService} from './inbox-assignment';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { bindBbIdentity, type BbInvocation } from '@phosphorco/bb-identity/bb';
import type { PersonRequest } from '@phosphorco/bb-identity/server';
import type { BbPromptInput } from '@phosphorco/bb-identity/bb';
import type { PluginId } from '@phosphorco/bb-identity/model';
import { inputDraftResource, PLUGIN_ID } from './model';
import { templatesContract, TEMPLATES_CHANGED, TEMPLATES_CATALOG_CHANGED,TEMPLATES_DEFINITIONS_CHANGED,TEMPLATES_JOURNAL_CHANGED, type LaunchRequest } from './rpc-contract';
import { actorSummary, TemplatesStore } from './store';
import { NativeTemplates } from './native';
import { LaunchService } from './launch';

export default function newThreadTemplates(bb:BbPluginApi) {
  const bound=bindBbIdentity(bb);
  if(!bound.ok)throw new Error(bound.error.message);
  const binding=bound.value;
  const store=new TemplatesStore(bb.storage.database());
  store.seed();
  const drafts=binding.state.register({resource:inputDraftResource,storage:store.personalStorage(),policy:{kind:'self-only'},readPolicy:{kind:'collaborators'}});
  if(!drafts.ok)throw new Error(drafts.error.message);
  // Native calls use only the public SDK bound by the host before plugin activation.
  const native=new NativeTemplates(bb.sdk);
  let active=true;
  const changed=()=>{if(active){bb.realtime.publish(TEMPLATES_CHANGED,{});bb.realtime.publish(TEMPLATES_JOURNAL_CHANGED,{});}};
  const definitionsChanged=(catalog=false)=>{if(active){bb.realtime.publish(TEMPLATES_CHANGED,{});bb.realtime.publish(TEMPLATES_DEFINITIONS_CHANGED,{});if(catalog)bb.realtime.publish(TEMPLATES_CATALOG_CHANGED,{});}};
  const launches=new LaunchService(store,native,changed);
  const assignments=new InboxAssignmentService(store,bb.sdk,changed);
  bb.onDispose(()=>{active=false;launches.dispose();assignments.dispose();});
  // An event supplies one thread id; retained metadata is the receipt evidence.
  // There is no history scan, polling, new effect or success inferred from the event alone.
  for(const event of ['thread.created','thread.active','thread.idle','thread.failed','thread.archived','thread.unarchived','thread.deleted'] as const) {
    bb.events.on(event,async({thread})=>{
      if(!active||thread.originPluginId!==PLUGIN_ID)return;
      if(thread.deletedAt!==null||event==='thread.deleted') {
        launches.observeNativeRemoval(thread.id);
        try {const metadata=await native.threadMetadata(thread.id);if(active)launches.observeNativeRemoval(thread.id,metadata);}catch {}
        return;
      }
      try {
        const metadata=await native.threadMetadata(thread.id);
        if(active)launches.observeNativeReceipt(thread.id,metadata,event!=='thread.created'&&(thread.status==='active'||thread.status==='idle')?'accepted':thread.status==='error'?'failed':'pending');
      }catch {
        // Unavailable metadata is not a negative receipt and cannot authorize retry.
      }
    });
  }
  async function person<T>(invocation:BbInvocation,run:(request:PersonRequest<BbPromptInput>)=>Promise<T>|T):Promise<T> {
    const opened=await invocation.person();
    if(!opened.ok)throw new Error(opened.error.message);
    try{return await run(opened.value);}finally{opened.value.dispose();}
  }
  async function writeGuard(request:PersonRequest<BbPromptInput>,collection:string,recordId:string) {
    const captured=await request.target({selection:{kind:'self'},policy:{kind:'self-only'},intent:'write',expected:request.expected,expectedSubject:request.actor.identity.key});
    if(!captured.ok)throw new Error(captured.error.message);
    const target=captured.value;
    return ()=>{
      if(!active)throw new Error('Templates backend is disposed.');
      const valid=binding.server.commits.validate(target,{instanceId:binding.server.instanceId,pluginId:PLUGIN_ID as PluginId,collection,recordId,subject:request.actor.identity.key,expected:request.expected,schemaVersion:1});
      if(!valid.ok)throw new Error(valid.error.message);
    };
  }
  async function runLaunch(input:LaunchRequest,request:PersonRequest<BbPromptInput>) {
    const validate=await writeGuard(request,'launches',input.operationId);
    const status=await launches.launch(input,{actor:request.actor,expected:request.expected,validate});
    if(active&&status.phase==='succeeded'&&status.assignment){try{await assignments.attempt(input.operationId,request,validate);}catch{/* Optional assignment cannot revoke confirmed native creation. */}}
    return store.launch(input.operationId)?.status??status;
  }
  const registered=binding.rpc.register(templatesContract,{
    publishedCatalog:{origin:'interactive-user',handle:()=>({instanceId:binding.server.instanceId,...store.publishedCatalog()})},
    choices:{origin:'interactive-user',handle:input=>native.choices(input)},
    targetPreview:{origin:'interactive-user',handle:input=>native.targetPreview(input)},
    catalog:{origin:'interactive-user',handle:async(_input,invocation)=>person(invocation,()=>({entries:store.catalog()}))},
    context:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>({...await native.context(input),actor:actorSummary(request.actor),session:request.expected.session}))},
    saveDraft:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{const validate=await writeGuard(request,'shared-definitions',input.definition.id);const result=store.saveDraft(input.definition,input.expectedGeneration,actorSummary(request.actor),validate);definitionsChanged();return result;})},
    publish:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{const validate=await writeGuard(request,'shared-definitions',input.templateId);const result=store.publish(input.templateId,input.expectedGeneration,actorSummary(request.actor),validate);if(!result.issues.length)definitionsChanged(true);return result;})},
    unpublish:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{const validate=await writeGuard(request,'shared-definitions',input.templateId);const result=store.unpublish(input.templateId,input.expectedRevision,validate);definitionsChanged(true);return result;})},
    duplicate:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{const validate=await writeGuard(request,'shared-definitions',input.newId);const result=store.duplicate(input.templateId,input.newId,actorSummary(request.actor),validate);definitionsChanged();return result;})},
    remove:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{const validate=await writeGuard(request,'shared-definitions',input.templateId);const result=store.remove(input,actorSummary(request.actor),validate);definitionsChanged(true);return result;})},
    preview:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,()=>native.preview(input.definition,input.inputs,input.projectId,input.renderContext))},
    launch:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,request=>runLaunch(input,request))},
    resumeLaunch:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,request=>{
      if(input.expectedActor!==request.actor.identity.key||input.expectedSession!==request.expected.session||input.checkpoint.request.expectedActor!==request.actor.identity.key)throw new Error('Saved launch requires its original current actor/session.');
      // Session freshness is not business identity; every immutable request field remains pinned.
      return runLaunch({...input.checkpoint.request,expectedSession:input.expectedSession},request);
    })},
    recentSamples:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,request=>({samples:store.recentSamples(request.actor.identity.key,input.templateId)}))},
    recentLaunches:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,request=>store.recentLaunches(request.actor.identity.key,input.offset??0))},
    retryAssignment:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{
      if(input.expectedActor!==request.actor.identity.key||input.expectedSession!==request.expected.session)throw new Error('Captured assignment actor/session changed.');
      const validate=await writeGuard(request,'launches',input.operationId);await assignments.attempt(input.operationId,request,validate,true);const row=store.launch(input.operationId);if(!row)throw new Error('Launch operation not found');return row.status;
    })},
    launchStatus:{origin:'interactive-user',handle:async(input,invocation)=>person(invocation,async request=>{
      const status=await launches.status(input.operationId),row=store.launch(input.operationId);
      if(active&&status?.assignment&&row?.capturedActor.identity.key===request.actor.identity.key){try{const validate=await writeGuard(request,'launches',input.operationId);await assignments.check(input.operationId,request,validate);}catch{/* Read-only assignment recovery never masks the native receipt. */}}
      return store.launch(input.operationId)?.status??status;
    })},
  });
  if(!registered.ok)throw new Error(registered.error.message);
  // No plugin-owned timers/background services. Durable reconciliation is bounded request work.
}
