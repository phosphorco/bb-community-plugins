import {test,expect} from 'bun:test';
import {idCodec} from '@phosphorco/bb-identity/model';
import type {StateAddress} from '@phosphorco/bb-identity/state';
import {legacyGenericStarterDefinitions,legacyPrReviewDefinition,prReviewDefinition,type TemplateEntry,type PersonalDraft} from '../model';
import {LaunchService} from '../launch';
import {databaseFixture,definition,published,alice,nativeFixture,launchRequest,launchActor,nativeSubmission} from './backend-fixtures';
import {launchRequestSchema,type RemoveRequest} from '../rpc-contract';
const actor={key:alice.identity.key,name:'Alice'};
const starter={key:'starter',name:'New Thread Templates'};
function removal(entry:TemplateEntry):RemoveRequest{return {templateId:entry.id,expectedGeneration:entry.draft?.generation??null,expectedRevision:entry.published?.revision??null,expectedLatestRevision:entry.latestRevision};}
function id<K extends string>(kind:K,value:string){const r=idCodec(kind).decode(value);if(!r.ok)throw new Error(r.error.message);return r.value;}

test('remove persists original entry/revisions/launches/personal origin, hides catalog and permanently reserves ID after reopen',async()=>{
  const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native),request=launchRequestSchema.parse(launchRequest());
  const address:StateAddress={instanceId:id('instance','test'),pluginId:id('plugin','new-thread-templates'),collection:'input-drafts',recordId:'test-template',owner:alice.identity.key};
  try{
    expect(await service.launch(request,launchActor())).toMatchObject({phase:'succeeded'});const journal=f.store.launch(request.operationId),entry=f.store.get('test-template')!,revision=f.store.revision('test-template',1);
    const storage=f.store.personalStorage(),read=await storage.read(address);if(!read.ok||read.value.status!=='empty')throw new Error('Expected empty state');
    const value:PersonalDraft={inputs:request.inputs,operationId:request.operationId,revision:1,nativeEditor:{editorDraftId:crypto.randomUUID(),instanceId:'test',actor:alice.identity.key,templateId:'test-template',revision:1,inputs:request.inputs,seed:{defaultProjectId:'project-1',defaultEnvironment:{type:'project-default'},initialPrompt:'Original native draft'},title:'Original title',createdAt:1},nativeOperation:{templateId:'test-template',revision:1,inputs:request.inputs,nativeSubmission:nativeSubmission()}};
    expect((await storage.commit({mutation:{kind:'initialize',address,expectedVersion:read.value.version,expected:{actor:alice.identity.key,session:id('server-session','s')},ownerSession:id('owner-session','owner'),localGeneration:1,operationId:id('operation','save-inputs'),schemaVersion:1,value},validateAtCommit:()=>({ok:true,value:alice})})).ok).toBe(true);
    const personal=await storage.read(address),raw=f.db.prepare('SELECT data FROM templates WHERE id=?').get(entry.id);
    f.store.duplicate(entry.id,'kept-copy',actor);const receipt=f.store.remove(removal(entry),actor,()=>expect(f.db.inTransaction).toBe(true));
    expect(receipt.removedBy).toEqual(actor);expect(f.store.remove(removal(entry),{key:'bob',name:'Bob'})).toEqual(receipt);expect(f.store.get(entry.id)).toBeNull();expect(f.store.catalog().some(e=>e.id===entry.id)).toBe(false);expect(f.store.get('kept-copy')).not.toBeNull();
    expect(f.db.prepare('SELECT data FROM templates WHERE id=?').get(entry.id)).toEqual(raw);expect(f.store.revision(entry.id,1)).toEqual(revision);expect(f.store.launch(request.operationId)).toEqual(journal);expect(await storage.read(address)).toEqual(personal);
    expect(()=>f.store.saveDraft(definition(),null,actor)).toThrow('removed');expect(()=>f.store.saveDraft(definition(),entry.draft!.generation,actor)).toThrow('removed');expect(()=>f.store.publish(entry.id,1,actor)).toThrow('changed');expect(()=>f.store.unpublish(entry.id,1)).toThrow('changed');expect(()=>f.store.duplicate(entry.id,'another',actor)).toThrow('not found');
    expect(await service.launch(request,launchActor())).toMatchObject({phase:'succeeded'});const rejected=await service.launch({...request,operationId:crypto.randomUUID()},launchActor());expect(rejected.phase).toBe('rejected');expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);
    service.dispose();f.reopen().seed();expect(f.store.get(entry.id)).toBeNull();expect(f.store.revision(entry.id,1)).toEqual(revision);expect(f.store.launch(request.operationId)).toEqual(journal);expect(await f.store.personalStorage().read(address)).toEqual(personal);expect(()=>f.store.saveDraft(definition(),null,actor)).toThrow('removed');
  }finally{service.dispose();f.close();}
});

test('remove CAS detects draft edits, publication change and publish/unpublish ABA; failed commit guard cannot tombstone',()=>{
  for(const change of ['draft','unpublish','publication-aba','guard']){
    const f=databaseFixture();try{
      published(f);if(change==='publication-aba')f.store.unpublish('test-template',1);const expected=removal(f.store.get('test-template')!);
      if(change==='draft')f.store.saveDraft({...definition(),name:'A collaborator edit'},1,{key:'bob',name:'Bob'});
      if(change==='unpublish')f.store.unpublish('test-template',1);
      if(change==='publication-aba'){f.store.publish('test-template',1,actor);f.store.unpublish('test-template',2);}
      const before=f.store.get('test-template');expect(()=>f.store.remove(expected,actor,()=>{if(change==='guard')throw new Error('captured session expired');})).toThrow(change==='guard'?'captured session expired':'changed');expect(f.store.get('test-template')).toEqual(before);expect(f.db.prepare('SELECT id FROM template_tombstones').all()).toEqual([]);
    }finally{f.close();}
  }
});

test('customer seed tombstones survive reload and customer migration never invents a replacement for removed primary/fallback',()=>{
  for(const target of ['review-pr','feedback-session','pr-review-default']){
    const f=databaseFixture();try{
      if(target==='pr-review-default'){
        f.store.saveDraft({...legacyPrReviewDefinition(),name:'Our authored diverged PR'},null,actor);f.store.publish('review-pr',1,actor);f.store.saveDraft(prReviewDefinition(target),null,starter);f.store.publish(target,1,starter);
      }else {const d=target==='review-pr'?prReviewDefinition():definition({id:target});f.store.saveDraft(d,null,starter);f.store.publish(target,1,starter);}
      const original=f.store.get(target)!;f.store.remove(removal(original),actor);f.store.seed();f.reopen().seed();expect(f.store.get(target)).toBeNull();expect(f.store.revision(target,1)!.definition).toEqual(original.published!.definition);expect(f.store.get('pr-review-default-2')).toBeNull();
      if(target==='pr-review-default')expect(f.store.get('review-pr')!.draft!.definition.name).toBe('Our authored diverged PR');
    }finally{f.close();}
  }
});

test('new seeds never create generic starters and never remove or rewrite existing exact/diverged generic/customer content',()=>{
  const f=databaseFixture();try{
    const legacy=legacyGenericStarterDefinitions();for(const d of legacy){f.store.saveDraft(d,null,starter);if(d.id!=='start-project')f.store.publish(d.id,1,starter);}
    f.store.saveDraft({...legacy[0]!,name:'Genuinely authored custom work'},1,actor);f.store.publish('fix-bug',2,actor);
    f.store.saveDraft({...prReviewDefinition(),name:'Customer PR choice'},null,actor);f.store.publish('review-pr',1,actor);
    const before=f.store.catalog();f.store.seed();for(const e of before)expect(f.store.get(e.id)).toEqual(e);
    const removed=f.store.get('explore-idea')!;f.store.remove(removal(removed),actor);f.reopen().seed();expect(f.store.get('explore-idea')).toBeNull();expect(f.store.get('fix-bug')!.published!.definition.name).toBe('Genuinely authored custom work');
  }finally{f.close();}
});

test('prior unknown remains check-only and safe pinned preparation retry works after template removal',async()=>{
  for(const phase of ['unknown','pre-effect']){
    const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native);const request=launchRequestSchema.parse(launchRequest());
    if(phase==='unknown')n.harness.stub('threads.spawn',async()=>{throw new Error('response missing');});else n.harness.stub('providers.models',async()=>{throw new Error('host offline before effect');});
    try{
      expect((await service.launch(request,launchActor())).phase).toBe(phase==='unknown'?'indeterminate':'failed');f.store.remove(removal(f.store.get('test-template')!),actor);
      if(phase==='unknown'){expect(await service.status(request.operationId)).toMatchObject({phase:'indeterminate',threadId:null,retryable:false});expect(await service.launch(request,launchActor())).toMatchObject({phase:'indeterminate'});expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);}
      else{n.harness.stub('providers.models',async()=>({models:n.models,selectedOnlyModels:[],modelLoadError:null,permissionCeiling:'auto'}));expect(await service.launch({...request,expectedSession:'fresh'},launchActor('fresh'))).toMatchObject({phase:'succeeded'});expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);}
      expect(f.store.recentLaunches(request.expectedActor).launches[0]!.revision.templateId).toBe('test-template');expect(n.harness.callsTo('projects.create')).toHaveLength(0);
    }finally{service.dispose();f.close();}
  }
});
