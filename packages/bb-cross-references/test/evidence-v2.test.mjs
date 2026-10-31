import assert from 'node:assert/strict';
import test from 'node:test';
import {listMentionsInputV2Schema,listMentionsOutputV2Schema,resolveLookupInputV2Schema,resolveLookupOutputV2Schema,threadResource,sha256Hex} from '../dist/index.js';
const resource=threadResource('proj_test','thr_test',{label:'Example'}),target={provider:resource.provider,keys:resource.keys},hash=sha256Hex('fixture');
const coverage={scope:'known-sources',collectionIncomplete:false,retentionLimited:false,capHistoryUnknown:false,legacyClaimsPresent:false,evidenceStateUnknown:false,authoredUrlCoverage:{state:'complete-for-known-locations',unknownLocations:0,scope:'known-locations',watermark:hash},reasons:[],reasonsClipped:false,checkedAt:null};
const item={source:resource,target:resource,producerPluginId:'fixture',graphRevision:1,cap:{state:'unknown',limit:null,sourceHistoryUnknown:null},kind:'claim-without-evidence',reason:'producer-no-evidence',matchBasis:'primary-resource'};
const page={version:2,status:'page',snapshot:hash,items:[item],counts:{retainedOccurrences:0,confirmedOccurrences:0,unconfirmedOccurrences:0,producerClaims:1,indexedSources:1,claimsWithoutLocations:1,excerptUnavailable:0},coverage,nextCursor:null};
test('V2 strict inputs, recursively additive bounded outputs and future item slot fallback',()=>{
 const input={version:2,query:{kind:'resource',relation:'self',target}};assert.doesNotThrow(()=>listMentionsInputV2Schema.parse(input));
 for(const changed of [{...input,extra:true},{...input,query:{...input.query,extra:1}},{...input,query:{...input.query,target:{...target,presentation:{label:'x'}}}},{...input,cursor:'x',ifSnapshot:hash}])assert.throws(()=>listMentionsInputV2Schema.parse(changed));
 assert.doesNotThrow(()=>listMentionsOutputV2Schema.parse({...page,extra:1,counts:{...page.counts,extra:1},coverage:{...coverage,extra:1,authoredUrlCoverage:{...coverage.authoredUrlCoverage,extra:1}},items:[{...item,extra:1,source:{...resource,extra:1,presentation:{...resource.presentation,extra:1}},cap:{...item.cap,extra:1}}]}));
 const future=listMentionsOutputV2Schema.parse({...page,items:[{...item,kind:'future'}]});assert.equal(future.items.length,1);assert.equal(future.items[0].kind,'unsupported');
 assert.throws(()=>listMentionsOutputV2Schema.parse({...page,items:[{...item,source:undefined}]}));
 assert.throws(()=>listMentionsOutputV2Schema.parse({...page,coverage:{...coverage,reasons:['界'.repeat(128)]}}));
 assert.doesNotThrow(()=>listMentionsOutputV2Schema.parse({version:2,status:'not-modified',snapshot:hash,coverage}));
 assert.throws(()=>listMentionsOutputV2Schema.parse({version:2,status:'not-modified',snapshot:hash}));
});
test('lookup context is strict and attribution-free; options tolerate nested additive query fields',()=>{
 assert.throws(()=>resolveLookupInputV2Schema.parse({version:2,mode:'recognize',text:'x',context:{consumer:{pluginId:'caller'}}}));
 assert.throws(()=>resolveLookupInputV2Schema.parse({version:2,mode:'exact-url',text:'x',context:{links:[{href:'https://example.test/?token=secret'}]}}));
 assert.doesNotThrow(()=>resolveLookupOutputV2Schema.parse({version:2,state:'ready',options:[{query:{kind:'resource',target:{...target,extra:1},relation:'self',extra:1},label:'x',inputSpan:{start:0,end:1,extra:1},basis:'native',reasons:[],extra:1}],reasons:[],extra:1}));
});

test('Brief V2 additive known variants retain exact locations, future variants remain visible unsupported slots',async()=>{
 const {briefFrameOutputSchema}=await import('../dist/index.js');const file={kind:'thread-storage',threadId:'thr_brief',path:'BRIEF.md'},frame={codec:'utf8-fatal-bom-consumed-v1',rawBytes:20,bomBytes:0,fileUtf16Length:20,bodyBase:{startUtf16:0,startLine:1,utf16Length:20},lineMapping:{codec:'native-file-lines-v1',fileLineCount:3}};
 const brief={...item,kind:'brief-occurrence',producerPluginId:'thread-brief',evidenceRevision:8,occurrenceKey:hash,sourceOccurrenceId:'ref-2',locator:{kind:'thread-brief',threadId:file.threadId,file:{...file,extra:1},sourceContentRevision:hash,section:{heading:{state:'named',text:'Goal',extra:1},line:1,extra:1},location:{kind:'line',line:2,column:null,endLine:null,extra:1},extra:1},sourceContentRevision:hash,frame:{...frame,bodyBase:{...frame.bodyBase,extra:1},extra:1},excerpt:{state:'unavailable',reason:'not-materialized',codecVersion:1,extra:1},provenance:{state:'withheld',digest:hash,display:'Recognition details withheld',cause:'policy',summary:{pluginId:'thread-brief',origin:'builtin',confidence:'high',basis:'explicit',extra:1},extra:1},authoredUrl:{state:'withheld',digest:hash,display:'Destination withheld',cause:'policy',extra:1},authoredUrlState:'withheld',confirmation:'producer-attested'};
 const parsed=listMentionsOutputV2Schema.parse({...page,items:[brief]});assert.equal(parsed.items[0].kind,'brief-occurrence');assert.equal(parsed.items[0].locator.section.heading.text,'Goal');assert.equal('messageSeq' in parsed.items[0].locator,false);
 const future=listMentionsOutputV2Schema.parse({...page,items:[{...brief,confirmation:'future-confirmation'}]});assert.equal(future.items.length,1);assert.equal(future.items[0].kind,'unsupported');
 assert.throws(()=>listMentionsOutputV2Schema.parse({...page,items:[{...brief,locator:{...brief.locator,location:{kind:'line',line:null,column:null,endLine:null}}}]}));assert.throws(()=>briefFrameOutputSchema.parse({...frame,bodyBase:{...frame.bodyBase,startUtf16:null}}));
});
