import { test, expect } from 'bun:test';
import { familyClosure,dollarPercentiles,heat,readInputSchema,parseBounded,readResultSchema,validateReadResult,validateDetailResult,negotiateVersion,retainedWindowStart,coverageSchema,coverageReasonSchema,detailInputSchema,LIMITS } from '../dist/index.js';
export const vector={inputUncached:10,cacheRead:2,cacheWrite:3,output:4};
export const approx={approximate:false,reasons:[]};
export const pop={asOf:100000000,count:10,coverage:'complete'};
export function row(threadId='thr_a') {return {threadId,scope:'family',memberCount:1,coverage:'complete',coverageReasons:[],asOf:100000000,revision:'content-v1',priceVersion:'rates-v1',currency:'USD',estimated:true,approximation:approx,ranks:{m20:0,h24:0,d7:0},rankPopulation:{m20:pop,h24:pop,d7:pop},changed:true,windows:Object.fromEntries(['m20','h24','d7','lifetime'].map(k=>[k,{tokens:vector,amount:1}]))};}
export const detailInput={threadId:'thr_a',scope:'family',axis:'model',window:'lifetime'};
export function detail() {return {version:1,...detailInput,asOf:100000000,revision:'content-v1',priceVersion:'rates-v1',currency:'USD',estimated:true,coverage:'complete',coverageReasons:[],approximation:approx,total:{tokens:vector,amount:1},rows:[{axis:'model',providerId:'provider',modelId:'model',amount:1,tokens:vector,approximation:approx}]};}
const input={threadIds:['thr_a'],scope:'family'};
test('dual-edge diamond + cycle: hidden and archived default included, deleted excluded',()=>{
 const edges=[{threadId:'a',parentThreadId:'d'},{threadId:'b',parentThreadId:'a',hidden:true},{threadId:'c',lifecycleOwnerThreadId:'a',archived:true},{threadId:'d',parentThreadId:'b',lifecycleOwnerThreadId:'c'},{threadId:'x',parentThreadId:'a',deleted:true},{threadId:'y',parentThreadId:'x'}];
 expect(familyClosure(edges,['a','a'])).toEqual({members:['a','b','c','d'],coverage:'complete',coverageReasons:[]});
 expect(familyClosure(edges,['a'],{includeArchived:false}).members).toEqual(['a','b','d']);
 expect(familyClosure(edges,['a'],{maxMembers:2}).coverageReasons).toContain('member-cap');
 expect(familyClosure(edges,['a'],{maxDepth:1}).coverageReasons).toContain('depth-cap');
 expect(familyClosure(edges,['a'],{maxEdges:2}).coverageReasons).toContain('edge-cap');
 expect(familyClosure(edges,['missing']).coverageReasons).toContain('missing-thread');
 expect(familyClosure(edges,['a'],{sourceCoverage:'unknown'}).coverage).toBe('unknown');
 expect(()=>familyClosure(edges,['a'],{maxMembers:Infinity})).toThrow();
});
test('family populations compare like-for-like; roots may overlap but closure dedups each root',()=>{
 const edges=[{threadId:'a'},{threadId:'b'},{threadId:'shared',parentThreadId:'a',lifecycleOwnerThreadId:'b'}];
 expect(familyClosure(edges,['a']).members).toEqual(['a','shared']);expect(familyClosure(edges,['b']).members).toEqual(['b','shared']);
 expect(familyClosure(edges,['a','b']).members).toEqual(['a','b','shared']);
 const own=dollarPercentiles([{threadId:'a',amount:1},{threadId:'b',amount:2}]);
 const family=dollarPercentiles([{threadId:'a',amount:11},{threadId:'b',amount:12}]);expect(family.get('a')).toBe(own.get('a'));expect(family.get('b')).toBe(1);
});
test('dollar ranks tie/singleton/equal/unknown/zero semantics; median no heat',()=>{
 const ranked=dollarPercentiles(Array.from({length:11},(_,i)=>({threadId:String(i),amount:i+1})));
 expect(ranked.get('5')).toBe(.5);expect(heat({m20:.5,h24:.5,d7:.5})).toBeNull();expect(heat({m20:ranked.get('10'),h24:null,d7:null})).toBe('on-fire');
 const tied=dollarPercentiles([{threadId:'a',amount:1},{threadId:'b',amount:3},{threadId:'c',amount:3}]);expect(tied.get('b')).toBe(.5);expect(tied.get('c')).toBe(.5);
 for(const n of [1,10])expect([...dollarPercentiles(Array.from({length:n},(_,i)=>({threadId:String(i),amount:3}))).values()]).toEqual(Array(n).fill(0));
 expect([...dollarPercentiles([{threadId:'a',amount:0},{threadId:'b',amount:null}]).values()]).toEqual([null,null]);
 expect(()=>dollarPercentiles([{threadId:'a',amount:NaN}])).toThrow();expect(()=>dollarPercentiles([{threadId:'a',amount:1},{threadId:'a',amount:2}])).toThrow();
 expect(heat({m20:null,h24:.9,d7:1})).toBe('hot');expect(heat({m20:null,h24:.8,d7:.9})).toBe('heavy');
});
test('strict inputs and byte/count bounds; additive outputs tolerated',()=>{
 expect(readInputSchema.safeParse({...input,extra:1}).success).toBe(false);
 expect(readInputSchema.safeParse({...input,series:{activeThreadId:'other',maxPoints:288}}).success).toBe(false);
 expect(readInputSchema.safeParse({...input,knownRevisions:{other:'v'}}).success).toBe(false);
 expect(readInputSchema.safeParse({...input,threadIds:Array(201).fill('a')}).success).toBe(false);
 expect(()=>parseBounded(readInputSchema,{...input,extra:'é'.repeat(LIMITS.inputBytes)},LIMITS.inputBytes)).toThrow();
 expect(validateReadResult(input,{version:1,rows:[{...row(),extra:true}],extra:'future'}).rows[0].threadId).toBe('thr_a');
 expect(()=>validateReadResult(input,{version:1,rows:[row('unrequested')]})).toThrow();
 expect(()=>validateReadResult(input,{version:1,rows:[row(),row()]})).toThrow();
 expect(()=>parseBounded(readResultSchema,{version:1,rows:[],future:'a'.repeat(LIMITS.outputBytes)},LIMITS.outputBytes)).toThrow();
});
test('no-change requires matching revision; current metadata is retained',()=>{
 const {windows,...metadata}=row();const fresh={...metadata,changed:false,asOf:100000010,coverage:'partial',coverageReasons:['source-gap'],ranks:{m20:1,h24:0,d7:0},priceVersion:'rates-v1'};
 expect(()=>validateReadResult(input,{version:1,rows:[fresh]})).toThrow();
 const result=validateReadResult({...input,knownRevisions:{thr_a:'content-v1'}},{version:1,rows:[fresh]});expect(result.rows[0]).toEqual(fresh);
 // Rate/window/series revisions themselves remain supplier obligations; adapter does not hash storage.
});
test('active series bounded, ordered and within 24h',()=>{
 const r={...row(),buckets:[{start:99600000,amount:1},{start:99900000,amount:1}]};
 expect(validateReadResult({...input,series:{activeThreadId:'thr_a',maxPoints:2}},{version:1,rows:[r]}).rows).toHaveLength(1);
 expect(()=>validateReadResult(input,{version:1,rows:[r]})).toThrow();
 expect(()=>validateReadResult({...input,series:{activeThreadId:'thr_a',maxPoints:1}},{version:1,rows:[r]})).toThrow();
 expect(()=>validateReadResult({...input,series:{activeThreadId:'thr_a',maxPoints:2}},{version:1,rows:[{...r,buckets:[{start:1,amount:1}]}]})).toThrow();
});
test('detail unique models reconcile totals',()=>{
 expect(validateDetailResult(detailInput,detail()).total.amount).toBe(1);
 expect(()=>validateDetailResult(detailInput,{...detail(),rows:[...detail().rows,...detail().rows]})).toThrow();
 expect(()=>validateDetailResult(detailInput,{...detail(),total:{tokens:vector,amount:2}})).toThrow();
 expect(()=>validateDetailResult(detailInput,{...detail(),nextCursor:'page2'})).toThrow();
 expect(validateDetailResult(detailInput,{...detail(),coverage:'partial',coverageReasons:['pagination'],nextCursor:'page2'}).nextCursor).toBe('page2');
 expect(()=>validateDetailResult(detailInput,{...detail(),rows:[{...detail().rows[0],amount:null}]})).toThrow();
 const missing={approximate:true,reasons:['missing-price']};
 expect(validateDetailResult(detailInput,{...detail(),approximation:missing,total:{tokens:vector,amount:null},rows:[{...detail().rows[0],amount:null,approximation:missing}]}).total.amount).toBeNull();
});
test('negotiation parses envelope first then v1, unknown future details ignored',()=>{
 for(const versions of [[1],[1,2]])expect(negotiateVersion({protocol:'bb-thread-metrics',versions,capabilities:{summary:true,series:true,detail:false,future:'ok'}}).kind).toBe('ready');
 for(const versions of [[2],[],[0],[1.5],Array(17).fill(1)])expect(negotiateVersion({protocol:'bb-thread-metrics',versions,capabilities:{}}).kind).toBe('incompatible');
 expect(negotiateVersion({protocol:'bb-thread-metrics',versions:[1],capabilities:{}}).kind).toBe('incompatible');
});

test('diamond family closure counts shared usage once before model aggregation',()=>{
 const edges=[{threadId:'a'},{threadId:'b',parentThreadId:'a'},{threadId:'c',lifecycleOwnerThreadId:'a'},{threadId:'d',parentThreadId:'b',lifecycleOwnerThreadId:'c'}];
 const family=familyClosure(edges,['a']);
 const totalTokens=Object.fromEntries(Object.entries(vector).map(([key,n])=>[key,n*4]));
 const response={...detail(),threadId:'a',total:{tokens:totalTokens,amount:4},rows:[{axis:'model',providerId:'provider',modelId:'model',tokens:totalTokens,amount:family.members.length,approximation:approx}]};
 expect(family.members).toHaveLength(4);expect(validateDetailResult({...detailInput,threadId:'a'},response).total.amount).toBe(4);
 expect(()=>validateDetailResult({...detailInput,threadId:'a'},{...response,total:{tokens:totalTokens,amount:5}})).toThrow();
});

test('unchanged forbids recognized windows/buckets before strip, while unknown additions remain tolerated',()=>{
 const {windows,...base}=row();const fresh={...base,changed:false};const req={...input,knownRevisions:{thr_a:fresh.revision}};
 for(const recognized of [{windows},{buckets:[{start:fresh.asOf+1,amount:4}]},{windows,buckets:[{start:fresh.asOf+1,amount:4}]},{windows:null},{buckets:null}]){
  expect(()=>validateReadResult(req,{version:1,rows:[{...fresh,...recognized}]})).toThrow();
  expect(()=>validateReadResult({...req,series:{activeThreadId:'thr_a',maxPoints:1}},{version:1,rows:[{...fresh,...recognized}]})).toThrow();
 }
 expect(validateReadResult(req,{version:1,rows:[{...fresh,future:'additive'}]}).rows[0]).toEqual(fresh);
});
test('unknown bucket and partial detail total require top-level missing-price provenance',()=>{
 const request={...input,series:{activeThreadId:'thr_a',maxPoints:1}};
 const missing={approximate:true,reasons:['missing-price']};const r={...row(),buckets:[{start:99900000,amount:null}]};
 expect(()=>validateReadResult(request,{version:1,rows:[r]})).toThrow('missing-price');
 expect(validateReadResult(request,{version:1,rows:[{...r,approximation:missing}]}).rows[0].buckets[0].amount).toBeNull();
 const d={...detail(),coverage:'partial',coverageReasons:['source-gap'],total:{tokens:vector,amount:null},rows:[]};
 expect(()=>validateDetailResult(detailInput,d)).toThrow('missing-price');
 expect(validateDetailResult(detailInput,{...d,approximation:missing}).total.amount).toBeNull();
});
test('time rows use last-N lower bound, clipped current bucket and sorted disjoint intervals',()=>{
 const now=100000000;const lower=99000000;expect(retainedWindowStart(now,'m20')).toBe(lower);
 const req={...detailInput,axis:'time',window:'m20'};
 const interval=(start,end)=>({axis:'time',start,end,tokens:vector,amount:1,approximation:approx});
 const totalTokens=Object.fromEntries(Object.entries(vector).map(([k,v])=>[k,v*2]));
 const response={...detail(),axis:'time',window:'m20',asOf:now,total:{tokens:totalTokens,amount:2},rows:[interval(lower,lower+300000),interval(99900000,now)]};
 expect(validateDetailResult(req,response).rows).toHaveLength(2);
 const invalid=[
  [interval(99300000,now),interval(99600000,now)], // overlap, despite reconciling total
  [interval(99600000,99900000),interval(99300000,99600000)], // unsorted
  [interval(lower-300000,lower),interval(99900000,now)], // out of retained window
  [interval(100200000,100500000),interval(100500000,100800000)], // future
  [interval(99600000,99900000),interval(99900000,100200000)], // current end must clip
 ];
 for(const rows of invalid)expect(()=>validateDetailResult(req,{...response,rows})).toThrow();
 const boundary=99900000;expect(retainedWindowStart(boundary,'m20')).toBe(lower);
 expect(()=>validateDetailResult(req,{...response,asOf:boundary,rows:[interval(lower,lower+300000),interval(boundary,boundary)]})).toThrow();
 const lifetime={...response,window:'lifetime',coverage:'partial',coverageReasons:['retention'],rows:[interval(retainedWindowStart(now,'lifetime')-300000,retainedWindowStart(now,'lifetime'))]};
 expect(()=>validateDetailResult({...req,window:'lifetime'},lifetime)).toThrow();
});
test('coverage uses complete/partial/unknown, optional excluded mirrors membership vocabulary',()=>{
 expect(coverageSchema.safeParse('gap').success).toBe(false);
 const r={...row(),coverage:'partial',coverageReasons:['source-gap'],excluded:2};
 expect(validateReadResult(input,{version:1,rows:[r]}).rows[0].excluded).toBe(2);
 expect(()=>validateReadResult(input,{version:1,rows:[{...r,excluded:-1}]})).toThrow();
 const d={...detail(),coverage:'partial',excluded:3};expect(validateDetailResult(detailInput,d).excluded).toBe(3);
 expect(familyClosure([{threadId:'a'}],['a'],{sourceCoverage:'partial'}).coverage).toBe('partial');
});

test('shared metrics detail rejects descendant enumeration axis',()=>{
 expect(detailInputSchema.safeParse({...detailInput,axis:'descendant'}).success).toBe(false);
 expect(()=>validateDetailResult(detailInput,{...detail(),axis:'descendant',rows:[{axis:'descendant',threadId:'thr_a',amount:1,tokens:vector,approximation:approx}]})).toThrow();
});

test('root-unattested reason preserves positive dollar floors and distinct coverage semantics',()=>{
 expect(coverageReasonSchema.parse('root-unattested')).toBe('root-unattested');
 const floor={...row(),coverage:'partial',coverageReasons:['root-unattested']};
 const summary=validateReadResult(input,{version:1,rows:[floor]}).rows[0];
 expect(summary.coverageReasons).toEqual(['root-unattested']);expect(summary.coverage).toBe('partial');
 expect(summary.windows.lifetime.amount).toBe(1);
 const breakdown=validateDetailResult(detailInput,{...detail(),coverage:'partial',coverageReasons:['root-unattested']});
 expect(breakdown.coverageReasons).toEqual(['root-unattested']);expect(breakdown.total.amount).toBe(1);
 const floors=dollarPercentiles([{threadId:'root',amount:summary.windows.m20.amount},{threadId:'peer',amount:2}]);
 expect(floors.get('root')).toBe(0);expect(dollarPercentiles([{threadId:'root',amount:0}]).get('root')).toBeNull();
 expect(validateReadResult(input,{version:1,rows:[]}).rows).toEqual([]); // supplier may omit unsupported zero evidence
});
