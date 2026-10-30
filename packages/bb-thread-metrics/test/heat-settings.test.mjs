import { test, expect } from 'bun:test';
import { scoringConfigV2Schema, DEFAULT_SCORING_CONFIG_V2 } from '../dist/index.js';
test('tuning config enforces approved numeric limits without clamping',()=>{
 expect(scoringConfigV2Schema.safeParse({...DEFAULT_SCORING_CONFIG_V2,providerWeights:{codex:3.01}}).success).toBe(false);
 expect(scoringConfigV2Schema.safeParse({schemaVersion:2,mode:'absolute',providerWeights:{},thresholds:{m20:0,h24:1000000.01,d7:0,lifetime:0}}).success).toBe(false);
});

import { validateHeatConfig,canonicalHeatConfig,heatSettingsSaveInputSchema,bounded,heatSettingsReadResultSchema,HEAT_SETTINGS_LIMITS,reconcileHeatSave,weightedScoreV2 } from '../dist/index.js';
const percentile={schemaVersion:2,mode:'percentile',providerWeights:{codex:1,'claude-code':1},gates:{m20:.83,h24:.91,d7:.9}};
const absolute={schemaVersion:2,mode:'absolute',providerWeights:{codex:3,'claude-code':0},thresholds:{m20:0,h24:1e6,d7:.001,lifetime:1e6}};
test('numeric limits, full precision, strict nested saves, additive read configs and immutable default',()=>{
 expect(validateHeatConfig(percentile)).toEqual(percentile);
 expect(validateHeatConfig(absolute)).toEqual(absolute);
 expect(scoringConfigV2Schema.parse({...percentile,future:'ok',gates:{...percentile.gates,future:'ok'}})).toEqual(percentile);
 expect(validateHeatConfig({...percentile,providerWeights:{codex:.123456789}}).providerWeights.codex).toBe(.123456789);
 for(const bad of [NaN,Infinity,-.01,3.01])expect(()=>validateHeatConfig({...percentile,providerWeights:{codex:bad}})).toThrow();
 expect(()=>validateHeatConfig({...absolute,thresholds:{...absolute.thresholds,h24:1e6+.01}})).toThrow();
 expect(()=>validateHeatConfig({...percentile,providerWeights:Object.fromEntries(Array.from({length:33},(_,i)=>['p'+i,1]))})).toThrow();
 expect(()=>validateHeatConfig({...percentile,providerWeights:{['x'.repeat(201)]:1}})).toThrow();
 const input={protocolVersion:1,baseConfigVersion:'cfg0',operationKey:'save0',candidate:percentile};
 expect(()=>heatSettingsSaveInputSchema.parse({...input,candidate:{...percentile,gates:{...percentile.gates,extra:1}}})).toThrow();
 expect(()=>bounded(heatSettingsReadResultSchema,{extra:'x'.repeat(HEAT_SETTINGS_LIMITS.outputBytes)},HEAT_SETTINGS_LIMITS.outputBytes)).toThrow('byte');
 expect(canonicalHeatConfig({...absolute,lifetimeEnabled:false})).toBe(canonicalHeatConfig(absolute));
 expect(weightedScoreV2([{providerId:'codex',amount:10},{providerId:'other',amount:2}],{codex:0})).toBe(2);
 expect(DEFAULT_SCORING_CONFIG_V2.providerWeights).toEqual({});expect(Object.isFrozen(DEFAULT_SCORING_CONFIG_V2.gates)).toBe(true);
});
test('reconciliation requires operation identity and candidate agreement',()=>{
 const input={protocolVersion:1,baseConfigVersion:'old',operationKey:'save',candidate:percentile};
 const read={current:{version:'new',value:percentile}};
 expect(reconcileHeatSave(input,read)).toBe('unknown');
 expect(reconcileHeatSave(input,{...read,current:{version:'old',value:percentile}})).toBe('unchanged');
 expect(reconcileHeatSave(input,{...read,outcome:{kind:'saved',operationKey:'save',record:read.current}})).toBe('saved');
 expect(reconcileHeatSave(input,{...read,outcome:{kind:'saved',operationKey:'other',record:read.current}})).toBe('unknown');
 expect(reconcileHeatSave(input,{...read,outcome:{kind:'saved',operationKey:'save',record:{version:'x',value:absolute}}})).toBe('conflict');
});

import { scoringHeatV2,recentPercentileHeat } from '../dist/index.js';
test('Owner ruling: singleton/empty percentile never heat at gate0, absolute singleton positive may heat',()=>{
 const values={m20:{amount:2},h24:{amount:2},d7:{amount:2},lifetime:{amount:2}},ranks={m20:0,h24:0,d7:0};
 const config={...percentile,gates:{m20:0,h24:0,d7:0}};
 expect(scoringHeatV2(values,ranks,{m20:1,h24:1,d7:1},config)).toBeNull();
 expect(scoringHeatV2(values,ranks,{m20:0,h24:0,d7:0},config)).toBeNull();
 expect(scoringHeatV2(values,ranks,{m20:2,h24:2,d7:2},config)).toBe('on-fire');
 expect(scoringHeatV2(values,ranks,{m20:1,h24:1,d7:1},absolute)).toBe('on-fire');
 const projection={scores:values,scoreRanks:ranks};
 expect(recentPercentileHeat(projection,config.gates,{m20:{count:1},h24:{count:1},d7:{count:1}})).toBeNull();
 expect(recentPercentileHeat(projection,config.gates,{m20:{count:2},h24:{count:2},d7:{count:2}})).toBe('on-fire');
 expect(recentPercentileHeat(projection,config.gates)).toBeNull();
 expect(scoringHeatV2({...values,m20:{amount:0},h24:{amount:0},d7:{amount:0}},ranks,{m20:1,h24:1,d7:1},absolute)).toBeNull();
});
test('settings capability is additive, negotiated through existing describe, and registration refuses mismatch',async()=>{
 const {createFakePluginHost}=await import('@get-bb/plugin-sdk/testing');
 const {registerThreadMetricsOwner,createThreadMetricsClient}=await import('../dist/bb.js');
 const host=createFakePluginHost({pluginId:'heat-caps'});
 const legacy={capabilities:{summary:true,series:false,detail:false},read:async()=>({version:1,rows:[]})};
 try{
  expect(()=>registerThreadMetricsOwner(host.bb,{...legacy,capabilities:{...legacy.capabilities,heatSettingsV1:true}})).toThrow('mismatch');
  const port={read:async()=>({protocolVersion:1,current:{version:'cfg',value:percentile},published:{instance:'i',sequence:1,configVersion:'cfg'},writable:false,reason:'fixture'})};
  registerThreadMetricsOwner(host.bb,{...legacy,capabilities:{...legacy.capabilities,heatSettingsV1:true},heatSettings:port});
  const client=createThreadMetricsClient({plugins:{callRpc:a=>host.harness.behavior.callRpc(a.method,a.input)}},'heat-caps');
  expect((await client.describe()).capabilities.heatSettingsV1).toBe(true);
  expect((await client.read({threadIds:['x'],scope:'own'})).rows).toEqual([]);
 }finally{await host.harness.lifecycle.dispose();}
});

import { DEFAULT_SCORING_CONFIG_V3,prepareRootFamilyMigration,validateRootFamilyHeatConfig } from '../dist/index.js';
test('deliberate V2 domain migration preserves exact overrides and receipt bytes; V3 saves require explicit domain',()=>{
 const oldCanonical='{"schemaVersion":2,"mode":"percentile","providerWeights":{"claude-code":1,"codex":1},"gates":{"m20":0.83,"h24":0.91,"d7":0.9}}';
 expect(canonicalHeatConfig(percentile)).toBe(oldCanonical);
 for(const old of [percentile,absolute,DEFAULT_SCORING_CONFIG_V2]){
  const record={version:'legacy:1',value:old},before=JSON.stringify(record),migration=prepareRootFamilyMigration(record);
  expect(migration.kind).toBe('review');expect(migration.base).toBe(record);expect(migration.candidate.providerWeights).toEqual(old.providerWeights);
  expect(migration.candidate.mode==='percentile'?migration.candidate.gates:migration.candidate.thresholds).toEqual(old.mode==='percentile'?old.gates:old.thresholds);
  expect(JSON.stringify(record)).toBe(before);expect(validateRootFamilyHeatConfig(migration.candidate)).toEqual(migration.candidate);
 }
 const enabled={version:'legacy:lifetime',value:{...absolute,lifetimeEnabled:true}};expect(prepareRootFamilyMigration(enabled).kind).toBe('blocked');expect(enabled.value.lifetimeEnabled).toBe(true);
 const explicit=prepareRootFamilyMigration(enabled,{disableLifetime:true});expect(explicit.kind).toBe('review');expect(explicit.candidate.lifetimeEnabled).toBe(false);expect(explicit.candidate.thresholds).toEqual(absolute.thresholds);
 const req={protocolVersion:1,baseConfigVersion:'old',operationKey:'migrate',candidate:DEFAULT_SCORING_CONFIG_V3};expect(heatSettingsSaveInputSchema.parse(req)).toEqual(req);
 for(const candidate of [percentile,{...DEFAULT_SCORING_CONFIG_V3,domain:undefined},{...DEFAULT_SCORING_CONFIG_V3,domain:{version:1,kind:'root-family',extra:1}},{...DEFAULT_SCORING_CONFIG_V3,gates:{...DEFAULT_SCORING_CONFIG_V3.gates,extra:1}}])expect(()=>heatSettingsSaveInputSchema.parse({...req,candidate})).toThrow();
 expect(()=>prepareRootFamilyMigration({version:'old',value:{...percentile,providerWeights:{codex:4}}})).toThrow();
 const read={protocolVersion:1,current:{version:'legacy',value:percentile},published:{instance:'i',sequence:1,configVersion:'legacy'},writable:true,reason:null,migration:{kind:'domain-required',target:{version:1,kind:'root-family',future:'ok'},future:'ok'}};
 expect(heatSettingsReadResultSchema.parse(read).current.value).toEqual(percentile);
});
