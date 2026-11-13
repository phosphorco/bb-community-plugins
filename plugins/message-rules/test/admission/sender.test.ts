import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { decideSenderMessage } from "../../admission/sender.ts";
import { newGroup, newRule } from "../../contracts/model.ts";
const group={...newGroup("sender"),enabled:true,match:{kind:"all" as const,children:[]}};
const rule={...newRule("reject-status","sender"),enabled:true,title:"Give the result",advice:"Send a completed result or a blocker.",match:{kind:"condition" as const,field:"message" as const,operator:"contains" as const,value:"still working",insensitive:true}};
const context=(text:string)=>makeMessageDispatchHookContext({input:{text,blocks:[]},initiator:"agent",senderThreadId:"thr_sender"});
test("static rejection returns actionable advice to the sender",()=>{
  assert.deepEqual(decideSenderMessage(context("Still working on it"),{groups:[group],rules:[rule]}),{action:"reject",message:"Give the result: Send a completed result or a blocker."});
});
test("nonmatches and disabled groups proceed",()=>{
  assert.deepEqual(decideSenderMessage(context("Completed the deployment"),{groups:[group],rules:[rule]}),{action:"proceed"});
  assert.deepEqual(decideSenderMessage(context("Still working"),{groups:[{...group,enabled:false}],rules:[rule]}),{action:"proceed"});
});
test("matching paid checks are refused clearly without transport work",()=>{
  const result=decideSenderMessage(context("Still working"),{groups:[group],rules:[{...rule,check:"jev"}]});
  assert.equal(result.action,"reject");if(result.action==="reject")assert.match(result.message,/cannot run the paid JEV check/);
});
test("delivery changes are refused rather than silently converted to acceptance",()=>{
  const result=decideSenderMessage(context("Still working"),{groups:[group],rules:[{...rule,action:"queue"}]});
  assert.equal(result.action,"reject");if(result.action==="reject")assert.match(result.message,/requests queue/);
});
test("unavailable sender-title predicates cannot produce false acceptance",()=>{
  const result=decideSenderMessage(context("Still working"),{groups:[group],rules:[{...rule,match:{...rule.match,field:"sender_title"}}]});
  assert.equal(result.action,"reject");if(result.action==="reject")assert.match(result.message,/required sender metadata is unavailable/);
});
test("same static input has identical outcome across retries and a fresh generation",()=>{
  const policy=JSON.parse(JSON.stringify({groups:[group],rules:[rule]}));
  const first=decideSenderMessage(context("Still working"),policy);
  for(let i=0;i<10;i++)assert.deepEqual(decideSenderMessage(context("Still working"),JSON.parse(JSON.stringify(policy))),first);
});
