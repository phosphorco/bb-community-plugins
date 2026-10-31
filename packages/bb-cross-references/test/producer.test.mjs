import assert from 'node:assert/strict';
import test from 'node:test';
import * as c from '../dist/index.js';
const classify=c.classifyBriefDisplayTextV1;
test('display policy accepts exact ordinary and URL-like safe metadata without resource recognition',()=>{
 for(const value of ['Goal','Research & Development','100% done','', '😀 界 e\u0301','https://example.test/path?q=public','/projects/P/threads/T','See https://example.test/path.','name=public'])assert.equal(classify(value).state,'safe',value);
});
test('display policy closes raw, encoded and concatenated credential URL carriers',()=>{
 const cases=['https://user:pass@example.test/a','https://example.test/?token=secret','/path#secret=x','token=secret','prefixhttps://example.test/?token=secret',
  'https%3A%2F%2Fexample.test%2F%3Ftoken%3Dsecret','https\\u003a\\u002f\\u002fexample.test/?token=secret','https&colon;&sol;&sol;example.test/?token=secret','https://example.test/?%74oken=secret',
  'https://safe.test/ahttps://example.test/?token=secret','`https://example.test/?token=secret`'];
 for(const value of cases)assert.notEqual(classify(value).state,'safe',value);
 for(const value of ['broken\\uD800','broken\udfff','x\u0000y','https%3Zexample','&#xD800;','&unsupported;','%25'.repeat(30)+'41'])assert.notEqual(classify(value).state,'safe',value);
});
test('policy budgets never certify an unchecked tail, and final values memoize across roles',()=>{
 const many=Array.from({length:129},(_,i)=>`https://example.test/${i}`).join(' ')+' https://example.test/?token=secret';assert.notEqual(classify(many).state,'safe');
 const over='x'.repeat(c.DISPLAY_POLICY_LIMITS.valueChars+1);assert.equal(classify(over).state,'unclassified');
 const fields=[{key:[1],role:'heading',value:'Goal'},{key:[0],role:'required-identity',value:'Goal'},{key:[2],role:'target-label',value:'Goal'}];const out=c.classifyBriefDisplayFieldsV1(fields);assert.equal(out.state,'classified');assert.equal(out.usage.distinctValues,1);assert.equal(out.results.length,3);assert.deepEqual(out.results.map(r=>r.key),[[1],[0],[2]]);assert.ok(out.results.every(r=>r.result.state==='safe'));
 assert.equal(c.classifyBriefDisplayFieldsV1(Array.from({length:8193},()=>fields[0])).state,'unclassified');
});
test('B variants distinguish null intro, exact empty name and role-separated withheld commitments',()=>{
 assert.equal(c.briefHeadingSchema.parse(null),null);assert.deepEqual(c.briefHeadingSchema.parse({state:'named',text:''}),{state:'named',text:''});
 const original='https://example.test/?token=secret',digest=c.briefWithheldDigest('heading',original);assert.equal(digest,c.sha256Hex(canonical(['brief-withheld',1,'heading',original])));assert.notEqual(digest,c.briefWithheldDigest('target-label',original));
 const value={state:'withheld',digest,display:'Heading withheld',cause:'policy'};assert.deepEqual(c.briefHeadingSchema.parse(value),value);assert.throws(()=>c.briefHeadingSchema.parse({...value,text:original}));assert.throws(()=>c.briefHeadingSchema.parse({...value,display:original}));assert.throws(()=>c.briefHeadingSchema.parse({state:'named',text:'界'.repeat(86)}));
 assert.equal(c.briefHeadingOutputSchema.parse({...value,future:1}).future,1);
});
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
test('strict status content digest excludes CAS/attempt, preserves exact source and rejects unknown fields',()=>{
 const sourceFile={kind:'thread-storage',threadId:'thr_fixture',path:'BRIEF.md'},source=c.verifiedFileIdentity(sourceFile),status={state:'over-limit',sourceContentRevision:c.sha256Hex('raw'),limits:['target-count']};
 const statusDigest=c.briefStatusDigest('thread-brief',source,sourceFile,status),input={version:1,producerPluginId:'thread-brief',source,sourceFile,status,statusDigest,attemptRevision:10,expectedRevision:8};
 assert.doesNotThrow(()=>c.producerReportStatusInputSchema.parse(input));assert.doesNotThrow(()=>c.producerReportStatusInputSchema.parse({...input,attemptRevision:12,expectedRevision:9}));assert.throws(()=>c.producerReportStatusInputSchema.parse({...input,extra:1}));assert.throws(()=>c.producerReportStatusInputSchema.parse({...input,status:{...status,error:'raw'}}));assert.throws(()=>c.producerReportStatusInputSchema.parse({...input,statusDigest:'0'.repeat(64)}));
});
test('public fresh navigation proof tolerates additive output but pins full file/frame/revision/line',()=>{
 const raw=c.sha256Hex('raw'),frame={codec:'utf8-fatal-bom-consumed-v1',rawBytes:10,bomBytes:0,fileUtf16Length:10,bodyBase:{startUtf16:0,startLine:1,utf16Length:10},lineMapping:{codec:'native-file-lines-v1',fileLineCount:2}},sourceFile={kind:'thread-storage',threadId:'thr_fixture',path:'BRIEF.md'};
 const input={version:1,sourceFile,sourceContentRevision:raw,frame,section:{heading:{state:'named',text:'Goal'},originalLine:1}},out={version:1,state:'ready',sourceFile:{...sourceFile,future:1},sourceContentRevision:raw,location:{kind:'line',line:1,column:null,future:1},proof:{kind:'accepted-revision-revalidated',acceptedRevision:raw,selection:'same-revision',frame:{...frame,future:1}},future:1};
 assert.equal(c.validateBriefNavigationResultV1(input,out).state,'ready');for(const changed of [{...out,sourceFile:{...sourceFile,threadId:'thr_other'}},{...out,sourceContentRevision:c.sha256Hex('new')},{...out,location:{kind:'line',line:2,column:null}}])assert.throws(()=>c.validateBriefNavigationResultV1(input,changed));
});

test('preflight exposes the TEN actual size hit codes, without exception-text parsing',()=>{
 const target={provider:'test',keys:{id:'target'},presentation:{label:'Target'}},source={provider:'test',keys:{id:'source'},presentation:{label:'Brief'}},presentation={label:{state:'safe',text:'Target'},detail:null,url:{state:'absent'}};
 const base={version:1,projection:{source,targets:[target],producerPluginId:'thread-brief',protocolVersion:1,tombstone:false},evidence:{sourcePresentation:{...presentation,label:{state:'safe',text:'Brief'}},targetDescriptors:[{target:{provider:target.provider,keys:target.keys},presentation}],occurrences:[{target:{provider:target.provider,keys:target.keys},locator:{section:{heading:{state:'named',text:'Goal'}}}}]}};
 const code=(change,wanted)=>{const value=structuredClone(base);change(value);assert.ok(c.briefApplyLimitCodes(value).includes(wanted),wanted);};
 code(v=>v.projection.targets=Array.from({length:257},()=>target),'target-count');
 code(v=>v.evidence.occurrences=Array.from({length:513},()=>v.evidence.occurrences[0]),'occurrence-count');
 code(v=>v.evidence.occurrences=Array.from({length:101},()=>v.evidence.occurrences[0]),'per-target-occurrences');
 code(v=>v.evidence.occurrences[0].locator.section.heading.text='界'.repeat(86),'heading-bytes');
 code(v=>v.projection.source.presentation.label='a'.repeat(257),'presentation-label-bytes');
 code(v=>v.projection.source.presentation.detail='a'.repeat(1025),'presentation-detail-bytes');
 code(v=>v.projection.source.presentation.url='/'+'a'.repeat(2049),'presentation-url-bytes');
 code(v=>v.projection.source.presentation={label:'"'.repeat(256),detail:'"'.repeat(1024),url:'/'+'a'.repeat(2047)},'presentation-bytes');
 code(v=>v.projection.targets=Array.from({length:256},(_,i)=>({...target,keys:{id:String(i),padding:'a'.repeat(1100)}})),'projection-bytes');
 code(v=>v.evidence.occurrences[0].padding='a'.repeat(1048576),'envelope-bytes');
 assert.deepEqual(new Set(c.BRIEF_LIMIT_CODES),new Set(['target-count','projection-bytes','occurrence-count','per-target-occurrences','heading-bytes','envelope-bytes','presentation-label-bytes','presentation-detail-bytes','presentation-url-bytes','presentation-bytes']));
});

test('closed named decoder: partial known names/prefixes and inherited names never certify SAFE',()=>{
 for(const value of ['&colon','&col','&amp','&am','&NewLin','before &colon after','&constructor;','&__proto__;','&toString;','&hasOwnProperty;','&valueOf;','&__defineGetter__;','https&colon//example.test/?token=secret','&amp;colon']){
  const result=classify(value);assert.notEqual(result.state,'safe',value);if(!value.includes('secret'))assert.equal(result.state==='unclassified'?result.reason:null,'encoding-ambiguity',value);
 }
 for(const value of ['Research & Development','100% done','plain & text','https://example.test/?q=one&count=3','Goal &amp; plan','safe&colon;value'])assert.equal(classify(value).state,'safe',value);
 const original='Research & Development';assert.equal(c.briefWithheldDigest('heading',original),c.sha256Hex(canonical(['brief-withheld',1,'heading',original])));
});
