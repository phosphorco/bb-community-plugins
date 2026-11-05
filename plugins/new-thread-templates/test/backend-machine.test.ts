import {test,expect} from 'bun:test';
import {makeHostResponse} from '@get-bb/plugin-sdk/testing';
import {definitionSchema,validateDefinition,type TemplateDefinition} from '../model';
import {launchRequestSchema} from '../rpc-contract';
import {LaunchService} from '../launch';
import {databaseFixture,definition,launchActor,launchRequest,nativeFixture,published} from './backend-fixtures';
const actor={key:launchActor().actor.identity.key,name:'Alice'};
const pinned=(environment:TemplateDefinition['destination']['environment']={kind:'local-source'}):TemplateDefinition=>definition({destination:{kind:'existing-project',projectId:'project-1',hostId:'host-chosen',environment}});
function target(n:ReturnType<typeof nativeFixture>){n.projects[0]!.sources.push({hostId:'host-chosen',path:'/chosen/source',isDefault:false});}

test('optional machine absent round-trips historical definitions and retains primary/default-source routing',async()=>{
  const n=nativeFixture();n.projects[0]!.sources.unshift({hostId:'host-default-source',path:'/default-source',isDefault:true});n.projects[0]!.sources[1]!.isDefault=false;
  const old=definitionSchema.parse(definition());expect(old.destination).not.toHaveProperty('hostId');expect(validateDefinition(old)).toEqual([]);
  expect((await n.native.resolve(old,{task:'fix'})).effects.hostId).toBe('host-main');expect((await n.native.resolve(old,{task:'fix'})).environment).toEqual({type:'project-default'});
  const oldCheckout=definition({destination:{kind:'existing-project',projectId:'project-1',environment:{kind:'local-source'}}});expect((await n.native.resolve(oldCheckout,{task:'fix'})).effects).toMatchObject({hostId:'host-default-source',path:'/default-source'});
});

test('specific machine plus automatic policy can be saved unfinished but cannot publish/preview/resolve',async()=>{
  const f=databaseFixture(),n=nativeFixture();try{
    const original=published(f),invalid=pinned({kind:'project-default'});expect(definitionSchema.safeParse(invalid).success).toBe(true);expect(validateDefinition(invalid).some(i=>i.path==='destination.environment')).toBe(true);
    const draft=f.store.saveDraft(invalid,1,actor);expect(draft.definition.destination).toMatchObject({hostId:'host-chosen'});expect(f.store.publish('test-template',draft.generation,actor).issues[0]!.message).toContain('specific machine');expect(f.store.get('test-template')!.published).toEqual(original);
    expect((await n.native.preview(invalid,{task:'fix'})).effects).toBeNull();await expect(n.native.resolve(invalid,{task:'fix'})).rejects.toThrow('specific machine');expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);expect(n.harness.callsTo('projects.create')).toHaveLength(0);expect(n.harness.callsTo('providers.models')).toHaveLength(0);
  }finally{f.close();}
});

test('specific existing-project checkout resolves selected machine source/catalog and exact native opening seed',async()=>{
  const n=nativeFixture();target(n);const d=pinned({kind:'local-source',branch:'feature'});
  const preview=await n.native.preview(d,{task:'fix'});expect(preview.issues).toEqual([]);expect(preview.effects).toMatchObject({hostId:'host-chosen',hostName:'host-chosen',path:'/chosen/source',routing:{kind:'host',hostId:'host-chosen'},createsProject:false});
  const environment={type:'host',hostId:'host-chosen',workspace:{type:'unmanaged',path:'/chosen/source',branch:{kind:'existing',name:'feature'}}} as const;expect(preview.nativeSeed!.defaultEnvironment).toEqual(environment);expect(preview.nativeSeed!.defaultProjectId).toBe('project-1');expect(preview.effects!.nativeEnvironment).toEqual(environment);
  expect(n.harness.callsTo('hosts.directory')[0]![0]).toEqual({hostId:'host-chosen',path:'/chosen/source'});expect(n.harness.callsTo('providers.models')[0]![0]).toMatchObject({hostId:'host-chosen',projectId:'project-1'});expect(n.harness.callsTo('projects.create')).toHaveLength(0);expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);
});

test('choose-at-launch worktree pins machine independently of primary and uses final selected project defaults',async()=>{
  const n=nativeFixture();n.projects.push({id:'picked-project',name:'Picked',kind:'standard',sources:[{hostId:'host-chosen',path:'/picked',isDefault:false}]});n.defaults.model='picked-model';n.models[0]!.model='picked-model';
  const d=definition({destination:{kind:'choose-at-launch',hostId:'host-chosen',environment:{kind:'worktree',baseBranch:'release'}}});expect(validateDefinition(d)).toEqual([]);const p=await n.native.resolve(d,{task:'fix'},'picked-project');
  expect(p.environment).toEqual({type:'host',hostId:'host-chosen',workspace:{type:'managed-worktree',baseBranch:{kind:'named',name:'release'}}});expect(p.effects).toMatchObject({projectId:'picked-project',hostId:'host-chosen',path:'/picked',execution:{model:'picked-model',inherited:true}});expect(n.harness.callsTo('projects.defaultExecutionOptions')[0]![0]).toEqual({projectId:'picked-project'});expect(n.harness.callsTo('providers.models')[0]![0]).toMatchObject({hostId:'host-chosen',projectId:'picked-project'});
});

test('reuse keeps its actual fixed machine and rejects conflicting saved machine before model preflight',async()=>{
  const n=nativeFixture();n.env.hostId='host-chosen';const d=pinned({kind:'reuse',environmentId:'env-1'});expect((await n.native.resolve(d,{task:'fix'})).effects).toMatchObject({hostId:'host-chosen',routing:{kind:'environment',environmentId:'env-1'}});
  const models=n.harness.callsTo('providers.models').length;const conflict=definition({destination:{...d.destination,hostId:'host-wrong'}});await expect(n.native.resolve(conflict,{task:'fix'})).rejects.toThrow('does not match');expect(n.harness.callsTo('providers.models')).toHaveLength(models);expect(n.harness.callsTo('hosts.directory')).toHaveLength(0);
});

test('unavailable saved machine/source/directory/model blocks native opening and launch before any effect without fallback',async()=>{
  for(const cause of ['offline','missing-source','missing-directory','not-directory','model-outage','missing-model']){
    const f=databaseFixture(),n=nativeFixture();target(n);const d=pinned();published(f,d);const service=new LaunchService(f.store,n.native),request=launchRequestSchema.parse(launchRequest());
    if(cause==='offline')n.harness.stub('hosts.get',async()=>makeHostResponse({id:'host-chosen',status:'disconnected'}));
    if(cause==='missing-source')n.projects[0]!.sources.pop();
    if(cause==='missing-directory')n.harness.stub('hosts.directory',async()=>{throw new Error('Source directory does not exist');});
    if(cause==='not-directory')n.harness.stub('hosts.directory',async()=>{throw new Error('Source is not a directory');});
    if(cause==='model-outage')n.harness.stub('providers.models',async()=>({models:[],selectedOnlyModels:[],modelLoadError:{code:'offline',detail:'Chosen host catalog unavailable'}}));
    if(cause==='missing-model')n.defaults.model='missing-on-chosen-host';
    try{const preview=await n.native.preview(d,{task:'fix'});expect(preview.effects).toBeNull();expect(preview.nativeSeed??null).toBeNull();expect(preview.issues.length).toBeGreaterThan(0);expect(await service.launch(request,launchActor())).toMatchObject({phase:'failed',retryable:true,inputs:{task:'repair bug'}});const row=f.store.launch(request.operationId)!;expect(row.spawnClaim).toBeNull();expect(row.capturedActor).toEqual(launchActor().actor);expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);expect(n.harness.callsTo('projects.create')).toHaveLength(0);for(const args of n.harness.callsTo('providers.models'))expect(args[0]).toMatchObject({hostId:'host-chosen'});}finally{service.dispose();f.close();}
  }
});

test('direct spawn/journal retain selected machine after publication changes/reopen and unknown is never resent',async()=>{
  const f=databaseFixture(),n=nativeFixture();target(n);published(f,pinned());const service=new LaunchService(f.store,n.native),request=launchRequestSchema.parse(launchRequest());n.harness.stub('threads.spawn',async()=>{throw new Error('selected machine response lost');});
  try{
    expect(await service.launch(request,launchActor())).toMatchObject({phase:'indeterminate',threadId:null});const row=f.store.launch(request.operationId)!;expect(row.nativeRequest!.environment).toEqual({type:'host',hostId:'host-chosen',workspace:{type:'unmanaged',path:'/chosen/source'}});expect(row.revision.definition.destination).toMatchObject({hostId:'host-chosen'});
    f.store.saveDraft(definition(),1,actor);f.store.publish('test-template',2,actor);service.dispose();const fresh=new LaunchService(f.reopen(),n.native);expect(await fresh.launch(request,launchActor())).toMatchObject({phase:'indeterminate',retryable:false});expect(f.store.launch(request.operationId)!.nativeRequest).toEqual(row.nativeRequest);expect(f.store.recentLaunches(request.expectedActor).launches[0]!.effects).toMatchObject({hostId:'host-chosen',path:'/chosen/source'});expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);expect(n.harness.callsTo('projects.create')).toHaveLength(0);fresh.dispose();
  }finally{service.dispose();f.close();}
});

test('new project keeps one source machine for provisioning, final model validation and direct spawn',async()=>{
  const f=databaseFixture(),n=nativeFixture();const d=definition({destination:{kind:'new-project',nameTemplate:'Created',hostId:'host-chosen',path:'/new/actual-source',environment:{kind:'local-source'}}});published(f,d);const service=new LaunchService(f.store,n.native),request=launchRequestSchema.parse(launchRequest());
  try{expect(await service.launch(request,launchActor())).toMatchObject({phase:'succeeded'});expect(n.harness.callsTo('projects.create')[0]![0]).toMatchObject({source:{hostId:'host-chosen',path:'/new/actual-source',type:'local_path'}});const row=f.store.launch(request.operationId)!;expect(row.effects!.hostId).toBe('host-chosen');expect(row.nativeRequest!.environment).toEqual({type:'host',hostId:'host-chosen',workspace:{type:'unmanaged',path:'/new/actual-source'}});for(const args of n.harness.callsTo('providers.models'))expect(args[0]).toMatchObject({hostId:'host-chosen'});}finally{service.dispose();f.close();}
});

test('new-project existing-source dedup rechecks that exact source directory before offering native seed or direct dispatch',async()=>{
  const f=databaseFixture(),n=nativeFixture();const d=definition({destination:{kind:'new-project',nameTemplate:'Requested',hostId:'host-main',path:'/src/project',environment:{kind:'local-source'}}});published(f,d);const service=new LaunchService(f.store,n.native),request=launchRequestSchema.parse(launchRequest());
  n.harness.stub('hosts.directory',async()=>{throw new Error('Deduplicated source directory was deleted');});
  try{const p=await n.native.preview(d,{task:'fix'});expect(p.effects).toBeNull();expect(p.nativeSeed??null).toBeNull();expect(p.issues[0]!.message).toContain('directory was deleted');expect(await service.launch(request,launchActor())).toMatchObject({phase:'failed',retryable:true});for(const args of n.harness.callsTo('hosts.directory'))expect(args[0]).toEqual({hostId:'host-main',path:'/src/project'});expect(n.harness.callsTo('projects.create')).toHaveLength(0);expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);expect(f.store.launch(request.operationId)!.spawnClaim).toBeNull();}finally{service.dispose();f.close();}
});
