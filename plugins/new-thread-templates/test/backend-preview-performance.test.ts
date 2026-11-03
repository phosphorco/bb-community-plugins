import {test,expect} from 'bun:test';
import {assignmentFactories,verifiedAlice,verifiedBob} from './backend-assignment-fixtures';
import {definition} from './backend-fixtures';
import {prReviewDefinition,createRenderContext} from '../model';
import {projectTemplateTarget,renderTemplatePreview,composeTemplatePreview} from '../template-preview';
import {templatesContract,TEMPLATES_CATALOG_CHANGED,TEMPLATES_DEFINITIONS_CHANGED,TEMPLATES_JOURNAL_CHANGED} from '../rpc-contract';
const clock=createRenderContext('UTC',Date.parse('2026-11-03T12:00:00Z'));
const paths=['projects.list','projects.get','projects.defaultExecutionOptions','hosts.list','hosts.get','hosts.pathsExist','hosts.directory','environments.list','environments.get','system.config','providers.list','providers.catalog','providers.models','threads.spawn'];
const counts=(s:Awaited<ReturnType<typeof assignmentFactories>>)=>Object.fromEntries(paths.map(p=>[p,s.native.harness.callsTo(p).length]));
const pr=()=>({...prReviewDefinition(),destination:{kind:'existing-project' as const,projectId:'project-1',environment:{kind:'project-default' as const}}});
const inputs={pr_url:'https://github.com/example/repo/pull/1',subject:'Review cache',focus:'Correctness'};
const readTarget=async(s:Awaited<ReturnType<typeof assignmentFactories>>,input:unknown)=>templatesContract.targetPreview.output.parse(await s.tpl.harness.behavior.callRpc('targetPreview',input));
const catalog=async(s:Awaited<ReturnType<typeof assignmentFactories>>)=>templatesContract.publishedCatalog.output.parse(await s.tpl.harness.behavior.callRpc('publishedCatalog',{}));

test('actual factory target is independent from ordinary prompt fields; local edits compose with zero additional native discovery',async()=>{
 const s=await assignmentFactories();try{const d=pr(),projection=projectTemplateTarget(d,inputs,undefined,clock);expect(projection.request).not.toBeNull();const target=templatesContract.targetPreview.output.parse(await readTarget(s,projection.request));expect(target.issues).toEqual([]);expect(target.effects?.projectId).toBe('project-1');expect('prompt' in target.effects!).toBe(false);const before=counts(s);
  for(const changed of [{...inputs,focus:'Recovery'},{...inputs,pr_url:'https://github.com/example/repo/pull/2'},{...inputs,subject:'Other subject'}]){expect(projectTemplateTarget(d,changed,undefined,{...clock,instant:clock.instant+60000}).request).toEqual(projection.request);const local=renderTemplatePreview(d,changed,clock),combined=composeTemplatePreview(local,target,clock);expect(combined.effects?.prompt).toContain(changed.focus);expect(combined.nativeSeed?.initialPrompt).toBe(combined.effects?.prompt);}
  expect(counts(s)).toEqual(before);const invalid=renderTemplatePreview(d,{...inputs,subject:''},clock);expect(invalid.issues.length).toBeGreaterThan(0);expect(projectTemplateTarget(d,{...inputs,subject:''},undefined,clock).request).toEqual(projection.request);expect(composeTemplatePreview(invalid,target,clock).effects).toBeNull();expect(target.effects?.projectName).toBe('Actual project');expect(projectTemplateTarget({...d,promptTemplate:'{{eval subject}}'},inputs,undefined,clock).request).toEqual(projection.request);expect(renderTemplatePreview({...d,promptTemplate:'{{eval subject}}'},inputs,clock).issues.length).toBeGreaterThan(0);expect(counts(s)).toEqual(before);
 }finally{await s.dispose();}
});

test('actual rendered new-project name alone keys discovery, including defaults, helper branches and frozen clock',async()=>{
 const s=await assignmentFactories();try{const d={...pr(),destination:{kind:'new-project' as const,nameTemplate:'{{upper subject}} {{date @now "yyyy"}}',hostId:'host-main',path:'/new-source',environment:{kind:'local-source' as const}}};const projected=projectTemplateTarget(d,inputs,undefined,clock);expect(projected.request?.destination).toMatchObject({name:'REVIEW CACHE 2026 UTC'});const target=await readTarget(s,projected.request);expect(target.effects!.createsProject).toBe(true);const before=counts(s);
  expect(projectTemplateTarget(d,{...inputs,focus:'Different',pr_url:''},undefined,{...clock,instant:clock.instant+1000}).request).toEqual(projected.request);expect(counts(s)).toEqual(before);
  expect(projectTemplateTarget(d,{...inputs,subject:'Changed'},undefined,clock).request).not.toEqual(projected.request);expect(projectTemplateTarget(d,inputs,undefined,createRenderContext('UTC',Date.parse('2027-01-01T00:00:00Z'))).request).not.toEqual(projected.request);
  const literal=projectTemplateTarget({...d,destination:{...d.destination,nameTemplate:'{{subject}}'}},{...inputs,subject:'Literal {{@now}}'},undefined,clock);const literalTarget=await readTarget(s,literal.request);expect(literalTarget.effects!.projectName).toBe('Literal {{@now}}');expect(s.native.harness.callsTo('projects.create')).toHaveLength(0);expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(0);
 }finally{await s.dispose();}
});

test('choices/context stop unused model enumeration; actual model/host changes revalidate target and launch remains fresh',async()=>{
 const s=await assignmentFactories();try{const before=counts(s);const choices=templatesContract.choices.output.parse(await s.tpl.harness.behavior.callRpc('choices',{}));expect(choices.projects).toHaveLength(1);expect(choices.hosts).toHaveLength(1);expect(choices.primaryHostId).toBe('host-main');expect('actor' in choices).toBe(false);await s.context();expect(s.native.harness.callsTo('providers.list').length).toBe(before['providers.list']);expect(s.native.harness.callsTo('providers.models').length).toBe(before['providers.models']);
  const d=definition(),projection=projectTemplateTarget(d,{task:'one'},undefined,clock);expect((await readTarget(s,projection.request)).issues).toEqual([]);const modelReads=s.native.harness.callsTo('providers.models').length;s.native.models.length=0;const invalid=await readTarget(s,projection.request);expect(invalid.effects).toBeNull();expect(invalid.issues[0]!.message).toContain('models');expect(s.native.harness.callsTo('providers.models').length).toBe(modelReads+1);const launched=await s.launch();expect(launched.status.phase).toBe('failed');expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(0);expect(s.native.harness.callsTo('providers.models').length).toBe(modelReads+2);
  const base=projectTemplateTarget(d,{task:'one'},undefined,clock).request;expect(projectTemplateTarget({...d,execution:{kind:'explicit',providerId:'codex',model:'different'}},{task:'one'},undefined,clock).request).not.toEqual(base);expect(projectTemplateTarget({...d,destination:{kind:'choose-at-launch',environment:{kind:'project-default'}}},{task:'one'},'other-project',clock).request).not.toEqual(base);expect(projectTemplateTarget({...d,destination:{kind:'existing-project',projectId:'project-1',hostId:'other-host',environment:{kind:'local-source'}}},{task:'one'},undefined,clock).request).not.toEqual(base);
 }finally{await s.dispose();}
});

test('shared catalog is published only with trusted instance/clock; journal invalidates no target/catalog/definition resource',async()=>{
 const s=await assignmentFactories();try{const first=templatesContract.publishedCatalog.output.parse(await catalog(s));expect(first.instanceId).toBe('assignment-instance');expect(first.revisions.some(r=>r.templateId==='test-template')).toBe(true);expect(JSON.stringify(first)).not.toContain('editedBy');s.harness.setActor(verifiedBob);expect(await catalog(s)).toEqual(first);s.harness.setActor(verifiedAlice);
  const signals=()=>s.tpl.harness.inspection.realtimeSignals.map(e=>e.channel);let n=signals().length;await s.tpl.harness.behavior.callRpc('saveDraft',{definition:{...definition(),description:'Shared unfinished edit'},expectedGeneration:1});expect(signals().slice(n)).toContain(TEMPLATES_DEFINITIONS_CHANGED);expect(signals().slice(n)).not.toContain(TEMPLATES_CATALOG_CHANGED);expect((await catalog(s)).version).toBe(first.version);
  n=signals().length;await s.launch();expect(signals().slice(n)).toContain(TEMPLATES_JOURNAL_CHANGED);expect(signals().slice(n)).not.toContain(TEMPLATES_CATALOG_CHANGED);expect(signals().slice(n)).not.toContain(TEMPLATES_DEFINITIONS_CHANGED);expect((await catalog(s)).version).toBe(first.version);
  n=signals().length;await s.tpl.harness.behavior.callRpc('publish',{templateId:'test-template',expectedGeneration:2});expect(signals().slice(n)).toContain(TEMPLATES_CATALOG_CHANGED);expect((await catalog(s)).version).toBeGreaterThan(first.version);
 }finally{await s.dispose();}
});

test('public shared reads use the binding without opening a person/profile scope, while private context remains scoped',async()=>{
 const s=await assignmentFactories();try{
  s.harness.upstream.openScope=async()=>{throw Error('Person scope unavailable');};s.harness.upstream.session=async()=>{throw Error('Identity service unavailable');};s.harness.upstream.selfProfile=async()=>{throw Error('Profile service unavailable');};
  expect((await catalog(s)).instanceId).toBe('assignment-instance');expect(templatesContract.choices.output.parse(await s.tpl.harness.behavior.callRpc('choices',{})).projects).toHaveLength(1);expect((await readTarget(s,projectTemplateTarget(definition(),{},undefined,clock).request)).issues).toEqual([]);
  await expect(s.context()).rejects.toThrow();expect(s.native.harness.callsTo('threads.spawn')).toHaveLength(0);
 }finally{await s.dispose();}
});
