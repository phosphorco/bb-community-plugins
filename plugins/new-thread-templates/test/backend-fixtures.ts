import { Database, type Statement } from 'bun:sqlite';
import type { Db } from '../store';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeSdk, makeHostResponse } from '@get-bb/plugin-sdk/testing';
import { personFixture } from '@phosphorco/bb-identity/testing';
import { emptyDefinition, PLUGIN_ID, type TemplateDefinition } from '../model';
import { TemplatesStore } from '../store';
import { NativeTemplates } from '../native';
import type { LaunchActor } from '../launch';
import { randomUUID } from 'node:crypto';

export function definition(overrides:Partial<TemplateDefinition>={}):TemplateDefinition {return {...emptyDefinition('test-template'),name:'Test template',fields:[{key:'task',label:'Task',type:'textarea',required:true,order:0}],destination:{kind:'existing-project',projectId:'project-1',environment:{kind:'project-default'}},promptTemplate:'Do {{task}}',titleTemplate:'Task {{task}}',...overrides};}
export function databaseFixture(now:()=>number=Date.now) {
  const dir=mkdtempSync(join(tmpdir(),'templates-backend-'));
  const path=join(dir,'data.db');
  const statements=new Set<Statement>();
  function open() {
    const connection=new Database(path);
    const prepare=connection.prepare.bind(connection);
    connection.prepare=((...args:Parameters<typeof prepare>)=>{
      const statement=prepare(...args);
      statements.add(statement);
      return statement;
    }) as typeof connection.prepare;
    return connection;
  }
  function closeConnection() {
    // close(false) leaves prepare() statements and their file connection alive.
    // Retire every fixture-owned handle before unlinking or reopening the file.
    for(const statement of statements)statement.finalize();
    statements.clear();
    db.close(true);
  }
  let db=open(),store=new TemplatesStore(db as unknown as Db,now);
  return {
    get db(){return db;},get store(){return store;},
    reopen(){closeConnection();db=open();store=new TemplatesStore(db as unknown as Db,now);return store;},
    close(){closeConnection();rmSync(dir,{recursive:true,force:true});},
  };
}
export const alice=personFixture({subject:'alice',name:'Alice'});
export function launchActor(session='session-1'):LaunchActor {return {actor:alice,expected:{actor:alice.identity.key,session},validate(){}};}
export function launchRequest(overrides:Record<string,unknown>={}) {return {operationId:randomUUID(),templateId:'test-template',revision:1,inputs:{task:'repair bug'},expectedActor:alice.identity.key,expectedSession:'session-1',...overrides};}
export function published(f:ReturnType<typeof databaseFixture>,def=definition()) {f.store.saveDraft(def,null,{key:alice.identity.key,name:'Alice'});return f.store.publish(def.id,1,{key:alice.identity.key,name:'Alice'}).entry.published!;}
export function nativeFixture() {
  const projects=[{id:'project-1',name:'Actual project',kind:'standard',sources:[{hostId:'host-main',path:'/src/project',isDefault:true}]}];
  const models=[{id:'model-a',model:'model-a',displayName:'Model A',description:'',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:''},{reasoningEffort:'high',description:''}],supportedServiceTiers:undefined as undefined|{id:string}[]}];
  const providers=[{id:'codex',displayName:'Codex',available:true,capabilities:{supportsServiceTier:true,modelCatalogScope:'host',permissionModes:['auto','full','accept-edits']},serviceTiers:[{id:'fast',label:'Fast'}]}];
  const defaults={providerId:'codex',model:'model-a',reasoningLevel:'medium',permissionMode:'auto',serviceTier:'default'};
  const config={primaryHostId:'host-main',generalSettings:{defaultProviderId:'codex',allowFastServiceTier:true}};
  const env={id:'env-1',projectId:'project-1',hostId:'host-main',name:'Actual environment',path:'/src/project',status:'ready',lifecycle:{phase:'active'},hostLifecycle:'active'};
  const metadata=new Map<string,Record<string,unknown>>();const statuses=new Map<string,'pending'|'starting'|'active'|'idle'|'error'>();
  let created=0;let spawned=0;
  const fake=createFakeSdk({pluginId:PLUGIN_ID,overrides:{
    projects:{list:async()=>projects,get:async({projectId})=>{const p=projects.find(p=>p.id===projectId);if(!p)throw new Error('Project missing');return p;},defaultExecutionOptions:async()=>defaults,create:async({name,source})=>{created++;const p={id:`project-${projects.length+1}`,name,kind:'standard',sources:[{...source,isDefault:true}]};projects.push(p);return p;}},
    system:{config:async()=>config},
    hosts:{list:async()=>[makeHostResponse({id:'host-main',name:'Main',status:'connected'})],get:async({hostId})=>makeHostResponse({id:hostId,name:hostId,status:'connected'}),pathsExist:async({paths})=>({existence:Object.fromEntries(paths.map(p=>[p,true]))}),directory:async()=>({path:'/src/project',entries:[]}),experimental_listProviders:async()=>[]},
    environments:{list:async()=>[env],get:async()=>env,listProviders:async()=>[]},
    providers:{list:async()=>providers,catalog:async()=>providers.map(p=>({...p,enabled:true})),models:async()=>({models,selectedOnlyModels:[],providers,modelLoadError:null,permissionCeiling:'auto'})},
    threads:{getPluginMetadata:async({threadId})=>metadata.get(threadId)??{},spawn:async input=>{spawned++;const id=`thread-${spawned}`;metadata.set(id,input.pluginMetadata??{});return {id};},list:async(args)=>args?.archived?[]:[...metadata.keys()].map(id=>({id,status:statuses.get(id)??'active',deletedAt:null})),experimental_listPluginMetadata:async({threadIds})=>({threads:threadIds.flatMap(threadId=>metadata.has(threadId)?[{threadId,metadata:metadata.get(threadId)}]:[])})},
  }});
  return {...fake,native:new NativeTemplates(fake.sdk),projects,models,providers,defaults,config,env,metadata,statuses,get created(){return created;},get spawned(){return spawned;}};
}

import type {NativeSubmission} from '../native-submission';
export function nativeSubmission():NativeSubmission {
  return {projectId:'project-1',providerId:'codex',model:'model-a',reasoningLevel:'high',permissionMode:'auto',serviceTier:'default',sessionOptions:{plan:true,approval:'ask'},executionInputSources:{providerId:'explicit',model:'explicit',reasoningLevel:'client-preference',permissionMode:'explicit',serviceTier:'explicit'},environment:{type:'host',hostId:'host-main',workspace:{type:'unmanaged',path:null,branch:{kind:'new',baseBranch:'main'}}},input:[
    {type:'text',text:'Read @reference then /review',mentions:[{start:5,end:15,resource:{kind:'thread',label:'reference',threadId:'prior-thread',projectId:'project-1'}},{start:21,end:28,resource:{kind:'command',label:'review',name:'review',argumentHint:null,origin:'project',source:'skill',trigger:'/'}}]},
    {type:'localImage',path:'/screenshots/a.png',hostId:'host-files',sourceProjectId:'source-project'},
    {type:'localFile',path:'/files/report.pdf',name:'report.pdf',mimeType:'application/pdf',sizeBytes:321,hostId:'host-files',sourceProjectId:'source-project',visibility:'agent-only'},
  ]};
}
