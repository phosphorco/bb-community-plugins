import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PresentationRefV1Schema,ResolutionV1Schema,LIMITS} from '../dist/index.js';
import * as registry from '../dist/presentation.js';
import {createIsolatedPresentationRealm,presentationFixtures} from '../dist/testing.js';
const source={provider:'plan-graph',id:'env_x:x.plan.pkl',kind:'plan'};
const ref={schema:'plan-graph/plan@1',data:{id:source.id}};
const registration={schema:ref.schema,decode:data=>data,methods:['scene'],load:async()=>()=>null};
const ctx=generation=>({pluginId:'plan-graph',generation,signal:new AbortController().signal});
test('presentation schema-id, canonical UTF8 data/depth and ready-card bounds',()=>{
 for(const f of presentationFixtures)assert.equal(PresentationRefV1Schema.safeParse(f.value).success,f.valid,f.name);
 assert.equal(LIMITS.presentationDataBytes,4096);assert.equal(LIMITS.presentationDepth,8);assert.equal(LIMITS.presentationRpcMs,5000);
 assert.ok(PresentationRefV1Schema.safeParse({schema:ref.schema,data:'x'.repeat(4094)}).success);
 assert.equal(PresentationRefV1Schema.safeParse({schema:ref.schema,data:'x'.repeat(4095)}).success,false);
 let nested=0;for(let i=0;i<8;i++)nested={child:nested};assert.ok(PresentationRefV1Schema.safeParse({schema:ref.schema,data:nested}).success);
 nested={child:nested};assert.equal(PresentationRefV1Schema.safeParse({schema:ref.schema,data:nested}).success,false);
 const cyclic={};cyclic.child=cyclic;assert.equal(PresentationRefV1Schema.safeParse({schema:ref.schema,data:cyclic}).success,false);
 assert.equal(PresentationRefV1Schema.safeParse({schema:ref.schema,data:{oops:undefined}}).success,false);
 assert.equal(ResolutionV1Schema.safeParse({source,state:'ready',reasons:[],presentation:ref}).success,false);
 assert.equal(ResolutionV1Schema.safeParse({source,state:'unavailable',reasons:[],presentation:ref,card:{title:'Plan'}}).success,false);
 assert.ok(ResolutionV1Schema.safeParse({source,state:'ready',reasons:[],presentation:ref,card:{title:'Plan'}}).success);
 // Old wire-v1 output decoding strips additive fields (0.3.0 object policy).
 const {presentation,...legacy}=ResolutionV1Schema.parse({source,state:'ready',reasons:[],presentation:ref,card:{title:'Plan'}});assert.equal(legacy.card.title,'Plan');
});
test('registry stale-disposer token, higher generation, same-generation replacement and signal disposal',()=>{
 const realm=createIsolatedPresentationRealm();let notifications=0;
 const off=registry.subscribePresentations(()=>notifications++);
 try {
  const old=registry.registerPresentation(ctx(1),registration),first=registry.lookupPresentation('plan-graph',ref.schema);
  const abort=new AbortController();const latest=registry.registerPresentation({...ctx(2),signal:abort.signal},registration);
  const second=registry.lookupPresentation('plan-graph',ref.schema);assert.notEqual(second.token,first.token);
  old();assert.equal(registry.lookupPresentation('plan-graph',ref.schema),second);
  registry.registerPresentation(ctx(1),registration)();assert.equal(registry.lookupPresentation('plan-graph',ref.schema),second);
  abort.abort();assert.equal(registry.lookupPresentation('plan-graph',ref.schema),undefined);latest();assert.equal(notifications,3);
  const a=registry.registerPresentation(ctx(3),registration);const b=registry.registerPresentation(ctx(3),registration);a();assert.ok(registry.lookupPresentation('plan-graph',ref.schema));b();
  assert.equal(registry.getPresentationRevision(),6);
  assert.throws(()=>registry.registerPresentation(ctx(4),{...registration,methods:[]}),registry.PresentationRegistrationError);
  assert.throws(()=>registry.registerPresentation(ctx(4),{...registration,load:null}),registry.PresentationRegistrationError);
  const already=new AbortController();already.abort();registry.registerPresentation({...ctx(4),signal:already.signal},registration)();assert.equal(registry.getPresentationRevision(),6);
 }finally{off();realm.restore();}
});
test('mixed-version built package copies share native v1 realm and stale-disposer fencing',async()=>{
 const scratch=await mkdtemp(join(tmpdir(),'presentation-mixed-'));const realm=createIsolatedPresentationRealm();
 try{
  const built=await readFile(new URL('../dist/presentation.js',import.meta.url),'utf8');
  await writeFile(join(scratch,'later-copy.mjs'),'// Later-copy fixture: compatible v1 layout, optional newer metadata.\n'+built);
  const later=await import(pathToFileURL(join(scratch,'later-copy.mjs')).href);
  const old=registry.registerPresentation(ctx(1),registration);let events=0;const off=later.subscribePresentations(()=>events++);
  const dispose=later.registerPresentation(ctx(2),{...registration,label:'Later build'});old();
  assert.equal(registry.lookupPresentation('plan-graph',ref.schema),later.lookupPresentation('plan-graph',ref.schema));
  assert.equal(registry.lookupPresentation('plan-graph',ref.schema).label,'Later build');assert.equal(events,1);
  dispose();assert.equal(registry.lookupPresentation('plan-graph',ref.schema),undefined);assert.equal(events,2);off();
 }finally{realm.restore();await rm(scratch,{recursive:true,force:true});}
});
