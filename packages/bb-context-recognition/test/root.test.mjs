import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../dist/index.js';
const input=(text='Plan: plans/x.plan.pkl')=>({version:1,text,format:'markdown',excluded:[],context:{consumer:{pluginId:'thread-brief',surface:'document'},links:[]}});
const candidate=(id='x',span={start:0,end:1},extra={})=>({span,match:'x',source:{provider:'plan-graph',id},confidence:'high',provenance:{basis:'explicit',explanation:'Exact mention.'},...extra});
const tag=(pluginId,id,extra={})=>({pluginId,origin:'contributed',specificity:'typed',providers:['plan-graph'],candidate:candidate(id),...extra});
test('published limits/methods/wire constants are exact and frozen',()=>{
 assert.deepEqual(c.LIMITS,{plugins:32,concurrency:4,describeMs:500,discoveryMs:3000,linkifyMs:500,linkifyStageMs:1500,resolveMs:1500,resolveStageMs:4000,overallMs:6000,textChars:65536,windows:16,excludedRanges:512,links:64,remotes:8,candidatesPerCall:64,identitiesPerResolve:32,responseBytes:65536,explanationChars:200,excerptChars:1024,reasonCount:8,metaEntries:8,providersPerClaim:16,kindsPerProvider:16});
 assert.deepEqual(c.METHODS,{describe:'contextRecognitionDescribe',linkify:'contextRecognitionV1Linkify',resolve:'contextRecognitionV1Resolve'});
 assert.deepEqual(c.WIRE_VERSIONS,[1]); assert.ok(Object.isFrozen(c.LIMITS));assert.ok(Object.isFrozen(c.METHODS));assert.ok(Object.isFrozen(c.WIRE_VERSIONS));
});
test('canonical JSON is recursively ordered UTF16, exact identity ignores kind, and rejects nonJSON',()=>{
 assert.equal(c.canonicalJson({z:0,a:{b:2,a:[true,null,'é']}}),' {"a":{"a":[true,null,"é"],"b":2},"z":0}'.trim());
 assert.equal(c.identityKey({provider:'github',id:'github.com/o/r#1',kind:'issue'}),c.identityKey({provider:'github',id:'github.com/o/r#1',kind:'pull-request'}));
 assert.notEqual(c.identityKey({provider:'a',id:'b:c'}),c.identityKey({provider:'a:b',id:'c'}));
 assert.notEqual(c.canonicalJson(['a','b']),c.canonicalJson(['b','a']));
 const cycle={};cycle.self=cycle;
 for(const v of [NaN,Infinity,undefined,1n,()=>0,new Date(),new Map(),cycle,[,1],{a:undefined}])assert.throws(()=>c.canonicalJson(v));
 assert.equal(c.canonicalJson(JSON.parse('{"__proto__":{"x":1},"constructor":3}')),'{"__proto__":{"x":1},"constructor":3}');
});
test('identity grammars and bounds, output additions tolerated',()=>{
 for(const provider of ['github','plan-graph','bb.thread','a.b.c.d'])assert.ok(c.SourceIdentitySchema.safeParse({provider,id:'x',future:1}).success);
 for(const provider of ['A','-a','a..b','a.b.c.d.e','x'.repeat(33),'a'.repeat(32)+'.'+'b'.repeat(32)])assert.equal(c.SourceIdentitySchema.safeParse({provider,id:'x'}).success,false,provider);
 for(const id of ['', 'x'.repeat(2049),'a\u0000b','a\u007fb','a\u0085b'])assert.equal(c.SourceIdentitySchema.safeParse({provider:'github',id}).success,false);
 assert.ok(c.SourceIdentitySchema.safeParse({provider:'github',id:'é'.repeat(2048),kind:'pull-request'}).success);
 assert.equal(c.SourceIdentitySchema.safeParse({provider:'github',id:'x',kind:'Issue'}).success,false);
 assert.equal(c.SourceIdentitySchema.safeParse({provider:'github',id:'x',kind:'x'.repeat(33)}).success,false);
});
test('safehref excludes executable/protocolrelative/credential/backslash/whitespace URLs; FileTarget carries data bounds',()=>{
 for(const href of ['https://example.org/a','http://localhost:80/x','/threads/x?view=1#part','/'])assert.ok(c.SafeHrefSchema.safeParse(href).success,href);
 for(const href of ['javascript:alert(1)','data:text/html,x','//evil.test','/%2Fhost','/%5chost','https://u:p@host/x','https://host/a b','/a\u2003b','/a\\b','/x\n'])assert.equal(c.SafeHrefSchema.safeParse(href).success,false,href);
 for(const target of [{kind:'workspace',environmentId:'env_a',path:'plans/x.plan.pkl'},{kind:'thread-storage',threadId:'thr_a',path:'notes/a.md'}])assert.ok(c.FileTargetSchema.safeParse({...target,future:1}).success);
 assert.equal(c.FileTargetSchema.safeParse({kind:'workspace',environmentId:'env_a',path:'x'.repeat(4097)}).success,false);
 assert.equal(c.FileTargetSchema.safeParse({kind:'workspace',path:'a'}).success,false);
});
test('strict context recursively rejects unknowns/credentials and validates locale/timezone/git bounds',()=>{
 const i=input();i.context.git={branch:'brief-suppliers',upstream:{remote:'origin',branch:'brief-suppliers'},remotes:[{name:'origin',url:'git@github.com:phosphorco/bb-community-plugins.git'}]};i.context.locale='en-GB';i.context.timeZone='Europe/Berlin';
 assert.ok(c.LinkifyInputV1Schema.safeParse(i).success);
 const edits=[v=>v.foo=1,v=>v.context.foo=1,v=>v.context.consumer.viewer='someone',v=>v.context.git.viewer=1,v=>v.context.git.upstream.foo=1,v=>v.context.git.remotes[0].secret='x',v=>v.context.links.push({href:'/x',extra:1}),v=>v.context.locale='not_a_locale',v=>v.context.timeZone='No/Such_Zone',v=>v.context.timeZone='+01:00',v=>v.context.git.branch='x'.repeat(257),v=>v.context.git.remotes=Array.from({length:9},()=>({name:'origin',url:'git@host:x'})),v=>v.context.git.remotes[0].url='https://user:pass@github.com/o/r',v=>v.context.git.remotes[0].url='https://github.com/o/r?access_token=secret'];
 for(const edit of edits){const value=structuredClone(i);edit(value);assert.equal(c.LinkifyInputV1Schema.safeParse(value).success,false);}
 assert.ok(c.LinkifyInputV1Schema.safeParse(input('')).success);
});
test('UTF16 excluded and link span bounds, sorted adjacent ranges, oversize input never clips',()=>{
 const i=input('a😀b');i.excluded=[{start:0,end:1},{start:1,end:3}];i.context.links=[{href:'/a',span:{start:1,end:3}}];assert.ok(c.LinkifyInputV1Schema.safeParse(i).success);
 for(const excluded of [[{start:0,end:0}],[{start:0,end:5}],[{start:2,end:4},{start:0,end:1}],[{start:0,end:2},{start:1,end:3}],[{start:0.1,end:2}],[{start:0,end:1,future:true}]])assert.equal(c.LinkifyInputV1Schema.safeParse({...i,excluded}).success,false);
 assert.equal(c.LinkifyInputV1Schema.safeParse({...i,text:'x'.repeat(65537),excluded:[]}).success,false);
 assert.equal(c.LinkifyInputV1Schema.safeParse({...i,excluded:Array.from({length:513},(_,n)=>({start:n,end:n+1})),text:'x'.repeat(513)}).success,false);
 assert.equal(c.LinkifyInputV1Schema.safeParse({...i,context:{...i.context,links:Array.from({length:65},()=>({href:'/a'}))}}).success,false);
 assert.equal(c.LinkifyInputV1Schema.safeParse({...i,context:{...i.context,links:[{href:'/a',span:{start:1,end:8}}]}}).success,false);
});
test('version negotiation only decodes capabilities of supported shared version',()=>{
 const cap={revision:'r1',linkify:{providers:[{provider:'github',kinds:['issue']}]}};
 for(const versions of [[1],[1,2]])assert.equal(c.negotiateVersion({protocol:'bb-context-recognition',versions,capabilities:cap,added:true}).state,'ready');
 assert.deepEqual(c.negotiateVersion({protocol:'bb-context-recognition',versions:[2],capabilities:null}),{state:'incompatible',reason:'version'});
 for(const versions of [[],[0],[1.5],Array(17).fill(1),[1001]])assert.deepEqual(c.negotiateVersion({protocol:'bb-context-recognition',versions,capabilities:cap}),{state:'incompatible',reason:'schema'});
 assert.equal(c.negotiateVersion({protocol:'wrong',versions:[1],capabilities:cap}).reason,'schema');
 assert.equal(c.negotiateVersion({protocol:'bb-context-recognition',versions:[1]}).reason,'schema');
 assert.equal(c.negotiateVersion({protocol:'bb-context-recognition',versions:[1],capabilities:{revision:'r'}}).reason,'schema');
 const decoded=c.CapabilitiesV1Schema.parse(cap);assert.equal(decoded.linkify.providers[0].specificity,'typed');
 for(const revision of ['', 'x'.repeat(65)])assert.equal(c.CapabilitiesV1Schema.safeParse({...cap,revision}).success,false);
 for(const providers of [[],Array(17).fill(cap.linkify.providers[0]),[...cap.linkify.providers,...cap.linkify.providers]])assert.equal(c.CapabilitiesV1Schema.safeParse({...cap,linkify:{providers}}).success,false);
 assert.equal(c.ProviderClaimV1Schema.safeParse({provider:'github',kinds:[]}).success,false);
 assert.equal(c.ProviderClaimV1Schema.safeParse({provider:'github',kinds:Array(17).fill('issue')}).success,false);
});
test('candidate validation checks exact match, providers, UTF16 exclusions and explicit evidence references',()=>{
 const i=input('a😀b');const x=candidate('emoji',{start:1,end:3},{match:'😀'});
 assert.deepEqual(c.checkCandidate(x,{text:i.text,excluded:[],providers:['plan-graph']}),{valid:true});
 for(const [candidate,opts] of [[{...x,match:'wrong'},{}],[x,{excluded:[{start:2,end:4}]}],[x,{providers:['github']}],[{...x,span:{start:1,end:5}},{}],[{...x,provenance:{basis:'text-url',explanation:'repo',evidence:{span:{start:0,end:20}}}},{}],[{...x,provenance:{basis:'existing-link',explanation:'repo',evidence:{link:0}}},{context:i.context}],[{...x,provenance:{basis:'git-remote',explanation:'repo',evidence:{remote:'origin'}}},{context:i.context}]])assert.equal(c.checkCandidate(candidate,{text:i.text,excluded:[],...opts}).valid,false);
 assert.equal(c.CandidateV1Schema.safeParse({...x,provenance:{basis:'explicit',explanation:'x'.repeat(201)}}).success,false);
 assert.equal(c.LinkifyOutputV1Schema.safeParse({candidates:Array(65).fill(x)}).success,false);
 assert.ok(c.LinkifyOutputV1Schema.safeParse({candidates:[{...x,future:1}],future:1}).success);
});
test('resolve strict identity-key uniqueness/count, full card bounds, state and open output compatibility',()=>{
 const req={version:1,context:{consumer:{pluginId:'reader'}},sources:[{provider:'github',id:'x'}],detail:'card'};
 assert.ok(c.ResolveInputV1Schema.safeParse(req).success);
 for(const x of [{...req,viewer:'x'},{...req,context:{...req.context,git:{}}},{...req,sources:[]},{...req,sources:Array(33).fill(req.sources[0])},{...req,sources:[req.sources[0],{...req.sources[0],kind:'issue'}]},{...req,sources:[{...req.sources[0],future:1}]}])assert.equal(c.ResolveInputV1Schema.safeParse(x).success,false);
 const ready={source:req.sources[0],state:'ready',kind:'issue',revision:'r',label:'Issue',href:'https://host.test/a',card:{title:'Title',tone:'success',meta:[{label:'author',value:'someone'}],updatedAt:'2026-10-06T16:02:11Z',excerptMarkdown:'x'.repeat(1024)},maxAgeSeconds:3600,reasons:[{code:'future-code',summary:'note'}]};
 const decoded=c.ResolveOutputV1Schema.parse({resolutions:[{...ready,future:1}],future:1});assert.equal(decoded.resolutions[0].reasons[0].code,'source-error');
 for(const edit of [v=>v.card.title='',v=>v.card.title='x'.repeat(257),v=>v.card.subtitle='x'.repeat(513),v=>v.card.status='x'.repeat(257),v=>v.card.tone='red',v=>v.card.meta=Array(9).fill({label:'x',value:'y'}),v=>v.card.updatedAt='2026-10-06T16:02:11',v=>v.card.excerptMarkdown='x'.repeat(1025),v=>v.revision='x'.repeat(257),v=>v.label='x'.repeat(257),v=>v.maxAgeSeconds=3601,v=>v.reasons=Array(9).fill({code:'timeout',summary:''}),v=>v.reasons[0].summary='x'.repeat(513),v=>v.state='unavailable']){const x=structuredClone(ready);edit(x);assert.equal(c.ResolveOutputV1Schema.safeParse({resolutions:[x]}).success,false);}
 assert.equal(c.ResolveOutputV1Schema.safeParse({resolutions:Array(33).fill(ready)}).success,false);
 for(const code of c.REASON_CODES)assert.equal(c.ReasonSchema.parse({code,summary:''}).code,code);
});
test('arbitration maximal munch, explicit, specificity, confidence and total lexicographic ordering',()=>{
 const text='xx';const long=tag('z','long',{candidate:candidate('long',{start:0,end:2},{match:'xx',confidence:'low',provenance:{basis:'context',explanation:'inferred'}})});const short=tag('a','short');
 assert.equal(c.arbitrate([short,long],{text,excluded:[]}).occurrences[0].candidate.source.id,'long');
 const typed=tag('z','typed'),generic=tag('a','generic',{specificity:'generic'});assert.equal(c.arbitrate([generic,typed],{text:'x',excluded:[]}).occurrences[0].candidate.source.id,'typed');
 const inferred=tag('a','inferred',{candidate:candidate('inferred',undefined,{provenance:{basis:'context',explanation:'infer'}})});assert.equal(c.arbitrate([inferred,typed],{text:'x',excluded:[]}).occurrences[0].candidate.source.id,'typed');
 const low=tag('a','low',{candidate:candidate('low',undefined,{confidence:'low'})});assert.equal(c.arbitrate([low,typed],{text:'x',excluded:[]}).occurrences[0].candidate.source.id,'typed');
 assert.equal(c.arbitrate([tag('z','z'),tag('a','a')],{text:'x',excluded:[]}).occurrences[0].pluginId,'a');
 assert.equal(c.arbitrate([tag('a','z'),tag('z','a',{origin:'builtin'})],{text:'x',excluded:[]}).occurrences[0].origin,'builtin');
});
test('duplicate merge retains best and alsoBy; exact-span fallback only, identities ordered/deduped',()=>{
 const a=tag('b','same'),b=tag('a','same'),fallback=tag('c','other',{specificity:'generic'});
 const result=c.arbitrate([a,b,fallback],{text:'x',excluded:[]});assert.equal(result.occurrences[0].pluginId,'a');assert.deepEqual(result.occurrences[0].alsoBy,['b']);assert.equal(result.occurrences[0].fallback.candidate.source.id,'other');assert.deepEqual(result.identities.map(x=>x.id),['same','other']);
 const again=tag('d','same',{candidate:candidate('same',{start:1,end:2})});assert.deepEqual(c.arbitrate([again,a,b,fallback],{text:'xx',excluded:[]}).identities.map(x=>x.id),['same','other']);
 const long=tag('c','long',{candidate:candidate('long',{start:0,end:2},{match:'xx'})});assert.equal(c.arbitrate([long,a],{text:'xx',excluded:[]}).occurrences[0].fallback,undefined);
});
test('reserved implemented-provider rejection, invalid/unadvertised drop counts, deterministic input permutations',()=>{
 const own={...tag('reader','thread',{origin:'builtin',providers:['bb.thread']}),candidate:{...candidate('thread'),source:{provider:'bb.thread',id:'thr_a',kind:'session'}}};
 const bad={...own,origin:'contributed',pluginId:'bad'};const unadvertised=tag('missing','x',{providers:['other']});
 const result=c.arbitrate([bad,unadvertised,own],{text:'x',excluded:[]});assert.equal(result.dropped.bad,1);assert.equal(result.dropped.missing,1);assert.equal(result.occurrences[0].pluginId,'reader');
 assert.equal(c.arbitrate([bad],{text:'x',excluded:[]}).occurrences.length,1);
 assert.equal(c.arbitrate([bad],{text:'x',excluded:[],implementedProviders:['bb.thread']}).occurrences.length,0);
 const xs=[tag('z','same'),tag('a','same'),tag('b','other',{specificity:'generic'})];
 const expected=c.canonicalJson(c.arbitrate(xs,{text:'x',excluded:[]}));for(const perm of [xs.toReversed(),[xs[1],xs[2],xs[0]]])assert.equal(c.canonicalJson(c.arbitrate(perm,{text:'x',excluded:[]})),expected);
});
test('nearest span ties choose preceding interval, no mutation and empty returns undefined',()=>{
 const before={start:0,end:2},after={start:8,end:10};const xs=[after,before];assert.equal(c.nearestSpan({start:4,end:6},xs),before);assert.deepEqual(xs,[after,before]);assert.equal(c.nearestSpan({start:0,end:1},[]),undefined);
});
test('consumer cache-key inputs partition policy, revision, context; no package cache or hash runtime',()=>{
 const base=[1,'github-review','rules/1','text-hash',[],input().context];const key=c.canonicalJson(base);
 for(const edit of [v=>v[1]='other',v=>v[2]='rules/2',v=>v[3]='other-text',v=>v[4]=[{start:0,end:1}],v=>v[5].environmentId='env_b',v=>v[5].git={branch:'other',remotes:[]}]){const value=structuredClone(base);edit(value);assert.notEqual(c.canonicalJson(value),key);}
 const source={provider:'github',id:'github.com/a/b#4'};assert.notEqual(c.canonicalJson(['review','r',c.identityKey(source),'label']),c.canonicalJson(['review','r',c.identityKey(source),'card']));
});
