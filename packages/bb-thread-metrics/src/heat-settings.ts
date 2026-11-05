import { z } from 'zod';
import { scoringConfigV2Schema,scoringConfigV3Schema,storedScoringConfigSchema,ROOT_FAMILY_HEAT_DOMAIN_V1 } from './recent.js';
import type { ScoringConfigV2,ScoringConfigV3,StoredScoringConfig } from './recent.js';

/** Settings authority remains ledger-owned. No storage, SDK or React imports. */
export const HEAT_SETTINGS_METHODS = Object.freeze({read:'threadMetricsHeatSettingsReadV1',save:'threadMetricsHeatSettingsSaveV1'});
export const HEAT_SETTINGS_LIMITS = Object.freeze({configBytes:16*1024,inputBytes:18*1024,outputBytes:40*1024,operationKeys:128});
const version = z.string().min(1).max(256);
const key = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const providerId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const weights = z.record(providerId,z.number().finite().min(0).max(3)).refine(v=>Object.keys(v).length<=32,'Too many provider weights');
const gates = z.object({m20:z.number().finite().min(0).max(1),h24:z.number().finite().min(0).max(1),d7:z.number().finite().min(0).max(1)}).strict();
const thresholds = z.object({m20:z.number().finite().min(0).max(1e6),h24:z.number().finite().min(0).max(1e6),d7:z.number().finite().min(0).max(1e6),lifetime:z.number().finite().min(0).max(1e6)}).strict();
/** Input is strict recursively; output scoringConfigV2Schema remains additive. */
const legacyHeatConfigInputSchema = z.discriminatedUnion('mode',[
 z.object({schemaVersion:z.literal(2),mode:z.literal('percentile'),providerWeights:weights,gates}).strict(),
 z.object({schemaVersion:z.literal(2),mode:z.literal('absolute'),providerWeights:weights,thresholds,lifetimeEnabled:z.boolean().optional()}).strict(),
]);
const domain=z.object({version:z.literal(1),kind:z.literal('root-family')}).strict();
export const heatConfigInputSchema=z.discriminatedUnion('mode',[
 z.object({schemaVersion:z.literal(3),domain,mode:z.literal('percentile'),providerWeights:weights,gates}).strict(),
 z.object({schemaVersion:z.literal(3),domain,mode:z.literal('absolute'),providerWeights:weights,thresholds,lifetimeEnabled:z.literal(false).optional()}).strict(),
]);
/** Byte-compatible V2 receipts; V3 canonicalization includes the domain. */
export function canonicalHeatConfig(value:StoredScoringConfig):string {
 const v=value.schemaVersion===2?legacyHeatConfigInputSchema.parse(value):heatConfigInputSchema.parse(value);
 return JSON.stringify({...v,providerWeights:Object.fromEntries(Object.entries(v.providerWeights).sort(([a],[b])=>a<b?-1:a>b?1:0)),...(v.mode==='absolute'?{lifetimeEnabled:v.lifetimeEnabled??false}:{})});
}
/** Stored legacy values are interpreted, never defaulted or migrated on read. */
export function validateHeatConfig(value:unknown):StoredScoringConfig {
 const parsed=bounded(z.union([legacyHeatConfigInputSchema,heatConfigInputSchema]),value,HEAT_SETTINGS_LIMITS.configBytes);
 if(new TextEncoder().encode(canonicalHeatConfig(parsed)).byteLength>HEAT_SETTINGS_LIMITS.configBytes)throw new Error('Config byte limit');
 return parsed;
}
export function validateRootFamilyHeatConfig(value:unknown):ScoringConfigV3 {
 return bounded(heatConfigInputSchema,value,HEAT_SETTINGS_LIMITS.configBytes);
}
export function prepareRootFamilyMigration(record:HeatConfigRecord,review?:{disableLifetime?:boolean}):
 {kind:'review';base:HeatConfigRecord;candidate:ScoringConfigV3}|{kind:'blocked';reason:string}{
 const value=validateHeatConfig(record.value);
 if(value.schemaVersion===3)return {kind:'review',base:record,candidate:value};
 if(value.mode==='absolute'&&value.lifetimeEnabled&&!review?.disableLifetime)return {kind:'blocked',reason:'Legacy lifetime heat is enabled. Explicitly review and disable that behavior before root-family migration; stored values were preserved.'};
 const candidate:ScoringConfigV3=value.mode==='percentile'
  ?{schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:value.mode,providerWeights:{...value.providerWeights},gates:{...value.gates}}
  :{schemaVersion:3,domain:ROOT_FAMILY_HEAT_DOMAIN_V1,mode:value.mode,providerWeights:{...value.providerWeights},thresholds:{...value.thresholds},lifetimeEnabled:false};
 return {kind:'review',base:record,candidate};
}
export const heatSettingsReadInputSchema=z.object({protocolVersion:z.literal(1),operationKey:key.optional()}).strict();
export const heatSettingsSaveInputSchema=z.object({protocolVersion:z.literal(1),baseConfigVersion:version,operationKey:key,candidate:heatConfigInputSchema}).strict();
export type HeatSettingsReadInput=z.infer<typeof heatSettingsReadInputSchema>;
export type HeatSettingsSaveInput=z.infer<typeof heatSettingsSaveInputSchema>;
export const heatConfigRecordSchema=z.object({version,value:storedScoringConfigSchema}).strip();
export type HeatConfigRecord=z.infer<typeof heatConfigRecordSchema>;
const observation=z.object({instance:version,sequence:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),configVersion:version.nullable()}).strip();
const outcome=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('saved'),operationKey:key,record:heatConfigRecordSchema}).strip(),
 z.object({kind:z.literal('conflict'),operationKey:key,record:heatConfigRecordSchema}).strip(),
 // Old keys may have been pruned. Absence never establishes non-execution.
 z.object({kind:z.literal('unknown'),operationKey:key}).strip(),
]);
export const heatSettingsReadResultSchema=z.object({protocolVersion:z.literal(1),current:heatConfigRecordSchema,published:observation,writable:z.boolean(),reason:z.string().max(512).nullable(),migration:z.object({kind:z.literal('domain-required'),target:z.object({version:z.literal(1),kind:z.literal('root-family')}).strip()}).strip().optional(),outcome:outcome.optional()}).strip();
export const heatSettingsSaveResultSchema=z.object({protocolVersion:z.literal(1),kind:z.enum(['saved','conflict']),operationKey:key,record:heatConfigRecordSchema,publicationPending:z.boolean()}).strip();
export type HeatSettingsReadResult=z.infer<typeof heatSettingsReadResultSchema>;
export type HeatSettingsSaveResult=z.infer<typeof heatSettingsSaveResultSchema>;
export interface HeatSettingsPort {
 read(input:HeatSettingsReadInput,signal?:AbortSignal):Promise<HeatSettingsReadResult>;
 save(input:HeatSettingsSaveInput,signal?:AbortSignal):Promise<HeatSettingsSaveResult>;
}
type ScoreWindow='m20'|'h24'|'d7'|'lifetime';
type RankWindow=Exclude<ScoreWindow,'lifetime'>;
/** Population counts belong to the same rank epoch/scope/config as ranks.
 * Owner ruling: singleton/empty percentile populations never heat, even gate0. */
export function scoringHeatV2(values:Record<ScoreWindow,{amount:number|null}>,ranks:Record<RankWindow,number|null>,population:Record<RankWindow,number>,config:ScoringConfigV2):'on-fire'|'hot'|'heavy'|null {
 legacyHeatConfigInputSchema.parse(config);
 for(const w of ['m20','h24','d7'] as const)if(!Number.isSafeInteger(population[w])||population[w]<0||ranks[w]!==null&&(!Number.isFinite(ranks[w])||ranks[w]!<0||ranks[w]!>1))throw new Error('Invalid heat rank population');
 for(const [w,label] of [['m20','on-fire'],['h24','hot'],['d7','heavy']] as const){
  const n=values[w].amount;
  if(n!==null&&Number.isFinite(n)&&n>0&&(config.mode==='absolute'?n>=config.thresholds[w]:population[w]>=2&&ranks[w]!==null&&ranks[w]!>=config.gates[w]))return label;
 }
 const n=values.lifetime.amount;
 return config.mode==='absolute'&&config.lifetimeEnabled&&n!==null&&Number.isFinite(n)&&n>0&&n>=config.thresholds.lifetime?'heavy':null;
}
export function bounded<T>(schema:z.ZodType<T>,value:unknown,maxBytes:number):T {
 const json=JSON.stringify(value);
 if(json===undefined||new TextEncoder().encode(json).byteLength>maxBytes)throw new Error('Heat settings byte limit');
 return schema.parse(value);
}
export function validateHeatSaveInput(value:unknown):HeatSettingsSaveInput {
 const input=bounded(heatSettingsSaveInputSchema,value,HEAT_SETTINGS_LIMITS.inputBytes);validateHeatConfig(input.candidate);return input;
}
/** Unknown outcomes require an operation receipt AND candidate agreement. Equality
 * alone cannot attribute another editor's write to this operation. */
export function reconcileHeatSave(input:HeatSettingsSaveInput,read:HeatSettingsReadResult):'saved'|'unchanged'|'conflict'|'unknown' {
 const o=read.outcome;
 if(o?.operationKey===input.operationKey&&o.kind==='saved')return canonicalHeatConfig(o.record.value)===canonicalHeatConfig(input.candidate)?'saved':'conflict';
 if(o?.operationKey===input.operationKey&&o.kind==='conflict')return 'conflict';
 return read.current.version===input.baseConfigVersion?'unchanged':'unknown';
}
