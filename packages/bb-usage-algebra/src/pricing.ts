import { z } from 'zod';
import { UsageVectorSchema, USAGE_CLASSES } from './vector.js';
import type { UsageVector } from './vector.js';
const id = z.string().min(1).max(256);
export const RateSchema = z.object({
  id, providerId: id, modelId: id, aliases: z.array(id).max(64).default([]),
  usdPerMillion: UsageVectorSchema,
  approximate: z.boolean().default(false),
  sourceUrl: z.url(), verifiedAt: z.iso.date(), notes: z.string().max(4000),
});
export type ModelRate = z.infer<typeof RateSchema>;
export const RateTableSchema = z.object({
  schemaVersion: z.literal(1), version: id, currency: z.literal('USD'),
  rates: z.array(RateSchema).max(512), defaultRateId: id.nullable(),
}).superRefine((table, ctx) => {
  const ids = new Set<string>();
  for (const rate of table.rates) {
    if (ids.has(rate.id)) ctx.addIssue({code: 'custom', message: 'duplicate rate id'});
    ids.add(rate.id);
  }
  if (table.defaultRateId !== null && !ids.has(table.defaultRateId)) ctx.addIssue({code:'custom', message:'defaultRateId must reference a rate'});
  const keys = new Set<string>();
  for (const rate of table.rates) for (const model of [rate.modelId, ...rate.aliases]) {
    const key = JSON.stringify([providerKey(rate.providerId), model]);
    if (keys.has(key)) ctx.addIssue({code:'custom', message:'ambiguous provider/model alias'});
    keys.add(key);
  }
});
export type RateTable = z.infer<typeof RateTableSchema>;
export interface RateMatch { rate: ModelRate | null; approximate: boolean; reason: 'exact' | 'alias' | 'nearest-provider-model' | 'explicit-default' | 'no-rate' }
function providerKey(id: string): string {
  const p = id.toLowerCase().replace(/^provider-/, '');
  return p === 'claude-code' || p === 'claude' ? 'anthropic' : p === 'codex' ? 'openai' : p;
}
function distance(a: string, b: string): number {
  let row = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length]!;
}
/** Levenshtein distance over bounded model IDs, lexical rate-ID tie break.
 * No remote lookup, untrusted regex, or dependence on input table order. */
export function matchRate(table: RateTable, providerId: string, modelId: string | null): RateMatch {
  const parsed = RateTableSchema.parse(table);
  id.parse(providerId); if (modelId !== null) id.parse(modelId);
  const candidates = parsed.rates.filter(r => providerKey(r.providerId) === providerKey(providerId)).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const exact = candidates.find(r => r.modelId === modelId);
  if (exact) return {rate: exact, approximate: exact.approximate, reason:'exact'};
  const alias = candidates.find(r => modelId !== null && r.aliases.includes(modelId));
  if (alias) return {rate: alias, approximate: alias.approximate, reason:'alias'};
  if (modelId !== null && candidates.length) {
    const nearest = candidates.map(rate => ({rate, distance: distance(modelId.toLowerCase(), rate.modelId.toLowerCase())})).sort((a,b) => a.distance - b.distance || (a.rate.id < b.rate.id ? -1 : 1))[0]!;
    return {rate: nearest.rate, approximate:true, reason:'nearest-provider-model'};
  }
  const fallback = parsed.rates.find(r => r.id === parsed.defaultRateId);
  return fallback ? {rate:fallback, approximate:true, reason:'explicit-default'} : {rate:null, approximate:true, reason:'no-rate'};
}
export interface PriceEstimate extends RateMatch { amount: number | null; currency: 'USD'; estimated: true; priceVersion: string }
/** Linear at a fixed matched rate; aggregate vectors by provider/model before pricing. */
export function price(table: RateTable, providerId: string, modelId: string | null, vector: UsageVector): PriceEstimate {
  const v = UsageVectorSchema.parse(vector);
  const match = matchRate(table, providerId, modelId);
  const amount = match.rate ? USAGE_CLASSES.reduce((sum, key) => sum + (v[key] / 1_000_000) * match.rate!.usdPerMillion[key], 0) : null;
  if (amount !== null && !Number.isFinite(amount)) throw new RangeError('price overflow');
  return {...match, amount, currency:'USD', estimated:true, priceVersion:table.version};
}
