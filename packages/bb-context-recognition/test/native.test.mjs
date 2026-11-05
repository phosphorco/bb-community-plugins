import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeCandidates, LIMITS} from '@phosphorco/bb-context-recognition';
const input=text=>({version:1,text,format:'markdown',excluded:[],context:{consumer:{pluginId:'test'},threadId:'thr_source',links:[]}});
test('emitted pure native helper recognizes thread aliases, framed files and safe URLs with UTF-16 spans',()=>{
 const text='😀 @thread:thr_23456789ab then thr_23456789ab plans/x.plan.pkl https://example.test/a';
 const result=nativeCandidates(input(text));
 const threads=result.filter(c=>c.source.provider==='bb.thread');assert.equal(threads.length,2);assert.equal(threads[0].span.start,3);
 for(const c of result)assert.equal(text.slice(c.span.start,c.span.end),c.match);
 assert.equal(result.find(c=>c.source.provider==='bb.file'&&c.match==='plans/x.plan.pkl').source.id,'thr_source:plans/x.plan.pkl');
 assert.equal(result.find(c=>c.source.provider==='bb.url').source.id,'https://example.test/a');
 assert.equal(nativeCandidates({...input(text),excluded:[{start:0,end:text.length}]}).length,0);
 assert.equal(nativeCandidates(input('prefixthr_23456789ab \\@thread:thr_23456789ab')).filter(c=>c.source.provider==='bb.thread').length,0);
 assert.throws(()=>nativeCandidates(input('x'.repeat(LIMITS.textChars+1))));
});
