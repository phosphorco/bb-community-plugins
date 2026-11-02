import {test,expect} from 'bun:test';
import {LaunchService} from '../launch';
import {databaseFixture,published,nativeFixture,launchRequest,launchActor,nativeSubmission,alice} from './backend-fixtures';

test('startup recovery only decodes genuinely interrupted phases, leaving all completed/history rows untouched',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native);
 try{const request=launchRequest();await service.launch(request,launchActor());service.dispose();const interrupted=f.store.launch(request.operationId)!;interrupted.status.phase='preparing';interrupted.status.threadId=null;interrupted.confirmation=null;const priorToken=interrupted.token;f.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(interrupted),request.operationId);
  const completed=JSON.stringify({status:{phase:'succeeded'},futureCompletedVersion:2,payload:'Preserve without decoding'});const insert=f.db.prepare('INSERT INTO template_launches VALUES(?,?)');for(let i=0;i<1000;i++)insert.run('completed-'+i,completed);
  expect(()=>f.store.recoverInterrupted()).not.toThrow();expect(f.store.launch(request.operationId)).toMatchObject({status:{phase:'failed',retryable:true}});expect(f.store.launch(request.operationId)!.token).not.toBe(priorToken);expect(f.db.prepare("SELECT COUNT(*) AS n FROM template_launches WHERE data=?").get(completed)).toEqual({n:1000});
 }finally{service.dispose();f.close();}
});

test('History pages fit serialized budget with complete large valid native submissions and exact count-based offsets',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native);const submission=nativeSubmission();submission.input=Array.from({length:4},()=>({type:'text' as const,text:'x'.repeat(220000),mentions:[]}));
 try{for(let i=0;i<7;i++)expect((await service.launch(launchRequest({nativeSubmission:submission}),launchActor())).phase).toBe('succeeded');const ids:string[]=[];let offset:number|null=0,pages=0;do{const start=offset;const page=f.store.recentLaunches(alice.identity.key,start);expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(4*1024*1024);expect(page.launches.length).toBeGreaterThan(0);for(const row of page.launches){expect(row.nativeSubmission).toEqual(submission);ids.push(row.status.operationId);}if(page.nextOffset!==null)expect(page.nextOffset).toBe(start+page.launches.length);offset=page.nextOffset;pages++;}while(offset!==null&&pages<10);expect(pages).toBeGreaterThan(1);expect(offset).toBeNull();expect(new Set(ids).size).toBe(7);expect(f.db.prepare('SELECT COUNT(*) AS n FROM template_launches').get()).toEqual({n:7});
 }finally{service.dispose();f.close();}
});

test('single oversized legacy-compatible history record is complete and alone, with a usable next offset',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native);
 try{const request=launchRequest();await service.launch(request,launchActor());const record=f.store.launch(request.operationId)!;record.revision.definition.fields[0]!.options=[{label:'x'.repeat(4*1024*1024),value:'historical-option'}];record.status.createdAt=Date.now()+1000;f.db.prepare('UPDATE template_launches SET data=? WHERE id=?').run(JSON.stringify(record),request.operationId);await service.launch(launchRequest(),launchActor());
  const page=f.store.recentLaunches(alice.identity.key);expect(page.launches).toHaveLength(1);expect(page.launches[0]!.revision.definition.fields[0]!.options![0]!.label).toHaveLength(4*1024*1024);expect(page.nextOffset).toBe(1);const next=f.store.recentLaunches(alice.identity.key,page.nextOffset!);expect(next.launches).toHaveLength(1);expect(next.nextOffset).toBeNull();expect(next.launches[0]!.status.operationId).not.toBe(request.operationId);
 }finally{service.dispose();f.close();}
});

test('SQLite query plans select recoverable and actor-history indexes, without sorting or decoding completed journals',()=>{
 const f=databaseFixture();try{const recovery=f.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM template_launches WHERE json_extract(data,'$.status.phase') IN ('preparing','ready','project-claimed','spawn-claimed')").all();expect(JSON.stringify(recovery)).toContain('template_launch_recoverable_phase');const history=f.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM template_launches WHERE json_extract(data,'$.capturedActor.identity.key')=? ORDER BY json_extract(data,'$.status.createdAt') DESC,id DESC LIMIT 51 OFFSET ?").all(alice.identity.key,0);expect(JSON.stringify(history)).toContain('template_launch_actor_history');expect(JSON.stringify(history)).not.toContain('TEMP B-TREE');}finally{f.close();}
});

test('startup recovers each interrupted phase once and preserves stable effect claims and already-unknown rows',async()=>{
 const f=databaseFixture(),n=nativeFixture();published(f);const service=new LaunchService(f.store,n.native);
 try{const request=launchRequest();await service.launch(request,launchActor());service.dispose();const base=f.store.launch(request.operationId)!,ids:string[]=[];for(const phase of ['preparing','ready','project-claimed','spawn-claimed','project-unknown','indeterminate'] as const){const row=structuredClone(base),id=crypto.randomUUID();row.request.operationId=id;row.status.operationId=id;row.status.phase=phase;row.status.threadId=null;row.confirmation=null;row.projectClaim='stable-project';row.spawnClaim='stable-spawn';f.db.prepare('INSERT INTO template_launches VALUES(?,?)').run(id,JSON.stringify(row));ids.push(id);}
  f.store.recoverInterrupted();const expected=['failed','failed','project-unknown','indeterminate','project-unknown','indeterminate'] as const;ids.forEach((id,i)=>{const row=f.store.launch(id)!;expect(row.status.phase).toBe(expected[i]!);expect(row.projectClaim).toBe('stable-project');expect(row.spawnClaim).toBe('stable-spawn');expect(row.token===base.token).toBe(i>=4);});const snapshot=ids.map(id=>f.store.launch(id));f.store.recoverInterrupted();expect(ids.map(id=>f.store.launch(id))).toEqual(snapshot);
 }finally{service.dispose();f.close();}
});
