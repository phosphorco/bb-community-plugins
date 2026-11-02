import {test,expect} from 'bun:test';
import {deferred} from '@phosphorco/bb-identity/testing';
import {LaunchService} from '../launch';
import {z} from 'zod';
import type {NativeSubmission} from '../native-submission';
import {launchRequestSchema} from '../rpc-contract';
import {databaseFixture,definition,published,nativeFixture,launchRequest,launchActor,nativeSubmission} from './backend-fixtures';
function setup() {
  const f=databaseFixture();published(f);const n=nativeFixture();const service=new LaunchService(f.store,n.native);
  const request=launchRequestSchema.parse(launchRequest({nativeSubmission:nativeSubmission()}));return {f,n,service,request};
}
function futureProvider(n:ReturnType<typeof nativeFixture>) {
  n.harness.stub('environments.listProviders',async()=>[{id:'cloud-composition',displayName:'Cloud workspace',machineProviderId:'cloud-vm',environmentProviderId:'container',machineAvailability:{},availability:null},{id:'container',displayName:'Container',machineProviderId:null,machineAvailability:{'host-main':{status:'unavailable',message:'Not supported on existing machine'}},availability:null}]);
  n.harness.stub('hosts.experimental_listProviders',async()=>[{id:'cloud-vm'}]);
}
test('native journals exact structured public request/actor with selected destination and original title',async()=>{
  const s=setup();s.n.projects.push({id:'chosen-project',name:'Chosen project',kind:'standard',sources:[{hostId:'host-chosen',path:'/chosen',isDefault:true}]});
  const native:NativeSubmission={...nativeSubmission(),projectId:'chosen-project',sendAt:1900000000000,environment:{type:'host',hostId:'host-chosen',workspace:{type:'unmanaged',path:null,branch:{kind:'existing',name:'topic'}}}};
  const request={...s.request,nativeSubmission:native};
  try {
    expect(await s.service.launch(request,launchActor())).toMatchObject({phase:'succeeded',projectId:'chosen-project'});
    const row=s.f.store.launch(request.operationId)!;expect(row.request.nativeSubmission).toEqual(native);expect(row.capturedActor).toEqual(launchActor().actor);
    expect(row.nativeRequest).toMatchObject({...native,title:'Task repair bug'});expect(row.nativeRequest).not.toHaveProperty('prompt');
    expect(row.nativeRequest!.pluginMetadata).toMatchObject({actor:launchActor().actor,inputs:{task:'repair bug'},mode:'native'});
    expect(row.effects).toMatchObject({mode:'native',validation:'target-host',hostId:'host-chosen',hostName:'host-chosen',projectName:'Chosen project',execution:{permissionMode:'auto',inherited:false}});
    expect(s.n.harness.callsTo('providers.models')[0]![0]).toMatchObject({hostId:'host-chosen',projectId:'chosen-project'});
    expect(s.n.harness.callsTo('projects.defaultExecutionOptions')).toHaveLength(0);expect(s.n.harness.callsTo('projects.create')).toHaveLength(0);
    expect(s.f.store.recentLaunches(request.expectedActor).launches[0]!.nativeSubmission).toEqual(native);
  }finally{s.service.dispose();s.f.close();}
});
test('dedup origin can move after editor opening without old-source lookup/provision or native destination invalidation',async()=>{
  const f=databaseFixture();const def=definition({destination:{kind:'new-project',nameTemplate:'Origin',hostId:'host-main',path:'/src/project',environment:{kind:'local-source'}}});published(f,def);const n=nativeFixture();const service=new LaunchService(f.store,n.native);
  try{
    expect((await n.native.preview(def,{task:'repair bug'})).nativeSeed!.defaultProjectId).toBe('project-1');
    n.projects[0]!.sources[0]!.path='/moved';n.projects.push({id:'chosen',name:'Actual',kind:'standard',sources:[{hostId:'host-main',path:'/actual',isDefault:true}]});const lists=n.harness.callsTo('projects.list').length;
    const req=launchRequestSchema.parse(launchRequest({nativeSubmission:{...nativeSubmission(),projectId:'chosen'}}));expect(await service.launch(req,launchActor())).toMatchObject({phase:'succeeded',projectId:'chosen'});
    expect(n.harness.callsTo('projects.list')).toHaveLength(lists);expect(n.harness.callsTo('projects.create')).toHaveLength(0);
    const newPreview=await n.native.preview({...def,destination:{kind:'new-project',nameTemplate:'New',hostId:'host-main',path:'/not-created',environment:{kind:'local-source'}}},{task:'fix'});expect(newPreview.nativeSeed).toBeNull();expect(newPreview.effects!.createsProject).toBe(true);
  }finally{service.dispose();f.close();}
});
test('native environment ownership/model/permission errors are known pre-effect outcomes',async()=>{
  for(const kind of ['foreign-environment','missing-model','permission']) {
    const s=setup();let native=nativeSubmission();if(kind==='foreign-environment'){s.n.env.projectId='foreign';native={...native,environment:{type:'reuse',environmentId:'env-1'}};}if(kind==='missing-model')native={...native,model:'not-on-target'};if(kind==='permission')native={...native,permissionMode:'full'};
    try{expect(await s.service.launch({...s.request,nativeSubmission:native},launchActor())).toMatchObject({phase:'failed',retryable:true});expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(0);expect(s.f.store.launch(s.request.operationId)!.spawnClaim).toBeNull();}finally{s.service.dispose();s.f.close();}
  }
});
test('personal native workspace uses actual personal project without fake source',async()=>{
  const s=setup();s.n.projects.push({id:'personal',name:'Personal',kind:'personal',sources:[]});
  try{expect(await s.service.launch({...s.request,nativeSubmission:{...nativeSubmission(),projectId:'personal',environment:{type:'host',hostId:'host-main',workspace:{type:'personal'}}}},launchActor())).toMatchObject({phase:'succeeded',projectId:'personal'});expect(s.f.store.launch(s.request.operationId)!.nativeRequest!.environment).toEqual({type:'host',hostId:'host-main',workspace:{type:'personal'}});}finally{s.service.dispose();s.f.close();}
});
test('native fingerprint pins resource identity/provenance/session options while current assertion can refresh',async()=>{
  const s=setup();try{
    await s.service.launch(s.request,launchActor());for(const changed of [
      {...nativeSubmission(),input:[{type:'text' as const,text:'Read @reference then /review',mentions:[{start:5,end:15,resource:{kind:'thread' as const,label:'reference',threadId:'different'}}]}]},
      {...nativeSubmission(),executionInputSources:{providerId:'client-preference' as const}}, {...nativeSubmission(),sessionOptions:{plan:false}},
    ])await expect(s.service.launch({...s.request,nativeSubmission:changed},launchActor())).rejects.toThrow('different immutable');
    expect(await s.service.launch({...s.request,expectedSession:'fresh'},launchActor('fresh'))).toMatchObject({phase:'succeeded'});expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(1);
  }finally{s.service.dispose();s.f.close();}
});
test('native response loss/reopen retains exact journal through unpublish and never resends',async()=>{
  const s=setup();s.n.harness.stub('threads.spawn',async(...args)=>{const sent=z.object({pluginMetadata:z.record(z.string(),z.json())}).parse(args[0]);s.n.metadata.set('native-committed',sent.pluginMetadata??{});throw new Error('lost accepted response');});
  try{
    expect(await s.service.launch(s.request,launchActor())).toMatchObject({phase:'indeterminate',threadId:null});const exact=s.f.store.launch(s.request.operationId)!.nativeRequest;s.f.store.unpublish('test-template',1);s.service.dispose();const fresh=new LaunchService(s.f.reopen(),s.n.native);
    expect(await fresh.status(s.request.operationId)).toMatchObject({phase:'succeeded',threadId:'native-committed'});expect(await fresh.launch(s.request,launchActor())).toMatchObject({phase:'succeeded'});expect(s.f.store.launch(s.request.operationId)!.nativeRequest).toEqual(exact);expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(1);fresh.dispose();
  }finally{s.f.close();}
});
test('held native dispatch rejects duplication and revalidates issued owner before claim',async()=>{
  const s=setup();const reached=deferred<void>(),hold=deferred<{id:string}>();s.n.harness.stub('threads.spawn',async()=>{reached.resolve();return hold.promise;});
  try{const pending=s.service.launch(s.request,launchActor());await reached.promise;expect(await s.service.launch(s.request,launchActor())).toMatchObject({phase:'indeterminate',retryable:false});hold.resolve({id:'single'});expect(await pending).toMatchObject({phase:'succeeded',threadId:'single'});expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{s.service.dispose();s.f.close();}
  const t=setup();let current=true;t.n.harness.stub('providers.models',async()=>{current=false;return {models:t.n.models,selectedOnlyModels:[],modelLoadError:null,permissionCeiling:'auto'};});const actor=launchActor();actor.validate=()=>{if(!current)throw new Error('owner changed before native commit');};
  try{expect(await t.service.launch(t.request,actor)).toMatchObject({phase:'failed',message:'owner changed before native commit'});expect(t.n.harness.callsTo('threads.spawn')).toHaveLength(0);}finally{t.service.dispose();t.f.close();}
});
test('future native machine preserves exact configuration without fake host/catalog and provisional receipt remains unknown',async()=>{
  const s=setup();futureProvider(s.n);const native:NativeSubmission={...nativeSubmission(),model:'future-only-model',reasoningLevel:'future-reasoning',permissionMode:'full',environment:{type:'provider',environmentProviderId:'cloud-composition',inputs:{image:'private/image',mounts:['/a']},machine:{type:'new',machineProviderId:'cloud-vm',inputs:{region:'west',size:4}}}};
  s.n.harness.stub('threads.spawn',async()=>{throw new Error('native admission response unavailable');});
  try{
    expect(await s.service.launch({...s.request,nativeSubmission:native},launchActor())).toMatchObject({phase:'indeterminate',threadId:null,retryable:false});const row=s.f.store.launch(s.request.operationId)!;
    expect(row.nativeRequest).toMatchObject(native);expect(row.effects).toMatchObject({mode:'native',validation:'deferred-native',hostId:null,routing:null,execution:{model:native.model,permissionMode:'full'}});expect(row.effects!.warnings.join()).toContain('during native admission');
    expect(s.n.harness.callsTo('providers.models')).toHaveLength(0);expect(s.n.harness.callsTo('hosts.get')).toHaveLength(0);
    s.service.observeNativeReceipt('provisional',row.nativeRequest!.pluginMetadata,'pending');expect(s.f.store.launch(s.request.operationId)!.status).toMatchObject({phase:'indeterminate',threadId:null,candidate:{threadId:'provisional',state:'pending'}});
    s.service.observeNativeRemoval('provisional',row.nativeRequest!.pluginMetadata);expect(await s.service.status(s.request.operationId)).toMatchObject({phase:'indeterminate',threadId:null,candidate:{state:'deleted'}});expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(1);
  }finally{s.service.dispose();s.f.close();}
});
test('provider host availability and machine composition linkage block invalid targets before native claim',async()=>{
  const s=setup();futureProvider(s.n);try{
    expect(await s.service.launch({...s.request,nativeSubmission:{...nativeSubmission(),environment:{type:'provider',environmentProviderId:'container',inputs:null,machine:{type:'existing',hostId:'host-main'}}}},launchActor())).toMatchObject({phase:'failed',message:'The native environment is unavailable on the selected machine.'});
    s.n.harness.stub('hosts.experimental_listProviders',async()=>[{id:'other-vm'}]);expect(await s.service.launch({...s.request,operationId:crypto.randomUUID(),nativeSubmission:{...nativeSubmission(),environment:{type:'provider',environmentProviderId:'cloud-composition',inputs:null,machine:{type:'new',machineProviderId:'other-vm',inputs:null}}}},launchActor())).toMatchObject({phase:'failed',message:'The selected native composition requires a different machine provider.'});expect(s.n.harness.callsTo('threads.spawn')).toHaveLength(0);
  }finally{s.service.dispose();s.f.close();}
});
