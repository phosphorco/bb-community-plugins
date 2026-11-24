import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {collectorMain,collectorPolicy,Collectors,collectorDiagnostic} from "../collector.ts";
import {recipeSchema,publicRecord} from "../contracts.ts";
import {runBash} from "../runner.ts";
import {Store,type Database} from "../store.ts";
import {Engine} from "../engine.ts";
import Sqlite from "better-sqlite3";
const token="known-synthetic-assignment-credential";
const config={id:"sub_synthetic",token,generation:1,recipe:undefined,expires_at:null};
const decode=(a:string[])=>JSON.parse(Buffer.from(a.join(""),"base64").toString());

test("one failed ordinary CLI poll recovers beyond the old15s grace and retains error context with credential-specific redaction",async()=>{
 const clock=Date.now;let at=0,polls=0,reported:any;Date.now=()=>at;
 try{
  const result=await collectorMain(config,async()=>{throw Error("no recipe may run");},async()=>({transport:"cli",rpc:async(op:string,args:string[])=>{
   if(op==="collector-stopped"){reported=decode(args);return {accepted:true};}
   assert.equal(op,"collector-poll");polls++;if(polls===1)return {stop:false,task:null};
   if(polls===2){at=35000;throw Object.assign(Error("CLI unavailable at http://127.0.0.1:38886 token="+token),{code:"ETIMEDOUT",path:"/native/bb",details:{threadId:"thr_synthetic",setting:"ordinary",errorBody:"kept"}});}
   at=polls===3?55000:75000;return polls===3?{stop:false,task:null}:{stop:true,reason:"subscription-cancelled"};
  },abort(){},close(){}}) as never);
  assert.equal(polls,4);assert.equal(result.stop!.failure,false);assert.equal(reported.stop.reason,"subscription-cancelled");assert.equal(reported.transport,"cli");assert(reported.events.some((e:any)=>e.branch==="transport-recovered"));
  const encoded=JSON.stringify(reported);assert(!encoded.includes(token));for(const text of ["[REDACTED collector credential]","thr_synthetic","/native/bb","errorBody","ETIMEDOUT"])assert(encoded.includes(text),text);
 }finally{Date.now=clock;}
});
test("sustained transport failure stops within a bounded grace and retains its actual operation/error",async()=>{
 const clock=Date.now;let at=0,polls=0,reported:any;Date.now=()=>at;
 try{
  const result=await collectorMain(config,async()=>{throw Error("no recipe");},async()=>({transport:"cli",rpc:async(op:string,args:string[])=>{if(op==="collector-stopped"){reported=decode(args);return {accepted:true};}if(++polls===1)return {stop:false,task:null};at=polls===2?35000:71000;throw Object.assign(Error("fixture CLI deadline"),{timeoutMs:35000,exitCode:null});},abort(){},close(){}}) as never);
  assert.equal(polls,3);assert.equal(result.stop!.reason,"mailbox-grace-exhausted");assert.equal(result.stop!.operation,"collector-poll");assert.equal(result.stop!.failure,true);assert.match(JSON.stringify(result.stop!.error),/fixture CLI deadline/);assert.equal(reported.lastGoodAt,0);assert.equal(result.lastGoodAt,71000,"stop acknowledgement is a later successful mailbox response");
 }finally{Date.now=clock;}
});
test("authoritative refusal fails closed immediately without waiting transport grace",async()=>{
 let polls=0;const result=await collectorMain(config,async()=>{throw Error("no recipe");},async()=>({transport:"cli",rpc:async(op:string)=>{if(op==="collector-stopped")return {accepted:true};polls++;throw Object.assign(Error("Collector assignment mismatch"),{collectorRefused:true});},abort(){},close(){}}) as never);
 assert.equal(polls,1);assert.equal(result.stop!.reason,"mailbox-refused");assert.equal(result.stop!.failure,true);
});
test("lost result acknowledgement retries identical sealed bytes and never re-executes actual Bash",async()=>{
 const root=await mkdtemp(join(tmpdir(),"subscribe-ack-"));try{
  const recipe=recipeSchema.parse({script:`printf x >> '${root}/executions'; printf false >> "$SUB_OUTPUT"`,interpretation:"synthetic",coverage:"fixture",timeout_seconds:2,evaluation:{kind:"json_equals",path:[],value:true}});
  let runs=0,submits=0,committed:any;const payloads:string[]=[];
  const result=await collectorMain({...config,recipe},async(...args)=>{runs++;return runBash(...args);},async()=>({transport:"cli",rpc:async(op:string,args:string[])=>{
   if(op==="collector-stopped")return {accepted:true};
   if(op==="collector-result"){submits++;payloads.push(args.slice(1).join(""));committed=decode(args.slice(1));if(submits===1)throw Error("Response lost after native seal");return {accepted:true};}
   if(submits>=2)return {stop:true,reason:"subscription-fulfilled"};
   return {stop:false,task:submits?null:{id:"authoritative-task",sequence:1,generation:1,recipe,history:[]}};
  },abort(){},close(){}}) as never);
  assert.equal(runs,1);assert.equal(await readFile(join(root,"executions"),"utf8"),"x");assert.equal(submits,2);assert.equal(payloads[0],payloads[1]);assert.equal(committed.exit_code,0);assert.equal(committed.output,"false");assert(result.events.some(e=>e.branch==="sealed-result-ack-failed"));assert(result.events.some(e=>e.branch==="acknowledgement-recovered"));assert.equal(result.stop!.failure,false);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("failed Bash result is sealed while exceptional runner failure retains a separate stop cause",async()=>{
 for(const throws of [false,true]){
  let sealed:any;const recipe=recipeSchema.parse({script:'exit 7',interpretation:"synthetic",coverage:"fixture",timeout_seconds:1,evaluation:{kind:"json_equals",path:[],value:true}});
  const result=await collectorMain({...config,recipe},async(...args)=>{if(throws)throw Error("fixture runner threw before returning evidence");return runBash(...args);},async()=>({transport:"cli",rpc:async(op:string,args:string[])=>{if(op==="collector-stopped")return {accepted:true};if(op==="collector-result"){sealed=decode(args.slice(1));return {accepted:true};}return sealed?{stop:true,reason:"subscription-reviewing"}:{stop:false,task:{id:"failure-task",sequence:1,generation:1,recipe,history:[]}};},abort(){},close(){}}) as never);
  if(throws){assert.equal(result.stop!.reason,"recipe-threw");assert.equal(sealed,undefined);assert.match(JSON.stringify(result.stop!.error),/runner threw/);}else{assert.equal(sealed.exit_code,7);assert.match(sealed.problem,/collector exited 7/);assert.equal(result.stop!.failure,false);}
 }
});
test("expiry and process signal stop an outstanding poll with distinct truthful facts",async()=>{
 for(const signal of [false,true]){
  let rejectPoll:(e:Error)=>void=()=>{},aborts=0;const began=Date.now(),timer=signal?setTimeout(()=>process.emit("SIGTERM","SIGTERM"),40):undefined;
  const result=await collectorMain({...config,expires_at:signal?null:began+40},async()=>{throw Error("no task");},async()=>({transport:"cli",rpc:async(op:string)=>op==="collector-stopped"?{accepted:true}:new Promise((_r,reject)=>{rejectPoll=reject;}),abort(){aborts++;rejectPoll(Error("poll aborted"));},close(){}}) as never);
  if(timer)clearTimeout(timer);assert(Date.now()-began<1000);assert(aborts>0);assert.equal(result.stop!.reason,signal?"signal":"deadline-expired");assert.equal(result.stop!.signal,signal?"SIGTERM":undefined);assert.equal(result.stop!.failure,false);
 }
});
test("server retains authenticated stop status across replacement and never converts missing collection into target evidence",async()=>{
 const db=new Sqlite(":memory:"),store=new Store(db as unknown as Database),engine=new Engine(store,{now:()=>1000} as never);
 try{
  const id=engine.create("owner","project",null,"until",{subject:"synthetic",notify_when:"ready",required_evidence:"actual",timeout_minutes:1}).subscription_id;
  const r=store.get(id);r.observer="observer";r.generation=1;r.state="running";r.recipe=recipeSchema.parse({script:'printf false >> "$SUB_OUTPUT"',interpretation:"synthetic",coverage:"fixture",evaluation:{kind:"json_equals",path:[],value:true}});store.save(r);
  const collectors=new Collectors(store,()=>1000),authority={environment:"env",host:"host",observer:"observer",permission_mode:"auto"};collectors.install(r,authority);const current=store.get(id);
  const status={version:1,worker:"worker",generation:1,sequence:0,taskId:null,transport:"cli",phase:"stopped",startedAt:0,at:1000,lastGoodAt:0,policy:collectorPolicy,events:[{at:1000,operation:"collector-poll",branch:"mailbox-poll-failed",error:{message:current.collector!.token,threadId:"thr_kept"}}],stop:{reason:"mailbox-grace-exhausted",operation:"collector-poll",failure:true}};
  collectors.stopped(id,"observer",current.collector!.token,"worker",status);assert(!JSON.stringify(publicRecord(store.get(id),true)).includes(current.collector!.token));assert.throws(()=>collectors.stopped(id,"observer",current.collector!.token,"other",status),/assignment mismatch/);
  const failed=await collectors.run(store.get(id),new AbortController().signal);assert.equal(failed.output,"");assert.equal(failed.exit_code,null);assert.match(failed.problem!,/mailbox-grace-exhausted/);assert.match(failed.stderr,/thr_kept/);
  const next=store.get(id);next.generation++;collectors.install(next,authority);assert.equal(store.get(id).collector_reports![0]!.stop!.reason,"mailbox-grace-exhausted");assert.throws(()=>collectors.poll(id,"observer",current.collector!.token,"worker"),/mismatch/);
 }finally{store.dispose();db.close();}
});

test("error serialization preserves repeated nonsecret fields and reports cycles without exposing a known credential",()=>{
 const shared={threadId:"thr_visible",settings:{path:"/native/path"}},error=Object.assign(Error("actual error "+token),{code:"NATIVE_FAILED",left:shared,right:shared,body:"完整 context "+"x".repeat(8000)}) as any;error.cause=error;
 const value=collectorDiagnostic(error,token);assert.equal(value.left.threadId,"thr_visible");assert.deepEqual(value.left,value.right);assert.equal(value.cause,"[circular]");assert.equal(value.code,"NATIVE_FAILED");assert.equal(value.body,error.body);assert(!JSON.stringify(value).includes(token));
});

test("oversized thrown strings and unreadable Error properties redact only the actual credential in every retained fallback",async()=>{
 const thrown=token+"界".repeat(12000)+" visible-path:/native/bb";let reported:any;
 const clock=Date.now;let at=0,polls=0;Date.now=()=>at;let result;
 try{result=await collectorMain(config,async()=>{throw Error("no recipe");},async()=>({transport:"cli",rpc:async(op:string,args:string[])=>{if(op==="collector-stopped"){reported=decode(args);return {accepted:true};}if(++polls===1)return {stop:false,task:null};at=70000;throw thrown;},abort(){},close(){}}) as never);}finally{Date.now=clock;}
 // Initialization can also throw a primitive rather than an Error.
 const primitive=await collectorMain(config,async()=>{throw Error("no recipe");},async()=>{throw thrown;});
 for(const status of [reported,result,primitive]){const encoded=JSON.stringify(status);assert(!encoded.includes(token));assert(encoded.includes("[REDACTED collector credential]"));assert(Buffer.byteLength(encoded)<=60000);assert(encoded.includes("detailsOmitted"));}
 const error=Error("context");Object.defineProperty(error,"settings",{get(){throw Error("unreadable "+token+" path:/native/config");}});
 const diagnostic=collectorDiagnostic(error,token);assert(!JSON.stringify(diagnostic).includes(token));assert.match(JSON.stringify(diagnostic.settings),/native\/config/);assert.match(JSON.stringify(diagnostic.settings),/REDACTED collector credential/);
});
