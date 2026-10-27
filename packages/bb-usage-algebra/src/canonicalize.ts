import { z } from 'zod';
import type { UsageVector } from './vector.js';

export const TokenBreakdownSchema = z.object({
  inputTokens: z.number().finite().nonnegative().optional(),
  outputTokens: z.number().finite().nonnegative().optional(),
  cachedInputTokens: z.number().finite().nonnegative().optional(),
  cacheReadInputTokens: z.number().finite().nonnegative().optional(),
  cacheWriteInputTokens: z.number().finite().nonnegative().optional(),
  totalTokens: z.number().finite().nonnegative().optional(),
  reasoningOutputTokens: z.number().finite().nonnegative().optional(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdownSchema>;
export type InputSemantics = 'inclusive' | 'exclusive';
export interface CanonicalUsage { vector: UsageVector | null; complete: boolean; issues: string[] }

/** Accept one breakdown (normally snapshot.total), never the total+last envelope. */
export function canonicalize(providerId: string, breakdown: TokenBreakdown,
  options: { inputSemantics?: InputSemantics } = {}): CanonicalUsage {
  const b = TokenBreakdownSchema.parse(breakdown);
  const issues: string[] = [];
  const provider = providerId.replace(/^provider-/, '');
  const known = provider === 'claude-code' || provider === 'claude' || provider === 'pi'
    ? 'exclusive' : provider === 'codex' ? 'inclusive' : undefined;
  const semantics = options.inputSemantics ?? known ?? 'inclusive';
  if (!known && !options.inputSemantics) issues.push('unknown-provider: assumed inclusive input; conservative approximation');
  for (const field of ['inputTokens', 'outputTokens'] as const)
    if (b[field] === undefined) issues.push(`missing-${field}: zero observed`);
  if (b.inputTokens === undefined && b.outputTokens === undefined && b.cachedInputTokens === undefined && b.cacheReadInputTokens === undefined && b.cacheWriteInputTokens === undefined)
    return { vector: null, complete: false, issues: [...issues, 'no-billable-class-observed: total/reasoning cannot supply disjoint classes'] };
  if (b.cachedInputTokens === undefined && b.cacheReadInputTokens === undefined && b.cacheWriteInputTokens === undefined)
    issues.push('missing-cache-observations: zero observed, not a complete counter baseline');
  let read = b.cacheReadInputTokens;
  let write = b.cacheWriteInputTokens;
  if (provider === 'codex') {
    // Codex cachedInputTokens aliases reads; it says nothing about writes.
    if (b.cachedInputTokens === undefined && b.cacheReadInputTokens === undefined)
      issues.push('missing-cacheReadInputTokens: zero observed, not a complete counter baseline');
    if (b.cacheWriteInputTokens === undefined)
      issues.push('missing-cacheWriteInputTokens: zero observed, not a complete counter baseline');
    read ??= b.cachedInputTokens ?? 0;
    write ??= 0;
    if (b.cachedInputTokens !== undefined && read !== b.cachedInputTokens)
      issues.push('cache-alias-mismatch: explicit read wins');
  } else {
    // Claude/Pi aggregate cachedInputTokens includes BOTH read and write.
    // Translators can synthesize aggregate with missing split classes treated as zero.
    // Therefore even aggregate=0 cannot attest that both classes were observed.
    if (b.cacheReadInputTokens === undefined)
      issues.push('missing-cacheReadInputTokens: aggregate reconstruction is approximate, not a complete counter baseline');
    if (b.cacheWriteInputTokens === undefined)
      issues.push('missing-cacheWriteInputTokens: aggregate reconstruction is approximate, not a complete counter baseline');
    if (b.cachedInputTokens !== undefined) {
      if (read === undefined && write === undefined) {
        read = b.cachedInputTokens; write = 0;
        if (read > 0) issues.push('cache-split-missing: aggregate assigned to read approximation');
      } else if (read === undefined) read = Math.max(0, b.cachedInputTokens - (write ?? 0));
      else if (write === undefined) write = Math.max(0, b.cachedInputTokens - read);
      if ((read ?? 0) + (write ?? 0) !== b.cachedInputTokens)
        issues.push('cache-aggregate-mismatch: explicit classes win');
    }
    read ??= 0; write ??= 0;
  }
  let input = b.inputTokens ?? 0;
  if (semantics === 'inclusive' && b.inputTokens !== undefined) {
    if (read + write > input) {
      // Keep observed input budget disjoint even for inconsistent snapshots.
      issues.push('cache-exceeds-inclusive-input: cache classes capped to input');
      read = Math.min(read, input); write = Math.min(write, input - read);
    }
    input = Math.max(0, input - read - write);
  }
  return { vector: {inputUncached: input, cacheRead: read, cacheWrite: write, output: b.outputTokens ?? 0}, complete: issues.length === 0, issues };
}
