import {test,expect} from 'bun:test';
import {LaunchService} from '../launch';
import {createRenderContext,launchRequestSchema} from '../model';
import {databaseFixture,nativeFixture,published,definition,launchActor,launchRequest,nativeSubmission} from './backend-fixtures';
const instant=Date.parse('2026-03-29T00:59:00Z');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function reached(fn:()=>boolean){for(let i=0;i<200&&!fn();i++)await new Promise(r=>setTimeout(r,1));expect(fn()).toBe(true);}
const timed=()=>definition({timeZone:'Europe/Berlin',titleTemplate:'At {{date @now "HH mm"}}',promptTemplate:'Task {{task}} / {{@now}}'});

test('legacy missing context captures once separately from unchanged request/fingerprint, concurrent replay and reopen',async()=>{
 let clock=instant;const f=databaseFixture(()=>clock),n=nativeFixture();published(f,timed());const service=new LaunchService(f.store,n.native),gate=deferred<{id:string}>();let entered=false;n.harness.stub('threads.spawn',async()=>{entered=true;return gate.promise;});const request=launchRequest();let pending:Promise<unknown>|undefined;
 try{pending=service.launch(request,launchActor());await reached(()=>entered);const first=f.store.launch(request.operationId)!;expect(first.request.renderContext).toBeUndefined();expect(first.renderContext).toEqual(createRenderContext('Europe/Berlin',instant));clock+=86400000;expect((await service.launch(request,launchActor())).phase).toBe('indeterminate');expect(f.store.launch(request.operationId)!.fingerprint).toBe(first.fingerprint);gate.resolve({id:'one-time'});await pending;service.dispose();f.reopen();const restored=new LaunchService(f.store,n.native);expect((await restored.launch({...request,expectedSession:'new-session'},launchActor('new-session'))).phase).toBe('succeeded');const row=f.store.launch(request.operationId)!;expect(row.renderContext).toEqual(first.renderContext);expect(row.nativeRequest!.title).toBe('At 01 59 CET');expect(row.request.renderContext).toBeUndefined();expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);expect(f.store.recentLaunches(request.expectedActor).launches[0]!.requestedRenderContext).toBeUndefined();restored.dispose();
 }finally{gate.resolve({id:'one-time'});await pending?.catch(()=>{});service.dispose();f.close();}
});

test('supplied context is immutable fingerprint, authoritative zone and historical requested presence',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f,timed());const service=new LaunchService(f.store,n.native),context=createRenderContext('Asia/Kathmandu',instant),request=launchRequestSchema.parse(launchRequest({renderContext:context}));
 try{expect((await service.launch(request,launchActor())).phase).toBe('succeeded');const row=f.store.launch(request.operationId)!;expect(row.status.renderContext).toEqual(context);expect(row.effects!.title).toBe('At 06 44 GMT+5:45');expect(f.store.recentLaunches(request.expectedActor).launches[0]!.requestedRenderContext).toEqual(context);await expect(service.launch({...request,renderContext:{...context,instant:instant+1}},launchActor())).rejects.toThrow('immutable launch');const {renderContext:_context,...absent}=request;await expect(service.launch(absent,launchActor())).rejects.toThrow('immutable launch');expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{service.dispose();f.close();}
});

test('same admitted context survives project pause, final defaults and response-loss project recovery',async()=>{
 let clock=instant;const f=databaseFixture(()=>clock),n=nativeFixture();const def={...timed(),destination:{kind:'new-project' as const,nameTemplate:'Project {{date @now "yyyy"}}',hostId:'host-main',path:'/new/time',environment:{kind:'local-source' as const}}};published(f,def);const service=new LaunchService(f.store,n.native),request=launchRequest();
 n.harness.stub('projects.create',async()=>{clock+=86400000;n.projects.push({id:'provisioned',name:'Native project',kind:'standard',sources:[{hostId:'host-main',path:'/new/time',isDefault:true}]});throw Error('project response lost');});
 try{expect((await service.launch(request,launchActor())).phase).toBe('project-unknown');const captured=f.store.launch(request.operationId)!.renderContext;service.dispose();f.reopen();const fresh=new LaunchService(f.store,n.native);expect((await fresh.status(request.operationId))!.phase).toBe('failed');expect((await fresh.launch({...request,expectedSession:'fresh'},launchActor('fresh'))).phase).toBe('succeeded');const saved=f.store.launch(request.operationId)!;expect(saved.renderContext).toEqual(captured);expect(saved.effects!.renderContext).toEqual(captured);expect(saved.nativeRequest!.title).toBe('At 01 59 CET');expect(n.harness.callsTo('projects.create')).toHaveLength(1);expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);fresh.dispose();}finally{service.dispose();f.close();}
});

test('native exact user input is final while generated title uses origin context through clock jump',async()=>{
 let clock=instant;const f=databaseFixture(()=>clock),n=nativeFixture();published(f,timed());const service=new LaunchService(f.store,n.native),renderContext=createRenderContext('Europe/Berlin',instant),submission=nativeSubmission();submission.input=[{type:'text',text:'Edited literal {{@now}} without a generated suffix',mentions:[]}];clock+=99999999;const request=launchRequest({renderContext,nativeSubmission:submission});
 try{expect((await service.launch(request,launchActor())).phase).toBe('succeeded');const row=f.store.launch(request.operationId)!;expect(row.request.nativeSubmission).toEqual(submission);expect(row.nativeRequest!.input).toEqual(submission.input);expect(row.nativeRequest!.title).toBe('At 01 59 CET');expect(row.renderContext).toEqual(renderContext);expect(row.effects!.renderContext).toEqual(renderContext);}finally{service.dispose();f.close();}
});

test('preview shares supplied context without effects/samples and invalid zone stays draft-only',async()=>{
 const n=nativeFixture(),renderContext=createRenderContext('UTC',instant);const preview=await n.native.preview(timed(),{task:'sample'},undefined,renderContext);expect(preview.renderContext).toEqual(renderContext);expect(preview.effects!.renderContext).toEqual(renderContext);expect(preview.effects!.title).toBe('At 00 59 UTC');expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);expect((await n.native.preview({...timed(),timeZone:'Not/Valid'},{task:'x'},undefined,renderContext)).issues.some(i=>i.path==='timeZone')).toBe(true);
});

test('old persisted full-suffix receipt and exact native input replay unchanged after compact presentation',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f,timed());const service=new LaunchService(f.store,n.native),renderContext=createRenderContext('Europe/Berlin',instant),submission=nativeSubmission();
 // These literals model an already accepted pre-change receipt and user-edited input.
 const oldTitle='At 01 59 GMT+01:00 [Europe/Berlin]',oldBody='User retained 2026-03-29 01:59:00 GMT+01:00 [Europe/Berlin]';
 submission.input=[{type:'text',text:oldBody,mentions:[]}];const request=launchRequest({renderContext,nativeSubmission:submission});
 try{expect((await service.launch(request,launchActor())).phase).toBe('succeeded');const row=f.store.launch(request.operationId)!;row.effects!.title=oldTitle;row.nativeRequest!.title=oldTitle;
  const persisted=JSON.stringify(row);f.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(persisted,request.operationId);service.dispose();f.reopen();const fresh=new LaunchService(f.store,n.native);
  try{expect((await fresh.launch({...request,expectedSession:'reopened'},launchActor('reopened'))).phase).toBe('succeeded');expect((await fresh.status(request.operationId))!.threadId).toBe(row.status.threadId);
   const restored=f.store.launch(request.operationId)!;expect(restored.nativeRequest!.title).toBe(oldTitle);expect(restored.nativeRequest!.input).toEqual(submission.input);expect(restored.effects!.title).toBe(oldTitle);expect(restored.effects!.prompt).toBe(oldBody);expect(restored.renderContext).toEqual(renderContext);
   expect(f.store.recentLaunches(request.expectedActor).launches[0]!.effects!.title).toBe(oldTitle);expect(f.db.prepare('SELECT data FROM template_launches WHERE id=?').get(request.operationId)).toEqual({data:persisted});expect(n.harness.callsTo('threads.spawn')).toHaveLength(1);
  }finally{fresh.dispose();}
 }finally{service.dispose();f.close();}
});
