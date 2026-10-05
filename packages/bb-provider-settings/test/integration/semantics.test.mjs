import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPublic, required } from './public-entry.mjs';
import { policies,provider,row,catalog,selection,capability,descriptor } from './fixtures.mjs';
import { cases, nativeErrors } from './cases.mjs';
const issue=(result,code)=>{assert.equal(result.ok??result.kind==='override',false);assert.ok(result.issues.some(i=>i.code===code),JSON.stringify(result));};
for(const c of cases.codecs.filter(c=>c.choiceKinds===undefined && c.decodeExpected===undefined)) test(`codec ${c.id}`,async()=>{
  const api=await loadPublic(), decoded=required(api,'decodeRoleChoice')(c.input);
  if(c.rejected)issue(decoded,c.rejected);
  else {assert.equal(decoded.ok,true);if(c.expected)assert.deepEqual(decoded.value,c.expected);if(c.encodeExpected)assert.deepEqual(JSON.parse(required(api,'encodeRoleChoice')(decoded.value)),c.encodeExpected);}
});
test('decode retains empty shapes and catalog aliases; only new encode normalizes cleared fields',async()=>{
  const api=await loadPublic();
  for(const choice of [{kind:'fields',fields:{}},{kind:'by-provider',entries:{p:{}}}]) {
    assert.deepEqual(api.decodeRoleChoice(choice),{ok:true,value:choice});
    assert.equal(api.encodeRoleChoice(choice),'{"kind":"inherit"}');
  }
  const alias={kind:'fields',fields:{model:'catalog-id'}};
  assert.equal(api.decodeRoleChoice(alias).value.fields.model,'catalog-id');
  assert.equal(JSON.parse(api.encodeRoleChoice(alias)).fields.model,'catalog-id');
  assert.equal(api.decodeRoleChoice({kind:'tuple',selection:{providerId:'gone',model:'gone',reasoningLevel:'low'}}).ok,true);
});
test('allowed shape and every applicable boundary capability filter static intent',async()=>{
  const api=await loadPublic();
  assert.equal(api.checkStatic({kind:'tuple',selection},descriptor())[0].code,'choice-kind-not-allowed');
  const role=descriptor({choiceKinds:['inherit','by-provider'],cascade:undefined,providerPolicy:'fixed-to-source',capability:capability({boundaries:['fork-child','create']})});
  assert.equal(api.checkStatic({kind:'by-provider',entries:{p:{model:'exec-model'}}},role)[0].code,'field-not-offered');
  role.capability.providers.p.blocked=['catalog-empty'];
  assert.equal(api.checkStatic({kind:'by-provider',entries:{p:{model:'exec-model'}}},role)[0].code,'provider-blocked');
});
for(const [name,policy,tier,support,listed,code] of [
 ['rosetta-default',policies.rosetta,'default',false,[],null],
 ['rosetta-fast',policies.rosetta,'fast',false,[],'service-tier-unsupported'],
 ['rtd-default',policies.rtd,'default',false,[{id:'default'}],'service-tier-unsupported'],
 ['rtd-default-list',policies.rtd,'default',true,[{id:'fast'}],'service-tier-unsupported'],
 ['rtd-fast-list',policies.rtd,'fast',true,[{id:'default'}],'service-tier-unsupported'],
 ['rtd-listed',policies.rtd,'fast',true,[{id:'fast'}],null],
]) test(`policy ${name}`,async()=>{
  const fn=required(await loadPublic(),'validateSelection');
  const p=provider();p.capabilities.supportsServiceTier=support;p.serviceTiers=listed;
  const result=fn({...selection,serviceTier:tier},[p],catalog(),policy);
  code?issue(result,code):assert.equal(result.ok,true);
});
test('policy retains selected-only distinction, executable model and route qualifier',async()=>{
  const fn=required(await loadPublic(),'validateSelection');
  const c=catalog({models:[],selectedOnlyModels:[row()]});
  issue(fn(selection,[provider()],c,policies.rosetta,{newSelection:true}),'selected-only-not-offered');
  assert.equal(fn({...selection,model:'catalog-id'},[provider()],c,policies.perspectives).row.model,'exec-model');
  issue(fn({...selection,model:'catalog-id'},[provider()],catalog(),policies.rosetta),'model-unavailable');
  const routed=catalog({models:[row({routeProviderId:'underlying'})]});
  issue(fn(selection,[provider()],routed,policies.rosetta),'model-unavailable');
  assert.equal(fn(selection,[provider()],routed,policies.perspectives).ok,true);
});
test('model load failure/order and differing route catalogs',async()=>{
  const fn=required(await loadPublic(),'validateSelection');
  const failed=catalog({modelLoadError:{code:'catalog_failure'}});
  issue(fn(selection,[provider()],failed,policies.rosetta),'catalog-unavailable');
  assert.equal(fn(selection,[provider()],failed,policies.perspectives).ok,true);
  issue(fn(selection,[provider('p',{available:false})],failed,policies.rosetta),'provider-unavailable');
  issue(fn(selection,[provider()],catalog({models:[row({model:'host-model'})]}),policies.rosetta),'model-unavailable');
  assert.equal(fn(selection,[provider()],catalog({route:{kind:'environment',environmentId:'e'}}),policies.rosetta).ok,true);
});
test('caller cascade falls back same-provider missing model and resolves configured id',async()=>{
  const fn=required(await loadPublic(),'resolveCallerCascade');
  assert.deepEqual(await fn({}, {...selection,model:'missing',reasoningLevel:'high'},[provider()],async()=>catalog(),policies.perspectives),{kind:'override',boundary:'spawn',fields:selection});
  assert.deepEqual((await fn({model:'catalog-id'},selection,[provider()],async()=>catalog(),policies.perspectives)).fields,selection);
});
test('caller cascade reasoning and inherited tier match original boundaries',async()=>{
  const fn=required(await loadPublic(),'resolveCallerCascade');
  const changed=await fn({providerId:'q'}, {...selection,reasoningLevel:'medium',serviceTier:'fast'},[provider(),provider('q')],async p=>catalog({providerId:p}),policies.perspectives);
  assert.deepEqual(changed.fields,{providerId:'q',model:'exec-model',reasoningLevel:'low',serviceTier:'fast'});
  const p=provider();p.capabilities.supportsServiceTier=false;
  assert.equal((await fn({},selection,[p],async()=>catalog(),policies.perspectives)).fields.serviceTier,undefined);
  issue(await fn({}, {...selection,reasoningLevel:'unavailable'},[provider()],async()=>catalog(),policies.perspectives),'reasoning-unsupported');
});
test('by-provider absence omits, reasoning uses actual child model, blocked/unknown rejects',async()=>{
  const fn=required(await loadPublic(),'resolveByProvider'),basis={providerId:'p',model:'exec-model',boundary:'fork-child'};
  assert.deepEqual(fn({kind:'by-provider',entries:{q:{model:'q'}}},basis,[provider()],catalog(),policies.rosetta,capability()),{kind:'no-override'});
  const choice={kind:'by-provider',entries:{p:{reasoningLevel:'high'}}};
  issue(fn(choice,basis,[provider()],catalog(),policies.rosetta,capability()),'reasoning-unsupported');
  const changed=fn(choice,{...basis,model:'child'},[provider()],catalog({models:[row({model:'child',supportedReasoningEfforts:[{reasoningEffort:'high'}]})]}),policies.rosetta,capability());
  assert.deepEqual(changed,{kind:'override',boundary:'first-send',fields:{reasoningLevel:'high'}});
  issue(fn(choice,basis,[provider()],catalog(),policies.rosetta,capability({providers:{}})),'provider-blocked');
});
test('create reasoning-only stays deferred and model omitted only when static witness offers it',async()=>{
  const fn=required(await loadPublic(),'resolveByProvider'),choice={kind:'by-provider',entries:{p:{reasoningLevel:'medium'}}},basis={providerId:'p',boundary:'create'};
  const cap=capability({boundaries:['create'],providers:{p:{perBoundary:{create:{model:'demonstrated',reasoningLevel:'demonstrated',reasoningWithoutModel:'unknown'}}}}});
  issue(fn(choice,basis,[provider()],null,policies.rosetta,cap),'field-not-offered');
  cap.providers.p.perBoundary.create.reasoningWithoutModel='demonstrated';
  assert.deepEqual(fn(choice,basis,[provider()],null,policies.rosetta,cap),{kind:'override',boundary:'spawn',fields:{reasoningLevel:'medium'},deferredChecks:['reasoning-vs-native-default-model']});
});
for(const versions of [[1],[1,2]])test(`tolerant numeric versions ${versions}`,async()=>{
  const fn=required(await loadPublic(),'negotiateVersion');
  const roles=[descriptor(),descriptor({id:'planner',label:'Planner'})];
  assert.deepEqual(fn({protocol:'bb-provider-settings',versions,roles,extra:true},[1]),{kind:'ok',version:1,roles,versions});
});
test('v2-only roles are not interpreted as V1; malformed envelope still rejected',async()=>{
  const fn=required(await loadPublic(),'negotiateVersion');
  assert.deepEqual(fn({protocol:'bb-provider-settings',versions:[2],roles:{future:true}},[1]),{kind:'incompatible',reason:'version',versions:[2]});
  for(const versions of [[],[0],[1.5],Array(17).fill(1)])assert.equal(fn({protocol:'bb-provider-settings',versions,roles:[]},[1]).reason,'schema');
});
for(const c of nativeErrors)test(`native error taxonomy ${c.expected}/${c.status??c.name}`,async()=>{
  const fn=required(await loadPublic(),'classifyOwnerError');
  const {expected,...error}=c;assert.equal(fn(error),expected);
});
test('unknown save reconciles configured intent and owned fields, never just changed hash',async()=>{
  const fn=required(await loadPublic(),'reconcileUnknownSave');
  const before={version:1,role:'expert',stored:{status:'valid-shape',choice:{kind:'inherit'},staticIssues:[]},fingerprint:'before',ownedFieldsDigest:'owned'};
  const choice={kind:'fields',fields:{model:'catalog-id'}};
  assert.equal(fn(before,choice,{...before,fingerprint:'changed',stored:{...before.stored,choice}}),'matches-submitted');
  assert.equal(fn(before,choice,before),'unchanged');
  assert.equal(fn(before,choice,{...before,fingerprint:'other'}),'unchanged');
  assert.equal(fn(before,choice,{...before,fingerprint:'other',stored:{...before.stored,choice:{kind:'fields',fields:{model:'different-intent'}}}}),'conflicting');
  assert.equal(fn(before,choice,{...before,ownedFieldsDigest:'changed',fingerprint:'changed',stored:{...before.stored,choice}}),'conflicting');
});
test('by-provider lookup uses own keys, including names present on Object.prototype',async()=>{
  const fn=required(await loadPublic(),'resolveByProvider');
  for(const providerId of ['toString','__proto__']) {
    assert.deepEqual(fn({kind:'by-provider',entries:{}},{providerId,model:'exec-model',boundary:'fork-child'},[provider(providerId)],catalog({providerId}),policies.rosetta,capability()),{kind:'no-override'});
  }
});
test('by-provider unavailable execution provider rejects even when catalog row exists',async()=>{
  const fn=required(await loadPublic(),'resolveByProvider');
  issue(fn({kind:'by-provider',entries:{p:{model:'exec-model'}}},{providerId:'p',model:'exec-model',boundary:'fork-child'},[provider('p',{available:false})],catalog(),policies.rosetta,capability()),'provider-unavailable');
});
test('input schemas reject unknown fields with otherwise complete valid inputs; outputs tolerate additive fields',async()=>{
  const api=await loadPublic();
  for(const [name,input] of [['readInputSchema',{version:1,role:'expert'}],['validateInputSchema',{version:1,role:'expert',choice:{kind:'inherit'}}],['saveInputSchema',{version:1,role:'expert',choice:{kind:'inherit'},expectedFingerprint:'f'.repeat(64)}]]) {
    assert.equal(api[name].safeParse(input).success,true);assert.equal(api[name].safeParse({...input,unknown:true}).success,false);
  }
  const read={version:1,role:'expert',stored:{status:'valid-shape',choice:{kind:'inherit'},staticIssues:[]},fingerprint:'f'.repeat(64),ownedFieldsDigest:null,eligibility:{status:'unverified'},ownedFieldsPresent:[],rule:'inherits',destinationRoute:null,destinationPreview:false,future:true};
  assert.equal(api.readResultSchema.safeParse(read).success,true);
});
