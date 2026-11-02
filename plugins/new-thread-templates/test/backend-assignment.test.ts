/** Consumer conformance against scripted PUBLIC V1 outcomes, not Inbox transaction proof. */
import {test,expect} from 'bun:test';
import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {makeThreadResponse} from '@get-bb/plugin-sdk/testing';
import {assignmentFactories,verifiedAlice,verifiedBob} from './backend-assignment-fixtures';
import {nativeSubmission} from './backend-fixtures';
import {templatesContract} from '../rpc-contract';
import {CREATED_THREAD_ASSIGNMENT_METHODS as METHODS,type CreatedThreadClaimInput,type CreatedThreadClaimResult} from '../inbox-assignment-contract';
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function reached(predicate:()=>boolean){for(let n=0;n<100&&!predicate();n++)await new Promise(r=>setTimeout(r,1));expect(predicate()).toBe(true);}
type Fixture=Awaited<ReturnType<typeof assignmentFactories>>;
const claims=(s:Fixture)=>s.forwarded.filter(f=>f.method===METHODS.claim);
async function retry(s:Fixture,id:string){const c=await s.context();return templatesContract.retryAssignment.output.parse(await s.tpl.harness.behavior.callRpc('retryAssignment',{operationId:id,expectedActor:c.actor.key,expectedSession:c.session}));}
async function check(s:Fixture,id:string){return templatesContract.launchStatus.output.parse(await s.tpl.harness.behavior.callRpc('launchStatus',{operationId:id}));}
function final(input:CreatedThreadClaimInput):Extract<CreatedThreadClaimResult,{status:'final'}>{return {version:1,status:'final',receipt:{...input,actorKey:verifiedAlice.identity.key,outcome:'claimed',reason:'claimed-untouched',decidedAt:1,ownerRevision:1},current:{threadId:input.threadId,revision:1,ownerKeys:[verifiedAlice.identity.key],truncated:false,explicitlyUnassigned:false}};}

test('real Templates journal and shared nested transport carry person with strict operation/thread payload in direct and native modes',async()=>{
 for(const native of [false,true]){const s=await assignmentFactories();try{
  const {input,status}=await s.launch(native?{nativeSubmission:nativeSubmission()}:{});expect(status).toMatchObject({phase:'succeeded',assignment:{state:'claimed',actorKey:verifiedAlice.identity.key,current:{ownerKeys:[verifiedAlice.identity.key]},receipt:{outcome:'claimed'}}});
  expect(status.assignment!.operationId).toBe('new-thread-templates:'+input.operationId);expect(s.f.store.launch(input.operationId)!.capturedActor).toEqual(verifiedAlice);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);expect(claims(s)).toHaveLength(1);
  for(const f of s.forwarded.filter(f=>f.method!==METHODS.describe))expect(Object.keys(f.input as object).sort()).toEqual(['operationId','threadId']);
  expect(await s.tpl.harness.behavior.callRpc('launch',input)).toMatchObject({phase:'succeeded'});expect(claims(s)).toHaveLength(1);if(native)expect(s.f.store.launch(input.operationId)!.request.nativeSubmission).toEqual(nativeSubmission());
 }finally{await s.dispose();}}
});

test('response loss and reopen recover historical receipt separately from current Unassign without resend',async()=>{
 const s=await assignmentFactories();let receipt:ReturnType<typeof final>|undefined;
 s.scripted.claim=async input=>{receipt=final(input);throw new Error('response lost after remote commit');};s.scripted.lookup=async input=>receipt?{...receipt,status:'found',current:{threadId:input.threadId,revision:2,ownerKeys:[],truncated:false,explicitlyUnassigned:true}}:{version:1,status:'absent',...input,current:{threadId:input.threadId,revision:0,ownerKeys:[],truncated:false,explicitlyUnassigned:false}};
 try{const {input,status}=await s.launch();expect(status).toMatchObject({phase:'succeeded',assignment:{state:'unknown'}});await s.replaceTemplates(true);expect(await check(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed',receipt:{outcome:'claimed'},current:{revision:2,ownerKeys:[],explicitlyUnassigned:true}}});expect(await retry(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed',current:{ownerKeys:[]}}});expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);
  await s.tpl.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:status.threadId!,originPluginId:'new-thread-templates',deletedAt:Date.now()})});expect(await check(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed',receipt:{outcome:'claimed'},current:{ownerKeys:[]}}});expect(claims(s)).toHaveLength(1);
 }finally{await s.dispose();}
});

test('expired original scope after ACK preserves creation and only fresh original person can retry',async()=>{
 const s=await assignmentFactories();s.native.harness.stub('threads.spawn',async()=>{s.harness.setActor(verifiedBob);return {id:'ack-after-actor-change'};});
 try{const {input,status}=await s.launch();expect(status).toMatchObject({phase:'succeeded',assignment:{actorKey:verifiedAlice.identity.key,state:'pending'}});expect(claims(s)).toHaveLength(0);await expect(retry(s,input.operationId)).rejects.toThrow('original live person');s.harness.setActor(verifiedAlice);expect(await check(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'pending',retryable:true}});expect(await retry(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed'}});expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{await s.dispose();}
});

test('optional absent/future/inconsistent/oversized provider never revokes confirmed creation',async()=>{
 for(const failure of ['absent','version','unknown-outcome','inconsistent','oversized']){const s=await assignmentFactories();s.intercept(async(destination,input,run)=>{
  if(failure==='absent')throw new Error('Inbox not running');if(failure==='version'&&destination.method===METHODS.describe)return {protocol:'inbox-created-thread-assignment',versions:[2],limits:{operationId:160,threadId:256,ownerKeys:200,receiptRetention:'indefinite'}};
  if(destination.method===METHODS.claim&&failure==='unknown-outcome')return {version:2,status:'a-future-success'};if(destination.method===METHODS.claim&&failure==='inconsistent'){const r=final(input as CreatedThreadClaimInput);return {...r,receipt:{...r.receipt,reason:'ownership-touched'}};}if(destination.method===METHODS.claim&&failure==='oversized')return {...final(input as CreatedThreadClaimInput),future:'x'.repeat(70000)};return run();
 });try{const {status}=await s.launch();expect(status.phase).toBe('succeeded');expect(status.threadId).not.toBeNull();expect(status.assignment!.state).toBe(failure==='absent'||failure==='version'?'unavailable':'unknown');expect(status.assignment!.receipt).toBeUndefined();expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);expect(s.forwarded.some(f=>f.method==='setOwner')).toBe(false);}finally{await s.dispose();}}
});

test('concurrent explicit retries reserve whole awaited preflight and dispatch one raw claim',async()=>{
 const s=await assignmentFactories();s.intercept(async()=>{throw new Error('provider initially absent');});try{const {input}=await s.launch(),gate=deferred<void>();let described=false;s.intercept(async(destination,_input,run)=>{if(destination.method===METHODS.describe){described=true;await gate.promise;}return run();});const a=retry(s,input.operationId),b=retry(s,input.operationId);await reached(()=>described);expect(claims(s)).toHaveLength(0);gate.resolve();await Promise.all([a,b]);expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{await s.dispose();}
});

test('timeout is unknown and raw slot stays occupied until actual settlement, preventing overlapping retry',async()=>{
 const s=await assignmentFactories(),gate=deferred<void>();s.intercept(async(destination,_input,run)=>{const result=await run();if(destination.method===METHODS.claim)await gate.promise;return result;});try{const {input,status}=await s.launch();expect(status).toMatchObject({phase:'succeeded',assignment:{state:'unknown',retryable:false}});expect(s.f.store.launch(input.operationId)!.assignmentDispatch!.rawPending).toBe(true);await retry(s,input.operationId);expect(claims(s)).toHaveLength(1);gate.resolve();await reached(()=>s.f.store.launch(input.operationId)!.status.assignment!.state==='claimed');expect(s.f.store.launch(input.operationId)!.assignmentDispatch!.rawPending).toBe(false);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{gate.resolve();await s.dispose();}
},10000);

test('creation retired during held confirmation read cannot dispatch Inbox claim',async()=>{
 const s=await assignmentFactories(),gate=deferred<void>();let reading=false;s.tpl.harness.inspection.sdk.stub('threads.get',async()=>{reading=true;await gate.promise;return makeThreadResponse({id:'thread-1',originPluginId:'new-thread-templates',status:'active'});});try{const pending=s.launch();await reached(()=>reading);await s.tpl.harness.behavior.emitThreadEvent('thread.deleted',{thread:makeThreadResponse({id:'thread-1',originPluginId:'new-thread-templates',deletedAt:Date.now()})});gate.resolve();expect((await pending).status.phase).toBe('succeeded');expect(s.f.store.wasThreadRemoved('thread-1')).toBe(true);expect(claims(s)).toHaveLength(0);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{gate.resolve();await s.dispose();}
});

test('created pending alone has zero assignments; ACK of accepted queued pending permits one attempt',async()=>{
 const s=await assignmentFactories(),gate=deferred<{id:string}>();let spawning=false;s.native.harness.stub('threads.spawn',async(input:Parameters<BbPluginApi['sdk']['threads']['spawn']>[0])=>{s.native.metadata.set('queued',input.pluginMetadata??{});s.native.statuses.set('queued','pending');spawning=true;return gate.promise;});try{const pending=s.launch();await reached(()=>spawning);await s.tpl.harness.behavior.emitThreadEvent('thread.created',{thread:makeThreadResponse({id:'queued',status:'pending',originPluginId:'new-thread-templates'})});expect(claims(s)).toHaveLength(0);gate.resolve({id:'queued'});expect((await pending).status).toMatchObject({phase:'succeeded',assignment:{state:'claimed'}});expect(claims(s)).toHaveLength(1);}finally{gate.resolve({id:'queued'});await s.dispose();}
});

test('replacement stores late ACK without resurrecting original person; fresh check/retry uses same id',async()=>{
 const s=await assignmentFactories(),gate=deferred<{id:string}>();let spawning=false;s.native.harness.stub('threads.spawn',async()=>{spawning=true;return gate.promise;});try{const pending=s.launch();await reached(()=>spawning);await s.replaceTemplates();gate.resolve({id:'late-ack'});const {input,status}=await pending;expect(status.phase).toBe('succeeded');expect(claims(s)).toHaveLength(0);expect(await check(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{retryable:true}});expect(await retry(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed'}});expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{gate.resolve({id:'late-ack'});await s.dispose();}
});

test('slow absent lookup cannot regress terminal receipt/current revision; foreign absent never permits retry',async()=>{
 const s=await assignmentFactories();let gate:ReturnType<typeof deferred<void>>|undefined,looking=false;try{const {input,status}=await s.launch(),terminal=status.assignment!;gate=deferred<void>();s.scripted.lookup=async p=>{looking=true;await gate!.promise;return {version:1,status:'absent',...p,current:{threadId:p.threadId,revision:0,ownerKeys:[],truncated:false,explicitlyUnassigned:false}};};const pending=check(s,input.operationId);await reached(()=>looking);s.f.store.patchAssignment(input.operationId,row=>({value:{...row.status.assignment!,current:{...terminal.current!,revision:4,ownerKeys:[],explicitlyUnassigned:true}}}),()=>{});gate.resolve();expect(await pending).toMatchObject({assignment:{state:'claimed',retryable:false,receipt:terminal.receipt,current:{revision:4,ownerKeys:[]}}});
  const second=await s.launch();s.scripted.lookup=async p=>({version:1,status:'absent',...p,threadId:'wrong-thread',current:{threadId:'wrong-thread',revision:0,ownerKeys:[],truncated:false,explicitlyUnassigned:false}});expect(await check(s,second.input.operationId)).toMatchObject({assignment:{state:'claimed',retryable:false}});expect(claims(s)).toHaveLength(2);
 }finally{gate?.resolve();await s.dispose();}
});

test('old rows without intent remain readable and are never backfilled after reopen',async()=>{
 const s=await assignmentFactories();try{const {input}=await s.launch(),row=s.f.store.launch(input.operationId)!;delete row.status.assignment;delete row.assignmentDispatch;s.f.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(row),input.operationId);const count=s.forwarded.length;await s.replaceTemplates(true);expect((await check(s,input.operationId))!.assignment).toBeUndefined();expect(s.forwarded).toHaveLength(count);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{await s.dispose();}
});

test('ACK-lost pending remains check-only; retained active receipt plus fresh native read permits explicit same-id assignment',async()=>{
 const s=await assignmentFactories();s.native.harness.stub('threads.spawn',async(input:Parameters<BbPluginApi['sdk']['threads']['spawn']>[0])=>{s.native.metadata.set('lost-ack',input.pluginMetadata??{});s.native.statuses.set('lost-ack','pending');throw new Error('ACK lost');});try{const {input,status}=await s.launch();expect(status.phase).toBe('indeterminate');expect((await check(s,input.operationId))!.phase).toBe('indeterminate');expect(claims(s)).toHaveLength(0);s.native.statuses.set('lost-ack','active');expect(await check(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{retryable:true}});expect(s.f.store.launch(input.operationId)!.confirmation).toBe('lifecycle');expect(await retry(s,input.operationId)).toMatchObject({phase:'succeeded',assignment:{state:'claimed'}});expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);}finally{await s.dispose();}
});

test('terminal lookup resolves older claim timeout; old timeout/late response preserve a genuinely newer lookup failure',async()=>{
 for(const laterLookupFails of [false,true]){
  const s=await assignmentFactories(),gate=deferred<void>();let committed:ReturnType<typeof final>|undefined,claiming=false;
  s.scripted.claim=async input=>{claiming=true;committed=final(input);await gate.promise;return committed;};s.scripted.lookup=async()=>{if(!committed)throw Error('not yet committed');return {...committed,status:'found'};};
  try{const pending=s.launch();await reached(()=>claiming);const id=s.f.db.prepare('SELECT id FROM template_launches').get() as {id:string};expect(await check(s,id.id)).toMatchObject({assignment:{state:'claimed',receipt:committed!.receipt}});const confirmed=s.f.store.launch(id.id)!.status.assignment!;
   if(laterLookupFails){s.scripted.lookup=async()=>{throw Error('newer lookup unavailable');};expect(await check(s,id.id)).toMatchObject({assignment:{state:'claimed',message:'Destination plugin call failed.'}});}
   const expected=s.f.store.launch(id.id)!.status.assignment!;await pending;expect(s.f.store.launch(id.id)!.status.assignment).toEqual(expected);expect(expected.receipt).toEqual(confirmed.receipt);gate.resolve();await reached(()=>!s.f.store.launch(id.id)!.assignmentDispatch!.rawPending);expect(s.f.store.launch(id.id)!.status.assignment).toEqual(expected);expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);
   if(laterLookupFails){s.scripted.lookup=async()=>({...committed!,status:'found'});expect(await check(s,id.id)).toMatchObject({assignment:{state:'claimed',message:'Initial assignment recorded.'}});}
  }finally{gate.resolve();await s.dispose();}
 }
},10000);

test('failed Check before first local receipt survives late claim success, then authoritative Check clears the same read failure',async()=>{
 const s=await assignmentFactories(),gate=deferred<void>();let committed:ReturnType<typeof final>|undefined,claiming=false,pending:ReturnType<typeof s.launch>|undefined;
 s.scripted.claim=async input=>{claiming=true;committed=final(input);await gate.promise;return committed;};s.scripted.lookup=async()=>{throw Error('lookup failed before first local receipt');};
 try{pending=s.launch();await reached(()=>claiming);const {id}=s.f.db.prepare('SELECT id FROM template_launches').get() as {id:string};const failed=await check(s,id);expect(failed).toMatchObject({phase:'succeeded',assignment:{state:'unavailable',message:'Destination plugin call failed.',retryable:false}});expect(failed!.assignment!.receipt).toBeUndefined();
  gate.resolve();const result=await pending;expect(result.status).toMatchObject({phase:'succeeded',assignment:{state:'claimed',receipt:committed!.receipt,current:committed!.current,message:failed!.assignment!.message,retryable:false}});expect(claims(s)).toHaveLength(1);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(1);
  s.scripted.lookup=async()=>({...committed!,status:'found'});expect(await check(s,id)).toMatchObject({phase:'succeeded',assignment:{state:'claimed',receipt:committed!.receipt,current:committed!.current,message:'Initial assignment recorded.'}});expect(claims(s)).toHaveLength(1);
 }finally{gate.resolve();await pending?.catch(()=>{});await s.dispose();}
});
