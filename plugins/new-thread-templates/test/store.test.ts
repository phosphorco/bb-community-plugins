import { test, expect } from 'bun:test';
import { defineStateStorageConformance, personFixture } from '@phosphorco/bb-identity/testing';
import { idCodec } from '@phosphorco/bb-identity/model';
import { databaseFixture, definition, alice, published } from './backend-fixtures';
import { legacyPrReviewDefinition, prReviewDefinition } from '../model';
import { LaunchService } from '../launch';
import { nativeFixture, launchActor, launchRequest } from './backend-fixtures';
import type { LaunchRequest } from '../rpc-contract';
import type { StateAddress } from '@phosphorco/bb-identity/state';
function id<K extends string>(kind:K,value:string){const r=idCodec(kind).decode(value);if(!r.ok)throw new Error(r.error.message);return r.value;}
const actor={key:alice.identity.key,name:'Alice'};

test('publication is immutable, unfinished draft/failure preserves last published, unpublish keeps history',()=>{
  const f=databaseFixture();try{const first=published(f);const next=f.store.saveDraft({...definition(),promptTemplate:'{{missing}}'},1,actor);expect(next.generation).toBe(2);expect(f.store.publish('test-template',2,actor).issues.length).toBeGreaterThan(0);expect(f.store.get('test-template')!.published).toEqual(first);expect(()=>f.store.saveDraft(definition(),1,actor)).toThrow('changed');f.store.unpublish('test-template',1);expect(f.store.get('test-template')!.published).toBeNull();expect(f.store.revision('test-template',1)).toEqual(first);f.reopen();expect(f.store.revision('test-template',1)).toEqual(first);}finally{f.close();}
});
test('collaborator editing has no custom roles, commit validator fences stale write and duplicate CAS',()=>{
  const f=databaseFixture();try{published(f);expect(()=>f.store.saveDraft(definition(),1,{key:'bob',name:'Bob'},()=>{throw new Error('stale owner');})).toThrow('stale owner');expect(f.store.get('test-template')!.draft!.generation).toBe(1);const changed=f.store.saveDraft({...definition(),description:'Bob edit'},1,{key:'bob',name:'Bob'});expect(changed.editedBy.key).toBe('bob');expect(f.store.duplicate('test-template','copy',actor).definition.id).toBe('copy');expect(()=>f.store.duplicate('test-template','copy',actor)).toThrow('changed');}finally{f.close();}
});
test('seed is idempotent and includes only the two customer defaults',()=>{const f=databaseFixture();try{f.store.seed();f.store.seed();expect(f.store.catalog()).toHaveLength(2);expect(f.store.get('start-project')).toBeNull();expect(f.store.get('review-pr')!.published!.revision).toBe(1);}finally{f.close();}});

defineStateStorageConformance({
  test:(name,run)=>test(name,run),
  open:({now})=>{const f=databaseFixture(now);return {storage:f.store.personalStorage(),reopen:()=>f.reopen().personalStorage(),insideCommit:()=>f.db.inTransaction,close:()=>f.close()};},
  address:(recordId):StateAddress=>({instanceId:id('instance','templates-instance'),pluginId:id('plugin','new-thread-templates'),collection:'input-drafts',recordId,owner:alice.identity.key}),
  values:[{inputs:{task:'one'}},{inputs:{task:'two'}}],actor:personFixture({subject:'alice',name:'Alice'}),
});

test('fresh customer defaults seed PR Review and Feedback Session with required subject/focus, once',()=>{
  const f=databaseFixture();try{f.store.seed();const pr=f.store.get('review-pr')!.published!;expect(pr.definition.name).toBe('PR Review');expect(pr.definition.fields.filter(field=>field.required).map(field=>field.key)).toEqual(['pr_url','subject']);const feedback=f.store.get('feedback-session')!.published!;expect(feedback.definition.name).toBe('Feedback Session');expect(feedback.definition.fields.filter(field=>field.required).map(field=>field.key)).toEqual(['subject','focus']);expect(f.store.get('pr-review-default')).toBeNull();const before=f.store.catalog();f.store.seed();expect(f.store.catalog()).toEqual(before);}finally{f.close();}
});
test('untouched legacy starter upgrades through CAS/publication while retaining old revisions and launch snapshot',async()=>{
  const f=databaseFixture();const starter={key:'starter',name:'New Thread Templates'};const n=nativeFixture();let service:LaunchService|undefined;
  try{
    const legacy=legacyPrReviewDefinition();f.store.saveDraft(legacy,null,starter);const original=f.store.publish(legacy.id,1,starter).entry.published!;
    service=new LaunchService(f.store,n.native);
    const request={...launchRequest(),templateId:'review-pr',projectId:'project-1',inputs:{pr_url:'https://example.com/pr/4',focus:'Old scope'}} as LaunchRequest;
    expect((await service.launch(request,launchActor())).phase).toBe('succeeded');
    const launch=f.store.launch(request.operationId)!;f.store.seed();
    expect(f.store.get('review-pr')!.draft!.generation).toBe(2);expect(f.store.get('review-pr')!.published!.revision).toBe(2);expect(f.store.get('review-pr')!.published!.definition).toEqual(prReviewDefinition());expect(f.store.revision('review-pr',1)).toEqual(original);expect(f.store.launch(request.operationId)).toEqual(launch);
    const before=f.store.catalog();f.reopen().seed();expect(f.store.catalog()).toEqual(before);expect(f.store.get('pr-review-default')).toBeNull();
  }finally{service?.dispose();f.close();}
});
test('diverged legacy draft is preserved byte-for-byte and customer default is separately available',()=>{
  const f=databaseFixture();const starter={key:'starter',name:'New Thread Templates'};
  try{f.store.saveDraft(legacyPrReviewDefinition(),null,starter);f.store.publish('review-pr',1,starter);f.store.saveDraft({...legacyPrReviewDefinition(),name:'Our authored PR flow',promptTemplate:'Our review {{pr_url}}'},1,actor);const authored=f.store.get('review-pr');f.store.seed();expect(f.store.get('review-pr')).toEqual(authored);expect(f.store.get('pr-review-default')!.published!.definition).toEqual(prReviewDefinition('pr-review-default'));expect(f.store.get('feedback-session')!.published!.definition.name).toBe('Feedback Session');const before=f.store.catalog();f.store.seed();expect(f.store.catalog()).toEqual(before);}finally{f.close();}
});
test('published collaborator changes and occupied fallback IDs are never replaced by seed upgrade',()=>{
  const f=databaseFixture();const starter={key:'starter',name:'New Thread Templates'};
  try{f.store.saveDraft(legacyPrReviewDefinition(),null,starter);f.store.publish('review-pr',1,starter);f.store.saveDraft({...legacyPrReviewDefinition(),description:'Our changes'},1,actor);f.store.publish('review-pr',2,actor);f.store.saveDraft({...definition(),id:'pr-review-default',name:'Our unrelated template'},null,actor);f.store.publish('pr-review-default',1,actor);const primary=f.store.get('review-pr'),occupied=f.store.get('pr-review-default');f.store.seed();expect(f.store.get('review-pr')).toEqual(primary);expect(f.store.get('pr-review-default')).toEqual(occupied);expect(f.store.get('pr-review-default-2')!.published!.definition).toEqual(prReviewDefinition('pr-review-default-2'));}finally{f.close();}
});
test('migration marker prevents later authored edit/unpublish from resurrecting another default',()=>{
  const f=databaseFixture();try{f.store.seed();f.store.unpublish('review-pr',1);f.store.saveDraft({...prReviewDefinition(),name:'Our draft'},1,actor);const before=f.store.get('review-pr');f.store.seed();expect(f.store.get('review-pr')).toEqual(before);expect(f.store.get('pr-review-default')).toBeNull();}finally{f.close();}
});
test('failed customer migration rolls back draft/revision/marker and can safely retry',()=>{
  const f=databaseFixture();const starter={key:'starter',name:'New Thread Templates'};
  try{f.store.saveDraft(legacyPrReviewDefinition(),null,starter);f.store.publish('review-pr',1,starter);const before=f.store.get('review-pr');const publish=f.store.publish.bind(f.store);f.store.publish=()=>{throw new Error('injected publication storage failure');};expect(()=>f.store.seed()).toThrow('injected publication');expect(f.store.get('review-pr')).toEqual(before);expect(f.store.revision('review-pr',2)).toBeNull();f.store.publish=publish;f.store.seed();expect(f.store.get('review-pr')!.published!.revision).toBe(2);}finally{f.close();}
});
