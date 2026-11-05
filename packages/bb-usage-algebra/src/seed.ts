import { RateTableSchema } from './pricing.js';
import type { ModelRate } from './pricing.js';
const verifiedAt = '2026-10-27';
const anthropic = 'https://platform.claude.com/docs/en/about-claude/pricing';
const openai = 'https://developers.openai.com/api/docs/pricing';
function rate(providerId: string, modelId: string, inputUncached: number, cacheRead: number, cacheWrite: number, output: number, sourceUrl: string, notes: string): ModelRate {
  return {approximate: modelId === 'gpt-5.3-codex' || modelId === 'gemini-2.5-pro', id:`${providerId}/${modelId}`, providerId, modelId, aliases:[], usdPerMillion:{inputUncached,cacheRead,cacheWrite,output},sourceUrl,verifiedAt,notes};
}
const claudeNotes = 'Standard first-party text list price; 5-minute cache writes. Longer cache TTL, batch, regions, tools and other charges excluded.';
const openaiNotes = 'Standard short-context text list price; 30-minute cache writes where published. Service tier, long context, tools and other charges excluded. Unknown tier remains an estimate.';
/** Operator-editable seed, not invoices or a live pricing service. */
export const DEFAULT_RATE_TABLE = RateTableSchema.parse({
  schemaVersion:1, version:'seed-2026-10-27-v1', currency:'USD',
  defaultRateId:'anthropic/claude-sonnet-4-6',
  rates:[
    rate('anthropic','claude-fable-5-1',10,0.25,12.5,50,anthropic,claudeNotes),
    rate('anthropic','claude-opus-5-5',4,0.2,5,20,anthropic,claudeNotes),
    rate('anthropic','claude-sonnet-5-5',2,0.1,2.5,10,anthropic,claudeNotes),
    rate('anthropic','claude-opus-4-6',5,0.5,6.25,25,anthropic,claudeNotes),
    rate('anthropic','claude-opus-4-5',5,0.5,6.25,25,anthropic,claudeNotes),
    rate('anthropic','claude-sonnet-4-6',3,0.3,3.75,15,anthropic,claudeNotes),
    rate('anthropic','claude-sonnet-4-5',3,0.3,3.75,15,anthropic,claudeNotes),
    rate('anthropic','claude-haiku-4-5',1,0.1,1.25,5,anthropic,claudeNotes),
    rate('openai','gpt-6-astra',10,1,12.5,50,openai,openaiNotes),
    rate('openai','gpt-6.1-sol',2,0.1,2.5,10,openai,openaiNotes),
    rate('openai','gpt-6.1-terra',1,0.05,1.25,5,openai,openaiNotes),
    rate('openai','gpt-6-luna',0.1,0.01,0.125,0.5,openai,openaiNotes),
    rate('openai','gpt-5.3-codex',1.75,0.175,1.75,14,openai,openaiNotes+' Cache writes unlisted; use ordinary input as explicit approximation.'),
    rate('google','gemini-2.5-pro',1.25,0.125,1.25,10,'https://ai.google.dev/gemini-api/docs/pricing','Standard text, prompts <=200k; cache writes use input approximation. Cache storage/hour, long context, grounding excluded.'),
  ],
});
