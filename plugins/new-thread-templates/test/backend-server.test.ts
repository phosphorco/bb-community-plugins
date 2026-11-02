import { test, expect } from 'bun:test';
import { createFakePluginHost, makeThreadResponse, experimental_scanPublicSdkOnly } from '@get-bb/plugin-sdk/testing';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import server from '../server';
import { databaseFixture, nativeFixture, definition } from './backend-fixtures';
import { templatesContract, TEMPLATES_CHANGED } from '../rpc-contract';
import { PLUGIN_ID } from '../model';
import {z} from 'zod';

test('actual product factory registers shared identity routes and schema-checked native launch RPC; disposal fences calls',async()=>{
  const f=databaseFixture();const n=nativeFixture();const host=createFakePluginHost({pluginId:PLUGIN_ID});
  host.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
  // Public fake host records call signatures and JSON boundaries; only native I/O is injected.
  for(const path of ['projects.list','projects.get','projects.defaultExecutionOptions','system.config','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','providers.list','providers.catalog','providers.models','threads.list','threads.getPluginMetadata','threads.experimental_listPluginMetadata','threads.spawn']) {
    const [area,method]=path.split('.') as [keyof typeof n.sdk,string];
    const api=n.sdk[area] as unknown as Record<string,(...args:never[])=>unknown>;
    host.harness.inspection.sdk.stub(path,(...args)=>api[method]!(...args));
  }
  try {
    server(host.bb);
    expect(host.harness.inspection.registrations.rpcMethods.some(m=>m.includes('bb-identity'))).toBe(true);
    const catalog=templatesContract.catalog.output.parse(await host.harness.behavior.callRpc('catalog',{}));expect(catalog.entries).toHaveLength(2);
    const context=templatesContract.context.output.parse(await host.harness.behavior.callRpc('context',{}));expect(context.actor.key).not.toBe('');
    await host.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});
    await host.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
    const output=templatesContract.launch.output.parse(await host.harness.behavior.callRpc('launch',{operationId:crypto.randomUUID(),templateId:'test-template',revision:1,inputs:{task:'perform a check'},expectedActor:context.actor.key,expectedSession:context.session}));
    expect(output.phase).toBe('succeeded');expect(output.nativeAttribution).toBe('plugin-origin');
    const [spawn]=host.harness.inspection.sdk.callsTo('threads.spawn');expect(spawn![0]).toMatchObject({origin:'plugin',originPluginId:PLUGIN_ID,pluginMetadata:{actor:{identity:{key:context.actor.key}}}});
    await expect(host.harness.behavior.callRpc('launch',{operationId:'not-uuid'})).rejects.toThrow();
    await expect(host.harness.behavior.callRpc('context',{unexpected:'not allowed'})).rejects.toThrow();
    const recent=templatesContract.recentLaunches.output.parse(await host.harness.behavior.callRpc('recentLaunches',{}));expect(recent.launches[0]!.status.threadId).toBe(output.threadId);
    await host.harness.lifecycle.dispose();await expect(host.harness.behavior.callRpc('catalog',{})).rejects.toThrow();
  }finally{await host.harness.lifecycle.dispose();f.close();}
});
test('package uses only public SDK/package imports',async()=>{
  const result=await experimental_scanPublicSdkOnly(new URL('..',import.meta.url).pathname,{allow:[/^@phosphorco\/bb-identity(?:\/.*)?$/, /^bun:/, /^better-sqlite3$/, /^@get-bb\/plugin-sdk(?:\/.*)?$/, /^react(?:\/.*)?$/, /^zod$/, /^@testing-library\/react$/, /^@playwright\/test$/, /^jsdom$/, /^fake-indexeddb$/]});
  expect(result.violations).toEqual([]);expect(result.privateDependencies).toEqual([]);
});

test('personal draft goes through actual package connection/controller -> product binding -> real SQLite, with current owner validation',async()=>{
  const {createIdentityConnection,createIdentityClient}=await import('@phosphorco/bb-identity/client');
  const {createIdentityState,createStateTransport}=await import('@phosphorco/bb-identity/state');
  const {idCodec}=await import('@phosphorco/bb-identity/model');
  const {inputDraftResource}=await import('../model');
  const f=databaseFixture();const host=createFakePluginHost({pluginId:PLUGIN_ID});
  host.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
  server(host.bb);
  const connection=createIdentityConnection({
    request:async(method,input)=>host.harness.behavior.callRpc(method.replaceAll('/','.'),input),
    subscribe:()=>()=>{},getHealth:()=>({generation:1,identity:{status:'healthy'},state:{status:'healthy'}}),subscribeHealth:()=>()=>{},revalidate:async()=>({ok:true,value:undefined}),
  });
  const client=createIdentityClient({connection});
  try {
    expect((await client.start()).ok).toBe(true);const current=client.currentSession();if(!current.ok||current.value.status!=='ready')throw new Error('No ready identity');const session=current.value;
    const address={instanceId:session.instanceId,pluginId:inputDraftResource.pluginId,collection:inputDraftResource.definition.collection,recordId:'review-pr',owner:session.actor.identity.key};
    const owner=idCodec('owner-session').decode('controller-1');if(!owner.ok)throw new Error(owner.error.message);
    const transport=createStateTransport({connection,resource:inputDraftResource});
    const controller=createIdentityState({address,expected:{actor:session.actor.identity.key,session:session.stamp},ownerSession:owner.value,definition:inputDraftResource.definition,transport,initializeEmpty:true,currentSession:()=>client.currentSession(),onConflict:()=>({kind:'accept-remote'})});
    expect((await controller.start()).ok).toBe(true);expect(controller.edit({inputs:{pr_url:'https://example.com/pr/1'}}).ok).toBe(true);expect((await controller.flush()).ok).toBe(true);
    const stored=await f.store.personalStorage().read(address);expect(stored.ok&&stored.value.status==='present'&&stored.value.envelope.value.inputs.pr_url).toBe('https://example.com/pr/1');
    const read=await transport.load({address,expected:{actor:session.actor.identity.key,session:session.stamp}});expect(read.ok).toBe(true);
    const wrong=idCodec('operation').decode('stale-operation');if(!wrong.ok)throw new Error(wrong.error.message);
    const snapshot=stored.ok&&stored.value.status==='present'?stored.value.envelope:null;if(!snapshot)throw new Error('Missing stored input');
    const stale=idCodec('server-session').decode('wrong-current-session');if(!stale.ok)throw new Error(stale.error.message);
    const rejected=await transport.save({kind:'replace',address,expectedVersion:snapshot.version,expected:{actor:session.actor.identity.key,session:stale.value},ownerSession:owner.value,localGeneration:2,operationId:wrong.value,schemaVersion:1,value:{inputs:{pr_url:'must not replace'}}});expect(rejected.ok).toBe(false);
    expect((await f.store.personalStorage().read(address))).toEqual(stored);controller.dispose();
  }finally{client.dispose();connection.dispose();await host.harness.lifecycle.dispose();f.close();}
});

test('current-generation native event wakes an unknown observer after replacement; old generation remains silent and never redispatches',async()=>{
  const {deferred}=await import('@phosphorco/bb-identity/testing');
  const f=databaseFixture(),n=nativeFixture();
  function host() {
    const h=createFakePluginHost({pluginId:PLUGIN_ID});
    h.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
    for(const path of ['projects.list','projects.get','projects.defaultExecutionOptions','system.config','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','providers.list','providers.catalog','providers.models','threads.list','threads.getPluginMetadata','threads.experimental_listPluginMetadata','threads.spawn']) {
      const [area,method]=path.split('.') as [keyof typeof n.sdk,string];
      const api=n.sdk[area] as unknown as Record<string,(...args:never[])=>unknown>;
      h.harness.inspection.sdk.stub(path,(...args)=>api[method]!(...args));
    }
    return h;
  }
  const old=host(),current=host();const hold=deferred<{id:string}>(),reached=deferred<void>();
  n.harness.stub('threads.spawn',async()=>{reached.resolve();return hold.promise;});
  let operationId='';let observing=false;let observed:ReturnType<typeof templatesContract.launch.output.parse>|null=null;
  let readError:string|null='Receipt unavailable';const reads:Promise<unknown>[]=[];
  const publish=current.bb.realtime.publish.bind(current.bb.realtime);
  current.bb.realtime.publish=(channel,payload)=>{
    publish(channel,payload);
    if(observing&&channel===TEMPLATES_CHANGED)reads.push(current.harness.behavior.callRpc('launchStatus',{operationId}).then(value=>{observed=templatesContract.launchStatus.output.parse(value);readError=null;}));
  };
  try {
    server(old.bb);const context=templatesContract.context.output.parse(await old.harness.behavior.callRpc('context',{}));
    await old.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});
    await old.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
    operationId=crypto.randomUUID();const pending=old.harness.behavior.callRpc('launch',{operationId,templateId:'test-template',revision:1,inputs:{task:'held native effect'},expectedActor:context.actor.key,expectedSession:context.session});
    await reached.promise;const oldSignals=old.harness.inspection.realtimeSignals.length;
    await old.harness.lifecycle.dispose();server(current.bb);
    const unknown=templatesContract.launchStatus.output.parse(await current.harness.behavior.callRpc('launchStatus',{operationId}));expect(unknown!.phase).toBe('indeterminate');
    observed=unknown;observing=true;
    const currentSignals=current.harness.inspection.realtimeSignals.length;
    const receipt=f.store.launch(operationId)!.nativeRequest!.pluginMetadata as Record<string,unknown>;
    const listReads=n.harness.callsTo('threads.list').length;
    await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'unrelated',originPluginId:'another-plugin'})});
    expect(n.harness.callsTo('threads.getPluginMetadata')).toHaveLength(0);
    n.metadata.set('invalid-receipt',{...receipt,fingerprint:'mismatch'});
    await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'invalid-receipt',originPluginId:PLUGIN_ID})});
    expect(f.store.launch(operationId)!.status.phase).toBe('indeterminate');
    expect(current.harness.inspection.realtimeSignals.length).toBe(currentSignals);
    // The retained metadata is committed before the original native HTTP response.
    n.metadata.set('confirmed-after-reload',receipt);
    await current.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:'confirmed-after-reload',originPluginId:PLUGIN_ID,status:'active'})});
    // Creation and the now-eligible portable user's optional-provider lookup each change once.
    await Promise.all(reads);expect(current.harness.inspection.realtimeSignals.length).toBe(currentSignals+2);expect(observed).toMatchObject({phase:'succeeded',threadId:'confirmed-after-reload'});expect(readError).toBeNull();
    expect(n.harness.callsTo('threads.list').length).toBe(listReads);
    hold.resolve({id:'confirmed-after-reload'});await pending;
    expect(f.store.launch(operationId)!.status.threadId).toBe('confirmed-after-reload');
    expect(old.harness.inspection.realtimeSignals.length).toBe(oldSignals);expect(current.harness.inspection.realtimeSignals.length).toBe(currentSignals+2);
    expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);
    const settled=current.harness.inspection.realtimeSignals.length;
    for(let i=0;i<3;i++)await current.harness.behavior.callRpc('launchStatus',{operationId});expect(current.harness.inspection.realtimeSignals.length).toBe(settled);
    // A lifecycle notification without any matching receipt cannot fabricate success.
    const unrelatedId=crypto.randomUUID();await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'no-matching-receipt',originPluginId:PLUGIN_ID})});await Promise.all(reads);expect(await current.harness.behavior.callRpc('launchStatus',{operationId:unrelatedId})).toBeNull();
    observing=false;const finalSignals=current.harness.inspection.realtimeSignals.length;await current.harness.lifecycle.dispose();await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({originPluginId:PLUGIN_ID})});expect(current.harness.inspection.realtimeSignals.length).toBe(finalSignals);
  }finally{observing=false;await old.harness.lifecycle.dispose();await current.harness.lifecycle.dispose();f.close();}
});

for(const replace of [false,true])test('pending create -> deletion -> native rejection stays check-only, replacement='+replace,async()=>{
  const {deferred}=await import('@phosphorco/bb-identity/testing');
  const f=databaseFixture(),n=nativeFixture();const hold=deferred<{id:string}>(),reached=deferred<void>();let captured:Record<string,unknown>={};
  function makeHost(){
    const h=createFakePluginHost({pluginId:PLUGIN_ID});h.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
    for(const path of ['projects.list','projects.get','projects.defaultExecutionOptions','system.config','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','providers.list','providers.catalog','providers.models','threads.list','threads.getPluginMetadata','threads.experimental_listPluginMetadata','threads.spawn']){const [area,method]=path.split('.') as [keyof typeof n.sdk,string];const api=n.sdk[area] as unknown as Record<string,(...args:never[])=>unknown>;h.harness.inspection.sdk.stub(path,(...args)=>api[method]!(...args));}
    return h;
  }
  const old=makeHost();let current=old;
  n.harness.stub('threads.spawn',async(...args)=>{const request=args[0] as unknown as {pluginMetadata:Record<string,unknown>};captured=request.pluginMetadata;reached.resolve();return hold.promise;});
  try{
    server(old.bb);const context=templatesContract.context.output.parse(await old.harness.behavior.callRpc('context',{}));await old.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});await old.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
    const operationId=crypto.randomUUID();const pending=old.harness.behavior.callRpc('launch',{operationId,templateId:'test-template',revision:1,inputs:{task:'provisional creation'},expectedActor:context.actor.key,expectedSession:context.session});await reached.promise;
    if(replace){await old.harness.lifecycle.dispose();current=makeHost();server(current.bb);}
    n.metadata.set('removed-start',captured);n.statuses.set('removed-start','pending');
    await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'removed-start',status:'pending',originPluginId:PLUGIN_ID})});
    const provisional=templatesContract.launchStatus.output.parse(await current.harness.behavior.callRpc('launchStatus',{operationId}));expect(provisional).toMatchObject({phase:'indeterminate',threadId:null,retryable:false,candidate:{threadId:'removed-start',state:'pending'}});
    // Queue acceptance still cannot be inferred from a pending row if the ACK is lost.
    expect(f.store.launch(operationId)!.confirmation).toBeNull();
    await current.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'removed-start',status:'pending',originPluginId:PLUGIN_ID,deletedAt:Date.now()})});n.metadata.delete('removed-start');
    hold.reject(new Error('native execution admission failed'));const result=templatesContract.launch.output.parse(await pending);expect(result.phase).toBe('indeterminate');expect(result.threadId).toBeNull();
    const after=templatesContract.launchStatus.output.parse(await current.harness.behavior.callRpc('launchStatus',{operationId}));expect(after).toMatchObject({phase:'indeterminate',threadId:null,retryable:false,candidate:{threadId:'removed-start',state:'deleted'}});
    // Stale positive observation after deletion cannot revive the provisional thread.
    n.metadata.set('removed-start',captured);await current.harness.behavior.emitThreadEvent('thread.active',{thread:makeThreadResponse({id:'removed-start',status:'active',originPluginId:PLUGIN_ID})});expect(f.store.launch(operationId)!.status.phase).toBe('indeterminate');
    expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);expect(f.store.launch(operationId)!.status.inputs).toEqual({task:'provisional creation'});
  }finally{await current.harness.lifecycle.dispose();if(current!==old)await old.harness.lifecycle.dispose();f.close();}
});

test('late authoritative queued ACK after replacement is durable and explicit Check recovers despite no current notification',async()=>{
  const {deferred}=await import('@phosphorco/bb-identity/testing');
  const f=databaseFixture(),n=nativeFixture();const hold=deferred<{id:string}>(),reached=deferred<void>();
  function makeHost(){const h=createFakePluginHost({pluginId:PLUGIN_ID});h.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;for(const path of ['projects.list','projects.get','projects.defaultExecutionOptions','system.config','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','providers.list','providers.catalog','providers.models','threads.list','threads.getPluginMetadata','threads.experimental_listPluginMetadata','threads.spawn']){const [area,method]=path.split('.') as [keyof typeof n.sdk,string];const api=n.sdk[area] as unknown as Record<string,(...args:never[])=>unknown>;h.harness.inspection.sdk.stub(path,(...args)=>api[method]!(...args));}return h;}
  const old=makeHost(),current=makeHost();n.harness.stub('threads.spawn',async()=>{reached.resolve();return hold.promise;});
  try{
    server(old.bb);const context=templatesContract.context.output.parse(await old.harness.behavior.callRpc('context',{}));await old.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});await old.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
    const operationId=crypto.randomUUID();const pending=old.harness.behavior.callRpc('launch',{operationId,templateId:'test-template',revision:1,inputs:{task:'queued accepted'},expectedActor:context.actor.key,expectedSession:context.session});await reached.promise;
    const oldSignals=old.harness.inspection.realtimeSignals.length;await old.harness.lifecycle.dispose();server(current.bb);
    n.metadata.set('queued',z.record(z.string(),z.json()).parse(f.store.launch(operationId)!.nativeRequest!.pluginMetadata));n.statuses.set('queued','pending');await current.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'queued',originPluginId:PLUGIN_ID,status:'pending'})});
    const observer=templatesContract.launchStatus.output.parse(await current.harness.behavior.callRpc('launchStatus',{operationId}));expect(observer).toMatchObject({phase:'indeterminate',threadId:null});const signals=current.harness.inspection.realtimeSignals.length;
    hold.resolve({id:'queued'});expect(templatesContract.launch.output.parse(await pending)).toMatchObject({phase:'succeeded',threadId:'queued'});expect(f.store.launch(operationId)!.confirmation).toBe('native-ack');
    // Accepted narrow coverage: no current-owner signal is inferred from provisional creation.
    expect(current.harness.inspection.realtimeSignals.length).toBe(signals);expect(old.harness.inspection.realtimeSignals.length).toBe(oldSignals);expect(observer!.phase).toBe('indeterminate');
    expect(await current.harness.behavior.callRpc('launchStatus',{operationId})).toMatchObject({phase:'succeeded',threadId:'queued'});expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);
  }finally{await old.harness.lifecycle.dispose();await current.harness.lifecycle.dispose();f.close();}
});

test('public remove RPC enforces exact CAS, preserves attribution/history, hides catalog and never creates native effects',async()=>{
  const f=databaseFixture(),host=createFakePluginHost({pluginId:PLUGIN_ID});host.bb.storage.database=()=>f.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
  try{
    server(host.bb);await host.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});await host.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
    const input={templateId:'test-template',expectedGeneration:1,expectedRevision:1,expectedLatestRevision:1};
    await expect(host.harness.behavior.callRpc('remove',{...input,expectedGeneration:0})).rejects.toThrow('changed');
    await expect(host.harness.behavior.callRpc('remove',{templateId:'test-template',expectedGeneration:1})).rejects.toThrow();
    const result=templatesContract.remove.output.parse(await host.harness.behavior.callRpc('remove',input));expect(result.templateId).toBe('test-template');expect(result.removedBy.key.length).toBeGreaterThan(0);expect(result.removedAt).toBeGreaterThan(0);
    expect(await host.harness.behavior.callRpc('remove',input)).toEqual(result);
    const catalog=templatesContract.catalog.output.parse(await host.harness.behavior.callRpc('catalog',{}));expect(catalog.entries.map(e=>e.id)).not.toContain('test-template');expect(f.store.revision('test-template',1)!.definition).toEqual(definition());
    await expect(host.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null})).rejects.toThrow('removed');
    expect(host.harness.inspection.sdk.callsTo('threads.spawn')).toHaveLength(0);expect(host.harness.inspection.sdk.callsTo('projects.create')).toHaveLength(0);
    await host.harness.lifecycle.dispose();f.reopen().seed();expect(f.store.get('test-template')).toBeNull();expect(f.store.revision('test-template',1)).not.toBeNull();
  }finally{await host.harness.lifecycle.dispose();f.close();}
});
