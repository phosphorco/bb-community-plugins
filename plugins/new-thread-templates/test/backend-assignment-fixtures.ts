/** Templates factory + scripted public provider. Optional injection is for an explicit workspace proof only. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {bindBbIdentity} from '@phosphorco/bb-identity/bb';
import {createdThreadClaimInput,createdThreadClaimResultSchema,createdThreadLookupResultSchema,createdThreadDescribeSchema,CREATED_THREAD_ASSIGNMENT_PROTOCOL,CREATED_THREAD_ASSIGNMENT_LIMITS,type CreatedThreadClaimInput,type CreatedThreadClaimResult,type CreatedThreadLookupResult} from '../inbox-assignment-contract';
import {z} from 'zod';
import {createFakePluginHost,makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {createAdapterHarness,personFixture,type FakeRequest} from '@phosphorco/bb-identity/testing';
import {identityKeyCodec,idCodec,type ActorSnapshot} from '@phosphorco/bb-identity/model';
import templates from '../server';
import {databaseFixture,nativeFixture,definition} from './backend-fixtures';
import {templatesContract} from '../rpc-contract';
type Scope=Parameters<NonNullable<BbPluginApi['experimental_p6rIdentity']>['forwardRpc']>[0];
function verifiedPerson(subject:string){const base=personFixture({subject,name:subject});const key=identityKeyCodec.decode('p6r-person:v1:test:'+subject);if(!key.ok)throw new Error(key.error.message);return {...base,identity:{...base.identity,key:key.value,issuer:'test',subject},evidence:'provider-verified' as const};}
export const verifiedAlice=verifiedPerson('alice');
export const verifiedBob=verifiedPerson('bob');
const unknownCodec={decode:(value:unknown)=>({ok:true as const,value}),encode:(value:unknown)=>JSON.parse(JSON.stringify(value))};
export async function assignmentFactories(providerFactory?:(bb:BbPluginApi)=>unknown){
  const f=databaseFixture(),inboxDb=databaseFixture(),native=nativeFixture();
  const hosts=new Map<string,ReturnType<typeof createFakePluginHost>>();
  const harness=createAdapterHarness({mode:'multi-user',instanceId:'assignment-instance',pluginId:'test-host',inputCodec:unknownCodec});harness.setActor(verifiedAlice);
  const contexts=new AsyncLocalStorage<{request:FakeRequest;scope:Scope}>();
  const scopes=new WeakMap<Scope,FakeRequest>();let incoming=0;const forwarded:{pluginId:string;method:string;input:unknown}[]=[];let interception:((destination:{pluginId:string;method:string},input:unknown,run:()=>Promise<unknown>)=>Promise<unknown>)|null=null;
  const requestSchema=z.object({id:z.string(),origin:z.enum(['interactive-user','agent','background','external','unauthenticated'])});
  const scopeFor=(request:FakeRequest,parent?:Scope):Scope=>{const controller=new AbortController();const signal=parent?AbortSignal.any([controller.signal,parent.signal]):controller.signal;const scope:Scope={signal,validate:()=>signal.aborted?{ok:false,code:'invalidated'}:{ok:true},release:()=>controller.abort()};scopes.set(scope,request);return scope;};
  function host(pluginId:string,db:ReturnType<typeof databaseFixture>){
    const h=createFakePluginHost({pluginId});hosts.set(pluginId,h);h.bb.storage.database=()=>db.db as unknown as ReturnType<BbPluginApi['storage']['database']>;
    h.bb.storage.migrate=(database,migrations)=>{database.exec('CREATE TABLE IF NOT EXISTS test_migrations (id INTEGER PRIMARY KEY)');migrations.forEach((sql,index)=>{if(!database.prepare('SELECT id FROM test_migrations WHERE id=?').get(index))database.transaction(()=>{database.exec(sql);database.prepare('INSERT INTO test_migrations VALUES(?)').run(index);})()});};
    const protocol:NonNullable<BbPluginApi['experimental_p6rIdentity']>={
      version:1,instanceId:'assignment-instance',
      bindInvocation({handler}){let retired=false;return {registration:{generation:'test-generation-'+(++incoming),get status(){return retired?'retired':'active';},dispose(){retired=true;}},handler:(...args)=>{if(retired)throw new Error('Retired identity registration');const parent=contexts.getStore(),request=parent?.request??harness.request(),scope=scopeFor(request,parent?.scope);return contexts.run({request,scope},()=>handler({request,scope},...args));}};},
      session:async raw=>harness.upstream.session(requestSchema.parse(raw)),selfProfile:async raw=>harness.upstream.selfProfile(requestSchema.parse(raw)),
      openRequest:async raw=>{const request=requestSchema.parse(raw),opened=await harness.upstream.openScope(request);if(!opened.ok)return opened;const base=scopeFor(request,contexts.getStore()?.scope),signal=AbortSignal.any([base.signal,opened.value.signal]);const scope:Scope={signal,release:base.release,validate:()=>signal.aborted?{ok:false,code:'invalidated'}:base.validate()};scopes.set(scope,request);return {ok:true,value:{...opened.value,scope,validate:(expected:unknown)=>{if(!scope.validate().ok)return {ok:false,error:{code:'expired',message:'Original carried scope expired',retry:'never'}};const e=z.object({actor:z.string(),session:z.string()}).parse(expected),actor=identityKeyCodec.decode(e.actor),stamp=idCodec('server-session').decode(e.session);if(!actor.ok)return actor;if(!stamp.ok)return stamp;return opened.value.validate({actor:actor.value,session:stamp.value});}}};},
      accept:async()=>({status:'rejected',error:{code:'unsupported',message:'Test does not send identity messages',retry:'never'}}),lookup:async()=>({ok:true,value:{status:'unknown',reason:'unsupported'}}),provenance:async()=>({ok:true,value:{status:'unknown',correlation:null,reason:'fixture'}}),historyContributions:async()=>({ok:true,value:{status:'unavailable',reason:'unsupported'}}),historyAttempts:async()=>({ok:true,value:{status:'unavailable',reason:'unsupported'}}),directorySources:()=>[],participants:async()=>({ok:false,error:{code:'unsupported',message:'Not modeled',retry:'never'}}),
      forwardRpc:async(scope,destination,input)=>{if(!scope.validate().ok)throw new Error('Expired forward scope');const request=scopes.get(scope);if(!request)throw new Error('Not an issued test host scope');forwarded.push({...destination,input});const target=hosts.get(destination.pluginId);if(!target)throw new Error('Provider absent');const run=()=>contexts.run({request,scope},()=>target.harness.behavior.callRpc(destination.method,input));return interception?interception(destination,input,run):run();},registerProvider:async()=>({ok:false,error:{code:'unsupported',message:'Not modeled',retry:'never'}}),subscribe:()=>()=>{},
    };
    Object.defineProperty(h.bb,'experimental_p6rIdentity',{value:protocol});
    for(const path of ['projects.list','projects.get','projects.defaultExecutionOptions','system.config','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','providers.list','providers.catalog','providers.models','threads.list','threads.getPluginMetadata','threads.experimental_listPluginMetadata','threads.spawn']){const [area,method]=path.split('.') as [keyof typeof native.sdk,string];const api=native.sdk[area] as unknown as Record<string,(...args:never[])=>unknown>;h.harness.inspection.sdk.stub(path,(...args)=>api[method]!(...args));}
    h.harness.inspection.sdk.stub('threads.get',async(...args)=>{const id=z.object({threadId:z.string()}).parse(args[0]).threadId;return makeThreadResponse({id,originPluginId:'new-thread-templates',status:native.statuses.get(id)??'active',deletedAt:null});});
    h.harness.inspection.sdk.stub('threads.events.list',async()=>[]);
    h.harness.inspection.sdk.stub('subscribe',()=>()=>{});
    return h;
  }
  let tpl=host('new-thread-templates',f);const inbox=host('inbox-sidebar-nerd',inboxDb);
  // Deliberately scripted wire outcomes only: no Inbox ownership/transaction algorithm here.
  const scripted={
    claim:async(input:CreatedThreadClaimInput,actor:ActorSnapshot):Promise<CreatedThreadClaimResult>=>({version:1,status:'final',receipt:{...input,actorKey:actor.identity.key,outcome:'claimed',reason:'claimed-untouched',decidedAt:1,ownerRevision:1},current:{threadId:input.threadId,revision:1,ownerKeys:[actor.identity.key],truncated:false,explicitlyUnassigned:false}}),
    lookup:async(input:CreatedThreadClaimInput,_actor:ActorSnapshot):Promise<CreatedThreadLookupResult>=>({version:1,status:'absent',...input,current:{threadId:input.threadId,revision:0,ownerKeys:[],truncated:false,explicitlyUnassigned:false}}),
  };
  if(providerFactory)await providerFactory(inbox.bb);
  else {
    const bound=bindBbIdentity(inbox.bb);if(!bound.ok)throw new Error(bound.error.message);
    const registered=bound.value.rpc.register({describeCreatedThreadAssignment:{input:z.null(),output:createdThreadDescribeSchema},claimCreatedThreadV1:{input:createdThreadClaimInput,output:createdThreadClaimResultSchema},lookupCreatedThreadClaimV1:{input:createdThreadClaimInput,output:createdThreadLookupResultSchema}},{
      describeCreatedThreadAssignment:{origin:'interactive-user',handle:()=>({protocol:'inbox-created-thread-assignment' as const,versions:[1],limits:CREATED_THREAD_ASSIGNMENT_LIMITS})},
      claimCreatedThreadV1:{origin:'interactive-user',handle:async(input,invocation)=>{const opened=await invocation.person();if(!opened.ok)throw new Error(opened.error.message);try{return await scripted.claim(input,opened.value.actor);}finally{opened.value.dispose();}}},
      lookupCreatedThreadClaimV1:{origin:'interactive-user',handle:async(input,invocation)=>{const opened=await invocation.person();if(!opened.ok)throw new Error(opened.error.message);try{return await scripted.lookup(input,opened.value.actor);}finally{opened.value.dispose();}}},
    });if(!registered.ok)throw new Error(registered.error.message);
  }
  templates(tpl.bb);
  await tpl.harness.behavior.callRpc('saveDraft',{definition:definition(),expectedGeneration:null});await tpl.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:1});
  async function context(){return templatesContract.context.output.parse(await tpl.harness.behavior.callRpc('context',{}));}
  return {f,inboxDb,native,get tpl(){return tpl;},inbox,hosts,forwarded,harness,context,scripted,async replaceTemplates(reopen=false){await tpl.harness.lifecycle.dispose();if(reopen)f.reopen();tpl=host('new-thread-templates',f);templates(tpl.bb);},intercept(value:typeof interception){interception=value;},async launch(overrides:Record<string,unknown>={}){const c=await context();const input={operationId:crypto.randomUUID(),templateId:'test-template',revision:1,inputs:{task:'assigned launch'},expectedActor:c.actor.key,expectedSession:c.session,...overrides};return {input,status:templatesContract.launch.output.parse(await tpl.harness.behavior.callRpc('launch',input))};},async dispose(){for(const h of hosts.values())await h.harness.lifecycle.dispose();f.close();inboxDb.close();}};
}
