import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,chmodSync,rmSync} from 'node:fs';
import fsPromises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import hostEntry,{mentionFileExists} from '../mention-file-host.ts';
import {MentionDiagnostics,safeMentionDiagnostic,mentionFileFrame} from '../mention-file-contract.ts';
import {createMentionFileVerifier} from '../mention-files.ts';

function roots(t:any){const base=mkdtempSync(join(tmpdir(),'mention-file-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const storage=join(base,'storage'),workspace=join(base,'workspace');mkdirSync(storage);mkdirSync(workspace);return {base,storage,workspace};}
const signal=()=>new AbortController().signal;
const source=(path:string)=>({provider:'bb.file',id:'thr_source:'+path,kind:'file'});

test('actual host helper admits contained regular files, rejects unsafe/missing/special targets, closes on cancellation',async t=>{
 const {base,storage}=roots(t);writeFileSync(join(storage,'good.txt'),'fixture');writeFileSync(join(base,'outside.txt'),'outside');
 mkdirSync(join(storage,'directory'));symlinkSync(join(base,'outside.txt'),join(storage,'outside-link.txt'));symlinkSync(join(storage,'good.txt'),join(storage,'inside-link.txt'));
 assert.deepEqual(await mentionFileExists(storage,'good.txt',signal()),{exists:true});
 assert.deepEqual(await mentionFileExists(storage,'inside-link.txt',signal()),{exists:true});
 for(const path of ['missing.txt','outside-link.txt','directory','../outside.txt','/outside.txt','foo%2fbar.txt','workspace:x.txt','./good.txt'])assert.deepEqual(await mentionFileExists(storage,path,signal()),{exists:false},path);
 const controller=new AbortController();controller.abort();await assert.rejects(mentionFileExists(storage,'good.txt',controller.signal));
 if(process.getuid?.()!==0){const privateRoot=join(base,'private');mkdirSync(privateRoot);writeFileSync(join(privateRoot,'a.txt'),'x');chmodSync(privateRoot,0);
  try{const result=await mentionFileExists(privateRoot,'a.txt',signal());assert.equal(result.exists,false);assert.equal(result.retryable,true);assert.equal(result.diagnostic?.stage,'host-target-realpath');assert.equal(result.diagnostic?.reason,'host-permission');assert.ok(Number.isInteger(result.diagnostic?.elapsedMs));}finally{chmodSync(privateRoot,0o700);}}
 assert.equal(hostEntry.experimental_apiVersion,1);
 const input=await hostEntry.contract.mentionFileExists.input['~standard'].validate({rootPath:storage,path:'good.txt',extra:true});assert.ok('issues' in input);
});

function sdkFixture(storage:string,workspace:string){
 const calls:{rootPath:string;path:string;hostId:string}[]=[];let metadata=0;
 const state={storageHost:'host_a',workspaceHost:'host_a',projectId:'proj_a',environmentId:'env_a',retryable:false};
 const bb={sdk:{threads:{get:async()=>{metadata++;return {id:'thr_source',projectId:'proj_a',environmentId:'env_a',deletedAt:null,host:{id:'host_a'}};},
  storageLocation:async()=>({hostId:state.storageHost,storageRootPath:storage})},environments:{get:async()=>({id:state.environmentId,projectId:state.projectId,hostId:state.workspaceHost,path:workspace})}},
  hosts:{experimental_client:()=>({call:async(method:string,input:any,options:any)=>{
   assert.equal(method,'mentionFileExists');calls.push({...input,hostId:options.hostId});
   if(state.retryable)return {exists:false,retryable:true};
   return hostEntry.handlers.mentionFileExists(input,{signal:options.signal,lifecycle:{signal:options.signal}} as any);
  }})}} as any;
 return {bb,calls,state,metadata:()=>metadata};
}

test('actual source verifier uses storage then workspace, pins explicit frames and caches distinct checks/metadata',async t=>{
 const {storage,workspace}=roots(t);writeFileSync(join(workspace,'workspace.txt'),'x');writeFileSync(join(storage,'storage.txt'),'x');
 const f=sdkFixture(storage,workspace),verify=createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'});
 assert.deepEqual(await verify(source('storage.txt'),signal()),{kind:'thread-storage',threadId:'thr_source',path:'storage.txt'});
 assert.deepEqual(await verify(source('workspace.txt'),signal()),{kind:'workspace',environmentId:'env_a',path:'workspace.txt'});
 const count=f.calls.length;await verify(source('workspace.txt'),signal());assert.equal(f.calls.length,count);assert.equal(f.metadata(),1);
 assert.equal(await verify(source('thread-storage:workspace.txt'),signal()),null);
 assert.equal(await verify(source('workspace:storage.txt'),signal()),null);
 const before=f.calls.length;
 for(const value of [source('../escape.txt'),{provider:'bb.file',id:'thr_foreign:storage.txt'},source('workspace:/tmp/outside.txt')])assert.equal(await verify(value,signal()),null);
 assert.equal(f.calls.length,before);
 assert.deepEqual(mentionFileFrame(source('workspace:workspace.txt'),'thr_source'),{frame:'workspace',path:'workspace.txt'});
});

test('actual source verifier rejects project/host/frame mismatches and marks transient host failures',async t=>{
 const {storage,workspace}=roots(t);writeFileSync(join(workspace,'a.txt'),'x');
 const f=sdkFixture(storage,workspace);
 f.state.projectId='proj_foreign';assert.equal(await createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'})(source('workspace:a.txt'),signal()),null);assert.equal(f.calls.length,0);
 f.state.projectId='proj_a';f.state.workspaceHost='host_foreign';await assert.rejects(createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'})(source('workspace:a.txt'),signal()),/mismatch/);
 f.state.workspaceHost='host_a';f.state.storageHost='host_foreign';await assert.rejects(createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'})(source('a.txt'),signal()),/mismatch/);
 f.state.storageHost='host_a';f.state.retryable=true;await assert.rejects(createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'})(source('a.txt'),signal()),/unavailable/);
 await assert.rejects(createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_changed'})(source('a.txt'),signal()),/changed/);
});

const groups=(diagnostics:MentionDiagnostics)=>JSON.parse(diagnostics.encode()).groups as any[];
test('actual verifier classifies SDK boundaries without wrapping errors or counting cached rejection replay',async t=>{
 const {storage,workspace}=roots(t);
 for(const stage of ['source-owner','thread-storage','environment'] as const){
  const f=sdkFixture(storage,workspace),diagnostics=new MentionDiagnostics(()=>true,()=>{throw new Error('diagnostic callback failure');});
  const error=Object.assign(new Error('private /absolute/root https://secret.test/?token=SECRET'),{status:503});let reads=0;
  const fail=async()=>{reads++;throw error;};
  if(stage==='source-owner')f.bb.sdk.threads.get=fail;
  if(stage==='thread-storage')f.bb.sdk.threads.storageLocation=fail;
  if(stage==='environment')f.bb.sdk.environments.get=fail;
  const verify=createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:'env_a'});
  for(const path of ['a.txt','b.txt'])await assert.rejects(verify(source(path),signal(),diagnostics.operation('native-wait','unknown',()=>9900)),e=>e===error && (e as any).status===503);
  assert.equal(reads,1);assert.equal(groups(diagnostics).length,1);assert.equal(groups(diagnostics)[0].stage,stage);
  assert.equal(groups(diagnostics)[0].reason,'sdk-failure');assert.equal(groups(diagnostics)[0].count,1);
  assert.equal(groups(diagnostics)[0].remainingMsMin,9900);assert.ok(groups(diagnostics)[0].elapsedMsMin>=0);
  assert.doesNotMatch(diagnostics.encode(),/SECRET|absolute|secret\.test|503/);
 }
});

test('actual verifier keeps frame/host mismatch, retryable response and transport failures distinct and safe',async t=>{
 const {storage,workspace}=roots(t);
 for(const kind of ['frame','host','retryable','detail','invalid','transport','named-timeout','named-abort'] as const){
  const f=sdkFixture(storage,workspace),diagnostics=new MentionDiagnostics();let calls=0;
  if(kind==='host')f.state.storageHost='host_foreign';
  const error=Object.assign(new Error('SECRET /private/root'),{name:kind==='named-timeout'?'TimeoutError':kind==='named-abort'?'AbortError':'Error',status:502});
  f.bb.hosts.experimental_client=()=>({call:async()=>{calls++;
   if(['transport','named-timeout','named-abort'].includes(kind))throw error;
   return {exists:false,retryable:true,...(kind==='detail'?{diagnostic:{stage:'host-open',reason:'host-permission',frame:'unknown',elapsedMs:3}}:
    kind==='invalid'?{diagnostic:{stage:'SECRET',reason:'/private/root',elapsedMs:Infinity}}:{})};
  }});
  const verify=createMentionFileVerifier(f.bb,{threadId:'thr_source',projectId:'proj_a',environmentId:kind==='frame'?'env_changed':'env_a'});
  if(['transport','named-timeout','named-abort'].includes(kind))await assert.rejects(verify(source('a.txt'),signal(),diagnostics.operation('native-wait')),e=>e===error);
  else await assert.rejects(verify(source('a.txt'),signal(),diagnostics.operation('native-wait')));
  const row=groups(diagnostics)[0];assert.equal(groups(diagnostics).length,1);
  assert.equal(row.reason,kind==='frame'?'frame-changed':kind==='host'?'host-root-mismatch':kind==='retryable'?'retryable-host-response':kind==='detail'?'host-permission':kind==='invalid'?'host-unknown':'transport-failure');
  assert.equal(row.stage,kind==='frame'?'source-owner':kind==='host'?'host-admission':kind==='detail'?'host-open':'host-transport');
  assert.equal(calls,kind==='frame'||kind==='host'?0:1);assert.doesNotMatch(diagnostics.encode(),/SECRET|private|stack|502/);
 }
});

test('diagnostic encoder bounds groups/UTF8, discloses dropped observations, rejects hostile payload and freezes on close',t=>{
 const diagnostics=new MentionDiagnostics(()=>true,()=>{throw new Error('sink failure');});
 for(let i=0;i<20;i++)diagnostics.record({stage:'host-transport',reason:'transport-failure',frame:'workspace',elapsedMs:1,remainingMs:9900});
 assert.equal(groups(diagnostics)[0].count,20);
 for(const stage of ['source-prefetch','timeline-prefetch','project-context','thread-target','file-admission','source-owner','thread-storage','environment','host-admission','host-root-realpath','host-root-stat','host-target-realpath','host-open','host-file-stat','host-opened-realpath','host-revalidate','host-current-stat','host-close','native-wait','collection']){
  diagnostics.record({stage,reason:'source-identity-mismatch',frame:'thread-storage',elapsedMs:60000,remainingMs:60000});
 }
 const encoded=diagnostics.encode(),result=JSON.parse(encoded);
 assert.ok(Buffer.byteLength(encoded,'utf8')<=4096);assert.ok(result.groups.length<=16);assert.equal(result.capped,true);assert.ok(result.omittedCount>=5);
 diagnostics.close();const late=diagnostics.operation('collection');late.fail('unknown');diagnostics.record({});assert.equal(diagnostics.encode(),encoded);
 const hostile=new Proxy({},{get(){throw new Error('SECRET');},ownKeys(){throw new Error('SECRET');}});
 assert.doesNotThrow(()=>safeMentionDiagnostic(hostile));
 const invalid=new MentionDiagnostics();invalid.record({stage:'host-open',reason:'host-io',frame:'unknown',elapsedMs:NaN});invalid.record(hostile);
 assert.doesNotMatch(invalid.encode(),/NaN|Infinity|SECRET/);assert.equal(groups(invalid)[0].reason,'host-unknown');
 let clock=0;t.mock.method(performance,'now',()=>clock);const timing=new MentionDiagnostics();const operation=timing.operation('source-owner','unknown',()=>Infinity);clock=90000;operation.fail('sdk-failure');
 const bounded=JSON.parse(timing.encode());assert.equal(bounded.capped,true);assert.equal(bounded.groups[0].elapsedMsMax,60000);assert.equal(bounded.groups[0].remainingMsMax,undefined);
 const noClock=new MentionDiagnostics();t.mock.method(performance,'now',()=>NaN);noClock.operation('collection').fail('unknown');assert.equal(groups(noClock)[0].elapsedMsMax,undefined);
});

test('actual host RPC output validation bounds optional detail and maps invalid detail to safe unknown',async()=>{
 const schema=hostEntry.contract.mentionFileExists.output;
 const valid={stage:'host-open',reason:'host-permission',frame:'unknown',elapsedMs:2};
 for(const diagnostic of [undefined,valid,{},'SECRET'.repeat(10000),{...valid,stage:'source-owner'},{...valid,frame:'workspace'},
  {...valid,reason:'native-timeout'},{...valid,remainingMs:1},{...valid,extra:'SECRET'},{...valid,elapsedMs:NaN},
  {...valid,elapsedMs:Infinity},{...valid,elapsedMs:-1},{...valid,elapsedMs:2**53}]){
  const result=await schema['~standard'].validate({exists:false,retryable:true,...(diagnostic===undefined?{}:{diagnostic})});
  assert.ok(!('issues' in result) || !result.issues);if(!('value' in result))throw new Error('Expected validated result');
  const value=result.value as any;assert.equal(value.retryable,true);assert.equal(value.exists,false);
  if(diagnostic===undefined)assert.equal(value.diagnostic,undefined);
  else if(diagnostic===valid)assert.deepEqual(value.diagnostic,valid);
  else assert.deepEqual(value.diagnostic,{stage:'host-transport',reason:'host-unknown',frame:'unknown'});
  assert.doesNotMatch(JSON.stringify(value),/SECRET|NaN|Infinity/);
 }
});

test('actual host finally closes an opened descriptor and preserves close rejection identity/status',async t=>{
 const {storage}=roots(t);writeFileSync(join(storage,'good.txt'),'fixture');
 const openOriginal=fsPromises.open,error=Object.assign(new Error('SECRET close failure'),{status:507});let closes=0;
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 t.mock.method(fsPromises,'open',async(...args:Parameters<typeof fsPromises.open>)=>{
  const file=await openOriginal(...args),close=file.close.bind(file);
  file.close=async()=>{closes++;await close();throw error;};return file;
 });syncBuiltinESMExports();
 await assert.rejects(mentionFileExists(storage,'good.txt',signal()),failure=>failure===error && (failure as any).status===507);
 assert.equal(closes,1);
});

test('diagnostic observation counts saturate finitely and disclose count clipping',()=>{
 const diagnostics=new MentionDiagnostics();const event={stage:'host-open',reason:'host-io',frame:'unknown'};
 for(let count=0;count<1_000_001;count++)diagnostics.record(event);
 const envelope=JSON.parse(diagnostics.encode());assert.equal(envelope.groups[0].count,1_000_000);assert.equal(envelope.capped,true);
 assert.ok(Buffer.byteLength(diagnostics.encode())<=4096);
});
