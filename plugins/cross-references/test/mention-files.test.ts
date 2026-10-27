import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import hostEntry,{mentionFileExists} from '../mention-file-host.ts';
import {mentionFileFrame} from '../mention-file-contract.ts';
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
  try{assert.deepEqual(await mentionFileExists(privateRoot,'a.txt',signal()),{exists:false,retryable:true});}finally{chmodSync(privateRoot,0o700);}}
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
