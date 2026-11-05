import assert from 'node:assert/strict';
import {test} from 'bun:test';
import {recognitionIdentity,recognitionIdentityRecord,verifiedFileIdentity,verifiedFileIdentityRecord,VerifiedFileTargetSchema,canonicalizeIdentity,sha256Hex} from '@phosphorco/bb-cross-references';
import {canonicalJson} from '@phosphorco/bb-context-recognition';
test('recognition identity codec verifies threads, hashes opaque IDs without truncation, and ignores kind',()=>{
 const source={provider:'github',id:'github.com/o/r#42',kind:'pull-request'};
 assert.deepEqual(recognitionIdentity(source),{provider:'recognition',keys:{provider:'github',identity:sha256Hex(canonicalJson([source.provider,source.id]))}});
 assert.deepEqual(recognitionIdentity(source),recognitionIdentity({...source,kind:'issue'}));
 const huge={provider:'plan-graph',id:'😀'.repeat(1024)};
 assert.ok(recognitionIdentityRecord(huge).includes(huge.id));
 assert.ok(canonicalizeIdentity(recognitionIdentity(huge)).keys.identity.length===64);
 assert.throws(()=>recognitionIdentity({...huge,id:'x'.repeat(2049)}));
 assert.throws(()=>recognitionIdentity({provider:'bb.thread',id:'thr_a'}));
 assert.throws(()=>recognitionIdentity({provider:'bb.thread',id:'thr_a'},{id:'thr_wrong',projectId:'proj_a'}));
 assert.throws(()=>recognitionIdentity({provider:'bb.thread',id:'thr_a'},{id:'thr_a',projectId:'proj_a',deletedAt:1}));
 assert.deepEqual(recognitionIdentity({provider:'bb.thread',id:'thr_a'},{id:'thr_a',projectId:'proj_a'}),{provider:'bb',keys:{project:'proj_a',thread:'thr_a'}});
});
test('URL identities preserve exact safe canonical URLs and reject credentials, sensitive parameters and unsafe routes',()=>{
 assert.deepEqual(recognitionIdentity({provider:'bb.url',id:'https://EXAMPLE.test:443/a?x=1#two'}),{provider:'url',keys:{href:'https://example.test/a?x=1#two'}});
 for(const id of ['javascript:alert(1)','//evil.test/a','https://a:b@example.test','https://example.test/?token=x','https://example.test/#sig=x','/local'])assert.throws(()=>recognitionIdentity({provider:'bb.url',id}),id);
});

test('verified file tuple codec coalesces workspace consumers, keeps storage/environment/alias/Unicode identities distinct and preserves full metadata',()=>{
 const file={kind:'workspace',environmentId:'env_shared',path:'plans/日本語.plan.pkl'};
 const identity=verifiedFileIdentity(file);
 assert.deepEqual(identity,{provider:'recognition',keys:{provider:'bb.file',identity:sha256Hex(canonicalJson(['bb.file','workspace','env_shared',file.path]))}});
 for(const other of [{...file,environmentId:'env_other'},{kind:'thread-storage',threadId:'thr_shared',path:file.path},{...file,path:'plans/alias.plan.pkl'},
  {...file,path:'plans/é.txt'},{...file,path:'plans/e\u0301.txt'}])assert.notDeepEqual(verifiedFileIdentity(other),identity);
 assert.notDeepEqual(verifiedFileIdentity({...file,path:'é.txt'}),verifiedFileIdentity({...file,path:'e\u0301.txt'}));
 const long={...file,path:'x'.repeat(4096)};assert.equal(verifiedFileIdentity(long).keys.identity.length,64);
 assert.deepEqual(JSON.parse(verifiedFileIdentityRecord(long)),{provider:'bb.file',verifiedFile:long});
 for(const path of ['/absolute','../escape','a//b','a/./b','a\\b','a%2fb','a?token=x','a#b','a:frame','x'.repeat(4097)])assert.equal(VerifiedFileTargetSchema.safeParse({...file,path}).success,false,path);
 assert.equal(VerifiedFileTargetSchema.safeParse({...file,extra:true}).success,false);
 assert.throws(()=>recognitionIdentity({provider:'bb.file',id:'thr_source:plans/a.pkl'}),/verifiedFileIdentity/);
});
