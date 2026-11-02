import { test, expect } from 'bun:test';
import { definition, nativeFixture } from './backend-fixtures';

test('project default routes catalogs to configured primary host, not a different default source',async()=>{
  const n=nativeFixture();n.projects[0]!.sources.unshift({hostId:'host-other',path:'/elsewhere',isDefault:true});n.projects[0]!.sources[1]!.isDefault=false;
  const resolved=await n.native.resolve(definition(),{task:'fix'});expect(resolved.effects.hostId).toBe('host-main');expect(resolved.environment).toEqual({type:'project-default'});expect(n.harness.callsTo('providers.models')[0]![0]).toMatchObject({hostId:'host-main',projectId:'project-1'});expect(resolved.effects.warnings.join()).toContain('checkout or a new worktree');
});
test('project-default with no primary-host source blocks instead of choosing another machine',async()=>{
  const n=nativeFixture();n.projects[0]!.sources[0]!.hostId='other';await expect(n.native.resolve(definition(),{task:'fix'})).rejects.toThrow('no source on the target host');
});
test('new-project preview discovers exact normalized source winner and uses its real name/defaults',async()=>{
  const n=nativeFixture();n.defaults.model='different-model';n.models[0]!.model='different-model';
  const d=definition({destination:{kind:'new-project',nameTemplate:'Different requested name',hostId:'host-main',path:' /src/project/// ',environment:{kind:'local-source'}}});
  const p=await n.native.preview(d,{task:'fix'});expect(p.issues).toEqual([]);expect(p.effects).toMatchObject({projectId:'project-1',projectName:'Actual project',createsProject:false,execution:{model:'different-model'}});expect(n.harness.callsTo('projects.create')).toHaveLength(0);
});
test('new source requires a connected enrolled host and actual directory; file path fails before creation',async()=>{
  const n=nativeFixture();n.harness.stub('hosts.directory',async()=>{throw new Error('Not a directory');});
  const d=definition({destination:{kind:'new-project',nameTemplate:'New',hostId:'host-main',path:'/src/regular-file',environment:{kind:'local-source'}}});const preview=await n.native.preview(d,{task:'fix'});expect(preview.effects).toBeNull();expect(preview.issues[0]!.message).toContain('Not a directory');expect(n.harness.callsTo('projects.create')).toHaveLength(0);
});
test('reuse verifies environment ownership and routes models to that environment',async()=>{
  const n=nativeFixture();const d=definition({destination:{kind:'existing-project',projectId:'project-1',environment:{kind:'reuse',environmentId:'env-1'}}});const p=await n.native.resolve(d,{task:'fix'});expect(p.effects.routing).toEqual({kind:'environment',environmentId:'env-1'});expect(n.harness.callsTo('providers.models')[0]![0]).toMatchObject({environmentId:'env-1'});n.env.projectId='foreign';await expect(n.native.resolve(d,{task:'fix'})).rejects.toThrow('different project');
});
test('explicit provider/model/reasoning/service tier provenance is carried and unavailable values block',async()=>{
  const n=nativeFixture();const d=definition({execution:{kind:'explicit',providerId:'codex',model:'model-a',reasoningLevel:'high',serviceTier:'fast'}});const p=await n.native.resolve(d,{task:'fix'});expect(p.execution.executionInputSources).toEqual({providerId:'explicit',model:'explicit',reasoningLevel:'explicit',serviceTier:'explicit'});expect(p.execution).not.toHaveProperty('permissionMode');await expect(n.native.resolve({...d,execution:{...d.execution,kind:'explicit',providerId:'codex',model:'missing'}},{task:'fix'})).rejects.toThrow('unavailable');await expect(n.native.resolve({...d,execution:{kind:'explicit',providerId:'codex',model:'model-a',reasoningLevel:'ultra'}},{task:'fix'})).rejects.toThrow('reasoning level');
});
test('default service tier is always valid; model omission inherits provider tiers; explicit unsupported tier blocks',async()=>{
  const n=nativeFixture();for(const tier of ['default','fast'])expect((await n.native.resolve(definition({execution:{kind:'explicit',providerId:'codex',model:'model-a',serviceTier:tier}}),{task:'fix'})).execution.serviceTier).toBe(tier);n.models[0]!.supportedServiceTiers=[];await expect(n.native.resolve(definition({execution:{kind:'explicit',providerId:'codex',model:'model-a',serviceTier:'fast'}}),{task:'fix'})).rejects.toThrow('service tier');
});
test('settings disabling fast tier after publication blocks explicit fast and displays inherited effective default',async()=>{
  const n=nativeFixture();n.config.generalSettings.allowFastServiceTier=false;n.defaults.serviceTier='fast';expect((await n.native.resolve(definition(),{task:'fix'})).effects.execution.serviceTier).toBe('default');await expect(n.native.resolve(definition({execution:{kind:'explicit',providerId:'codex',model:'model-a',serviceTier:'fast'}}),{task:'fix'})).rejects.toThrow('disabled in BB settings');
});
test('disabled inherited provider follows native fallback without carrying incompatible stored model',async()=>{
  const n=nativeFixture();n.defaults.providerId='disabled-provider';n.defaults.model='unrelated-model';n.harness.stub('providers.catalog',async()=>[{id:'disabled-provider',enabled:false},{id:'codex',enabled:true}]);const p=await n.native.resolve(definition(),{task:'fix'});expect(p.effects.execution).toMatchObject({providerId:'codex',model:'model-a',inherited:true});expect(p.execution).toEqual({});
});
test('catalog load failure is honest and selected-only model is accepted when explicitly selected',async()=>{
  const n=nativeFixture();const d=definition({execution:{kind:'explicit',providerId:'codex',model:'model-a'}});n.harness.stub('providers.models',async()=>({models:[],selectedOnlyModels:[],modelLoadError:{code:'timeout',detail:'Host timed out'}}));await expect(n.native.resolve(d,{task:'fix'})).rejects.toThrow('Host timed out');n.harness.stub('providers.models',async()=>({models:[],selectedOnlyModels:n.models,modelLoadError:null}));expect((await n.native.resolve(d,{task:'fix'})).effects.execution.model).toBe('model-a');
});
test('side-effect-free preview rejects invalid input and preserves real projects without create/spawn',async()=>{
  const n=nativeFixture();expect((await n.native.preview(definition(),{})).issues).not.toHaveLength(0);expect((await n.native.preview(definition(),{task:'fix'})).effects!.projectName).toBe('Actual project');expect(n.harness.callsTo('projects.create')).toHaveLength(0);expect(n.harness.callsTo('threads.spawn')).toHaveLength(0);
});
