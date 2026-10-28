import assert from 'node:assert/strict';
import test from 'node:test';
import {createExcerptExtractor,persistedExcerpt} from '../mention-excerpts.ts';
import {mentionFrame} from '../mention-markdown.ts';
for(const excluded of ['`private code`','<b>private HTML</b>','![private image](https://image.test/a)','[![private image](https://image.test/a)](https://image.test/b)','\n\n```\nprivate fence\n```\n\n','\n\n    private indented\n\n']){
 test(`original contiguous excerpt cannot bridge ${excluded.slice(0,20)}`,()=>{
  const body=`Before @thread:thr_1234567890 ${excluded} after @thread:thr_abcdefghij.`,frame=mentionFrame(body),extract=createExcerptExtractor(body,frame.forbidden);
  for(const needle of ['@thread:thr_1234567890','@thread:thr_abcdefghij']){const start=body.indexOf(needle),out=extract({start,end:start+needle.length});
   assert.equal(out.state,'ready');if(out.state!=='ready')return;
   assert.equal(out.text,body.slice(out.sourceSpan.start,out.sourceSpan.end));
   assert.ok(!frame.forbidden.some(h=>h.start<out.sourceSpan.end&&out.sourceSpan.start<h.end));
   assert.equal(out.text.slice(out.matchSpan.start,out.matchSpan.end),needle);
  }
 });
}
test('ordinary/reference link context remains eligible and source spelling is separately proved',()=>{
 for(const body of ['See [the PR](https://github.com/owner/repo/pull/42).','See [the PR][pr].\n\n[pr]: https://github.com/owner/repo/pull/42']){
  const frame=mentionFrame(body),link=frame.links[0]!;assert.equal(link.authoredHref,'https://github.com/owner/repo/pull/42');
  const ex=createExcerptExtractor(body,frame.forbidden)(link.span);assert.equal(ex.state,'ready');
  if(ex.state==='ready')assert.equal(ex.text,body.slice(ex.sourceSpan.start,ex.sourceSpan.end));
 }
 const altered=mentionFrame('[x](https://example.test/a&amp;b)');assert.equal(altered.links[0]!.authoredHref,undefined,'parser decoding cannot prove original spelling');
});
test('mixed Unicode caps and full-span preservation for overlong words/multiword mentions',()=>{
 const body=('🙂界e\u0301 ').repeat(150)+' target '+('界🙂 ').repeat(150),start=body.indexOf('target');
 const ex=createExcerptExtractor(body,[] )({start,end:start+6});assert.equal(ex.state,'ready');
 if(ex.state==='ready'){assert.ok([...ex.text].length<=320);assert.ok(Buffer.byteLength(ex.text)<=1280);assert.equal(ex.text,body.slice(ex.sourceSpan.start,ex.sourceSpan.end));assert.equal(ex.text.slice(ex.matchSpan.start,ex.matchSpan.end),'target');assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(ex.text));}
 const long='x'.repeat(321);assert.deepEqual(createExcerptExtractor(long,[])({start:0,end:long.length}),{state:'unavailable',reason:'indivisible-word',codecVersion:1});
 const multi=('word ').repeat(200);const clipped=createExcerptExtractor(multi,[])({start:0,end:multi.length});assert.equal(clipped.state,'ready');if(clipped.state==='ready')assert.equal(clipped.matchClippedAfter,true);
});
test('persisted reader rejects malformed numeric/codec/body binding without fetching source',()=>{
 const row={span_start:0,span_end:6,excerpt_state:'ready',excerpt_content_revision:'a'.repeat(64),codec_version:1,excerpt_text:'target',excerpt_source_start:0,excerpt_source_end:6,match_start:0,match_end:6,clipped_before:0,clipped_after:0,match_clipped_before:0,match_clipped_after:0,unavailable_reason:null};
 for(const key of ['excerpt_source_start','excerpt_source_end','match_start','match_end'])for(const value of [null,0.5,-1])assert.throws(()=>persistedExcerpt({...row,[key]:value},row.excerpt_content_revision));
 assert.throws(()=>persistedExcerpt({...row,codec_version:2},row.excerpt_content_revision));assert.throws(()=>persistedExcerpt(row,'b'.repeat(64)));
 assert.equal(persistedExcerpt(row,row.excerpt_content_revision).state,'ready');
});

test('unsafe destination holes keep useful original context on both sides without exposing syntax or labels',()=>{
 const thread='thr_23456789ab',needle=`@thread:${thread}`;
 const unsafe=[
  '[PRIVATE_LABEL](https://example.test/?token=secret)',
  '[PRIVATE_LABEL](https://example.test/#api_key=secret)',
  '[PRIVATE_LABEL](https://user:secret@example.test/a)',
  '<https://user:secret@example.test/a>',
  'https://example.test/?token=secret',
  'https://example.test/#token=secret',
  `/projects/proj_a/threads/${thread}?token=secret`,
  `/projects/proj_a/threads/${thread}#token=secret`,
  '/other-route?token=secret',
  '/other-route#token=secret',
  '[PRIVATE_LABEL](javascript:alert)',
 ];
 for(const hole of unsafe){
  const body=`Useful before ${needle} ${hole} useful after ${needle}.`,frame=mentionFrame(body),extract=createExcerptExtractor(body,frame.forbidden);
  for(const start of [body.indexOf(needle),body.lastIndexOf(needle)]){
   const out=extract({start,end:start+needle.length});assert.equal(out.state,'ready',hole);if(out.state!=='ready')continue;
   assert.equal(out.text,body.slice(out.sourceSpan.start,out.sourceSpan.end));assert.ok(out.text.includes('Useful before')||out.text.includes('useful after'));
   assert.ok(!out.text.includes('token=secret')&&!out.text.includes('api_key=secret')&&!out.text.includes('user:secret')&&!out.text.includes('PRIVATE_LABEL')&&!out.text.includes('javascript:'));
   assert.ok(!frame.forbidden.some(h=>h.start<out.sourceSpan.end&&out.sourceSpan.start<h.end));
  }
  const at=body.indexOf(hole);assert.deepEqual(extract({start:at,end:at+hole.length}),{state:'unavailable',reason:'no-eligible-context',codecVersion:1});
 }
 const reference=`Useful ${needle} [PRIVATE_LABEL][secret] after ${needle}.\n\n[secret]: https://example.test/?token=secret`;
 const frame=mentionFrame(reference),ex=createExcerptExtractor(reference,frame.forbidden)({start:reference.indexOf(needle),end:reference.indexOf(needle)+needle.length});
 assert.equal(ex.state,'ready');assert.ok(!JSON.stringify(ex).includes('PRIVATE_LABEL'));
});

test('privacy classification covers native candidate batches and oversized original runs, while safe controls stay eligible',()=>{
 const thread='thr_23456789ab',needle=`@thread:${thread}`;
 for(const run of [`${`${thread},`.repeat(65)}/projects/proj_a/threads/${thread}?token=secret`,`/projects/${'x'.repeat(4100)}/threads/${thread}?token=secret`]){
  const body=`🙂界 useful ${needle} ${run} after useful ${needle}.`,frame=mentionFrame(body),extract=createExcerptExtractor(body,frame.forbidden);
  for(const start of [body.indexOf(needle),body.lastIndexOf(needle)]){
   const out=extract({start,end:start+needle.length});assert.equal(out.state,'ready');if(out.state==='ready'){assert.ok(!out.text.includes('token=secret'));assert.equal(out.text,body.slice(out.sourceSpan.start,out.sourceSpan.end));}
  }
 }
 for(const link of ['[SAFE_LABEL](https://example.test/?page=2)','[SAFE_LABEL](README.md)','[SAFE_LABEL][safe]']){
  const body=`界🙂 Useful ${needle} ${link} safe context.\n\n[safe]: https://example.test/a`,frame=mentionFrame(body),out=createExcerptExtractor(body,frame.forbidden)({start:body.indexOf(needle),end:body.indexOf(needle)+needle.length});
  assert.equal(out.state,'ready');if(out.state==='ready')assert.ok(out.text.includes('SAFE_LABEL'));
 }
});

test('longest eligible word-bound excerpt fills safe context rather than keeping a fixed short prefix',()=>{
 const body=('word ').repeat(50)+'target end.',start=body.indexOf('target');
 const out=createExcerptExtractor(body,[])({start,end:start+6});assert.equal(out.state,'ready');
 if(out.state==='ready'){assert.equal(out.text,body);assert.equal(out.clippedBefore,false);assert.equal(out.clippedAfter,false);}
 const match=Array(55).fill('word').join(' '),surrounded=('lead ').repeat(30)+match+(' tail').repeat(30),at=surrounded.indexOf(match);
 const whole=createExcerptExtractor(surrounded,[])({start:at,end:at+match.length});assert.equal(whole.state,'ready');
 if(whole.state==='ready'){assert.equal(whole.text.slice(whole.matchSpan.start,whole.matchSpan.end),match);assert.equal(whole.matchClippedBefore,false);assert.equal(whole.matchClippedAfter,false);assert.ok([...whole.text].length<=320);}
});

test('safe outer links cannot expose policy-unsafe URLs through decoded labels or titles',()=>{
 const needle='@thread:thr_23456789ab',safe='https://example.test/safe';
 const links=[
  `[https://example.test/?token=secret](${safe})`,
  `[*https://user:secret@example.test/a*](${safe})`,
  `[https://example.test/?%74oken=secret](${safe})`,
  `[https://example.test/?page=1&amp;token=secret](${safe})`,
  `[/other-route?token=secret](${safe})`,
  '[/other-route#token=secret][safe]',
  `[label](${safe} "See https://example.test/#api_key=secret")`,
  `[label](${safe} "https://user:secret@example.test/a")`,
  `[label](${safe} "https://example.test/?%74oken=secret")`,
  '[label][safe]',
 ];
 for(const link of links){
  const body=`Useful ${needle} ${link} after useful ${needle}.\n\n[safe]: ${safe} "https://example.test/?token=secret"`,frame=mentionFrame(body),extract=createExcerptExtractor(body,frame.forbidden),outer=frame.links.find(l=>l.href===safe)!;
  assert.ok(outer);assert.equal(extract(outer.span).state,'unavailable');
  for(const start of [body.indexOf(needle),body.lastIndexOf(needle)]){
   const ex=extract({start,end:start+needle.length});assert.equal(ex.state,'ready');
   if(ex.state==='ready'){assert.equal(ex.text,body.slice(ex.sourceSpan.start,ex.sourceSpan.end));assert.ok(ex.text.includes('Useful')||ex.text.includes('useful'));assert.ok(!ex.text.includes('secret'));}
  }
 }
 const body=`Useful ${needle} [ordinary SAFE_LABEL](${safe} "ordinary SAFE_TITLE https://example.test/page") after.`,frame=mentionFrame(body),ex=createExcerptExtractor(body,frame.forbidden)({start:body.indexOf(needle),end:body.indexOf(needle)+needle.length});
 assert.equal(ex.state,'ready');if(ex.state==='ready'){assert.ok(ex.text.includes('SAFE_LABEL'));assert.ok(ex.text.includes('SAFE_TITLE'));}
 const root=mentionFrame(`[/other-route?page=2](${safe} "ordinary safe title")`);assert.equal(root.links[0]!.label,'/other-route?page=2');assert.deepEqual(root.forbidden,[]);
});
