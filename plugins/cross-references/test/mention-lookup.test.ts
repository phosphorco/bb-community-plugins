import assert from 'node:assert/strict';
import test from 'node:test';
import {createMentionLookup} from '../mention-lookup.ts';
import {githubLookup} from '@phosphorco/bb-cross-references';
function lookup(extra:Record<string,unknown>={}){return createMentionLookup({snapshot:()=>({clients:[],incomplete:false,signal:new AbortController().signal}),getThread:async id=>({id,projectId:'proj_actual'}),appUrl:'https://bb.test',...extra});}
test('pasted PR root/comment/review coalesces by documented codec without supplier/card/source access',async()=>{
 const read=lookup(),root=githubLookup('https://github.com/Owner/Repo/pull/42')!;
 for(const href of ['https://github.com/Owner/Repo/pull/42#issuecomment-123','https://github.com/owner/repo/pull/42/files#discussion_r321','https://github.com/owner/repo/pull/42#pullrequestreview-456']){
  const out=await read({version:2,mode:'recognize',text:href});assert.equal(out.state,'ready');assert.deepEqual(out.options[0]!.query,root.query);assert.equal(out.options[0]!.basis,'stored-codec');
  const exact=await read({version:2,mode:'exact-url',text:href});assert.deepEqual(exact.options[0]!.query,{kind:'authored-url',href});
 }
 const issue=await read({version:2,mode:'recognize',text:'https://github.com/owner/repo/issues/42'});assert.equal((issue.options[0]!.query as any).relation,'self');
 assert.equal((await read({version:2,mode:'recognize',text:'owner/repo#42'})).options.length,0,'no bespoke prose PR regex');
});
test('native route project contradiction does not become another project; exact URL mode stays literal',async()=>{
 const read=lookup();
 const wrong=await read({version:2,mode:'recognize',text:'/projects/proj_wrong/threads/thr_23456789ab'});assert.equal(wrong.options.length,0);
 const valid=await read({version:2,mode:'recognize',text:'/projects/proj_actual/threads/thr_23456789ab'});assert.equal(valid.options.length,1);
 const absolute=await read({version:2,mode:'recognize',text:'https://bb.test/projects/proj_wrong/threads/thr_23456789ab'});assert.ok(absolute.options.every(r=>r.query.kind!=='resource'||r.query.target.provider!=='bb'));
 await assert.rejects(read({version:2,mode:'exact-url',text:'/projects/P/threads/T?token=secret'}));
});
test('native noncooperative verification is bounded and inactive snapshot cannot do work',async()=>{
 const read=lookup({getThread:()=>new Promise(()=>{})});const out=await read({version:2,mode:'recognize',text:'@thread:thr_23456789ab'});assert.equal(out.state,'incomplete');assert.equal(out.options.length,0);
 const controller=new AbortController();controller.abort();let calls=0;
 const stopped=lookup({snapshot:()=>({clients:[],incomplete:true,signal:controller.signal}),getThread:()=>{calls++;throw new Error('disposed');}});
 assert.equal((await stopped({version:2,mode:'recognize',text:'@thread:thr_23456789ab'})).options.length,0);assert.equal(calls,0);
});

test('a native metadata result delivered after the shared deadline has no option capability',async()=>{
 let at=0;const read=lookup({now:()=>at,getThread:async(id:string)=>{at=1600;return {id,projectId:'proj_actual'};}});
 const out=await read({version:2,mode:'recognize',text:'@thread:thr_23456789ab'});assert.equal(out.state,'incomplete');assert.equal(out.options.length,0);assert.ok(out.reasons.includes('lookup-budget'));
});
