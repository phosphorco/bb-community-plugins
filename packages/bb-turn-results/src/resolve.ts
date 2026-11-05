import { canonicalJson, canonicalByteLength, LIMITS, resolveOutcomeBudget } from './bounds.js';
import { decodeInput, decodeOutput, ResolveInputSchema, ResolveOutputSchema, OutputSchemas } from './schemas.js';
import { identityDigest, ResultsContractError } from './identity.js';
import type { Resolution, ResolveInput, ResolveOutput, ResolveOutcome } from './types.js';

export type ProposedResolveOutcome = { state: 'resolved'; value: Resolution } | { state: 'unavailable' | 'unrecognized'; reason: string };
function fail(message: string): never { throw new ResultsContractError('incompatible', message); }

/** Source-side exact response admission. No cursor, I/O, retries or external effects. */
export async function buildResolveOutput(request: ResolveInput, entries: readonly ProposedResolveOutcome[], envelopeExtras: Record<string, unknown> = {}): Promise<ResolveOutput> {
  const input = decodeInput(ResolveInputSchema, request);
  if (entries.length !== input.items.length) fail('Resolve must return exactly one outcome per request.');
  if (Object.hasOwn(envelopeExtras, 'resolutions')) fail('Envelope metadata cannot replace outcomes.');
  const resolutions: ResolveOutcome[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    // Validate JSON without copying large optional enrichment. The byte counter
    // measures an oversized proposal without materializing its JSON string.
    canonicalByteLength(entry, Number.MAX_SAFE_INTEGER);
    const correlation = { requestIndex: i, identityDigest: await identityDigest(input.items[i]!) };
    let outcome: ResolveOutcome;
    if (entry.state === 'resolved') {
      const parsed = OutputSchemas.resolution.parse(entry.value);
      if (canonicalJson(parsed.identity) !== canonicalJson(input.items[i])) fail('Resolved identity differs from request.');
      // Normalize identity once, retaining additive nonidentity enrichment on wire.
      const proposed = { ...correlation, state: 'resolved' as const, value: { ...entry.value, identity: input.items[i]! } };
      const neededBytes = canonicalByteLength(proposed, Number.MAX_SAFE_INTEGER);
      outcome = neededBytes > resolveOutcomeBudget(1)
        ? { ...correlation, state: 'oversized', reason: 'resolved-entry-over-cap', neededBytes }
        : neededBytes > input.maxOutcomeBytes
          ? { ...correlation, state: 'budget-deferred', neededBytes }
          : proposed;
    } else {
      outcome = OutputSchemas.resolveOutcome.parse({ ...entry, ...correlation }) as ResolveOutcome;
    }
    const bytes = canonicalByteLength(outcome, input.maxOutcomeBytes);
    if (outcome.state !== 'resolved' && bytes > LIMITS.compactOutcomeBytes) fail('Compact outcome exceeds reserved bound.');
    resolutions.push(outcome);
  }
  const output = { ...envelopeExtras, resolutions };
  const bytes = canonicalByteLength(output, LIMITS.responseBytes);
  const outcomesBytes = resolutions.reduce((sum, item) => sum + canonicalByteLength(item), 0);
  if (bytes - outcomesBytes > LIMITS.resolveEnvelopeBytes) fail('Resolve envelope exceeds its reservation.');
  return output;
}

/** Client-side raw admission happens BEFORE additive fields are decoded/ignored. */
export async function correlateResolveOutput(request: ResolveInput, raw: unknown): Promise<ResolveOutput> {
  const input = decodeInput(ResolveInputSchema, request);
  canonicalByteLength(raw, LIMITS.responseBytes);
  if (!raw || typeof raw !== 'object' || !('resolutions' in raw) || !Array.isArray(raw.resolutions)) fail('Missing outcomes.');
  const rawOutcomes = raw.resolutions as unknown[];
  let charged = 0;
  for (const item of rawOutcomes) {
    const bytes = canonicalByteLength(item, input.maxOutcomeBytes);
    charged += bytes;
    if (!item || typeof item !== 'object' || !('state' in item)) fail('Malformed outcome.');
    if (item.state !== 'resolved' && bytes > LIMITS.compactOutcomeBytes) fail('Compact outcome exceeds reservation.');
  }
  if (canonicalByteLength(raw) - charged > LIMITS.resolveEnvelopeBytes) fail('Envelope exceeds reservation.');
  const output = decodeOutput(ResolveOutputSchema, raw);
  if (output.resolutions.length !== input.items.length) fail('Missing/extra correlated outcome.');
  const seen = new Set<number>();
  const digests = await Promise.all(input.items.map(identityDigest));
  for (const outcome of output.resolutions) {
    const index = outcome.requestIndex;
    if (index >= input.items.length || seen.has(index) || outcome.identityDigest !== digests[index]) fail('Foreign/duplicate index or digest.');
    seen.add(index);
    if (outcome.state === 'resolved' && canonicalJson(outcome.value.identity) !== canonicalJson(input.items[index])) fail('Resolved identity differs from complete request.');
    if (outcome.state === 'budget-deferred' && (input.items.length === 1 || outcome.neededBytes <= input.maxOutcomeBytes)) fail('Deferral cannot progress from this budget.');
  }
  return output as ResolveOutput;
}
