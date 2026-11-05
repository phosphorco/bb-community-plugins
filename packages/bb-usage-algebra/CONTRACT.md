# Usage algebra v1

| Consumer owns | Package owns |
| --- | --- |
| Observation, session/epoch identity, ordered event sequence, coverage | Disjoint vector codec and pure arithmetic |
| Storage, retention, model attribution, operator rates | Counter increments, bucket/window arithmetic, rate schema and matching |
| Invoice interpretation and user presentation | Explicit normalization and approximation metadata |

## Normalization

Vectors contain four finite, nonnegative, disjoint numeric classes. Fractional
values are permitted. Component sum is associative/commutative up to floating
point precision, with zero identity; arithmetic overflow is rejected. Reasoning
is part of output. totalTokens is advisory and never added. Pass precisely one
breakdown, normally `snapshot.total`, never a `{total,last}` envelope. The codec
strips unknown fields for forwards compatibility; invalid numeric fields fail.
Missing input/output classes become zero observed with `complete:false`. If all
three cache observations (aggregate/read/write) are absent, cache classes are
zero observed and `complete:false`, even for known translators. Claude/Pi require
both explicit cache read and write observations for completeness, regardless of
aggregate presence or value. Their translators can synthesize aggregate by
turning missing split classes into zero, so even aggregate0 or aggregate plus
one class does not prove both classes were observed. Explicit read0/write0 is
complete; aggregate-only and aggregate-plus-single-class reconstruction remains
available as an approximate vector with issues and is never a comparable
complete baseline. Codex aggregate aliases reads only: a complete cache observation
requires an explicit read or aggregate, plus an explicit write (zeros valid). Zero
observed never proves zero billed. An entirely unclassified breakdown yields
null; a total or reasoning field cannot establish billable classes.

Verified against BB translators on 2026-10-27:

- `fork/build/bb/plugins/provider-claude-code/src/sdk-extraction.ts`:
  ordinary input excludes cache; cached aggregate is reads+writes.
- `fork/build/bb/plugins/provider-pi/src/delta-translation.ts`:
  same disjoint input convention; extracts only the last assistant message.
- `fork/build/bb/plugins/provider-codex/src/delta-translation.ts`:
  input includes cache, cachedInputTokens aliases cacheReadInputTokens. Output
  already includes reasoning. Codex cache-write classes, if present, are
  subtracted along with read from inclusive input.

Claude/Pi missing cache split is inferred from aggregate minus known class;
aggregate alone is assigned to reads with explicit approximation issues.
Every inferred split, including inferred zero, is incomplete.
Conflicting explicit cache classes win, with an issue. Codex explicit read wins
over its aggregate alias. Its generated app-server
`schema/v2/TokenUsageBreakdown.ts` requires `cacheWriteInputTokens`; BB translator
conditionally forwarding this field for compatibility does not guarantee that
absence means structural zero. Missing Codex writes therefore remain incomplete,
even with an explicit zero cached aggregate. A missing read/aggregate is likewise
incomplete. No provider structural-zero write guarantee is assumed. Inclusive cache exceeding an actually present input budget is capped read-first
with an issue; this never fabricates extra input. Missing input does not erase
observed cache classes; these survive with incomplete metadata. Unknown providers conservatively
assume inclusive input and disclose approximation. A caller with verified
semantics can explicitly supply `inputSemantics`. Provider aliases accepted:
`claude-code`, `claude`, `codex`, `pi` and their `provider-` prefixes. No context
occupancy or background-task usage is accepted as billable totals.

## Counters and windows

Persist returned state atomically with increments/checkpoint. Counter checkpoint
and accepted baseline must outlive bucket pruning: removing retained buckets
must never drop counter state and cause a cumulative snapshot to be counted
again as initial. Sequence is a
nonnegative safe integer from one globally ordered event stream, including across
epoch changes. Same sequence is duplicate (even differing payload); lower is
stale. Both produce zero and retain prior state. Higher sequence with same epoch
subtracts components. Any component regression starts an inferred new epoch and
counts the entire new vector (`regression-reset`); this is deliberately explicit:
a partial correction can overestimate and must downgrade consumer coverage.
Completeness is necessary but does not establish comparability: even two fully
observed split vectors can reflect a cache reclassification/correction rather
than a reset. The emitted tests show that raw regression-reset would count the
whole second vector in this case; consumers own provenance checks and coverage.
Only comparable, complete canonical observations may be used as counter
baselines. Reject incomplete observations as baselines and retain the last
accepted state (while recording a coverage limitation). For example, complete A,
cache-missing B, complete C in one epoch must fold A to C, skipping B; otherwise
zero-observed cache classes can create a false regression and double counting.
A change in normalization mode or inferred cache reclassification is not
evidence of a provider reset: consumers must reconcile comparable classes or
mark coverage uncertain rather than blindly applying whole-vector regression
detection across that change. The raw counter API takes vectors and cannot
verify canonicalization provenance; its reset semantics are unchanged.
A changed epoch also counts the new total. Initial total is counted once, but its
time distribution before observation is unknown. Identical totals at higher
sequences produce zero. Missing epochs, resets to equal/larger totals, and pruned
history cannot be detected here. Callers must track epoch identity and gaps.

Buckets are fixed 300,000ms UTC Unix intervals, floor(timestamp / width).
Window sum includes the last ceil(duration / 300,000) bucket starts through
floor(now), including the current bucket and excluding future ones. Thus 20m
contains four buckets and 24h contains at most 288. Fixed aligned windows can
under-cover their cutoff by less than five minutes; exact within-bucket timing
cannot be recovered. At an exact boundary the new current bucket is included
and the oldest bucket is excluded. A zero window
is empty. Inputs must be nonnegative safe integer milliseconds, bucket starts
aligned. Duplicate bucket rows are additive; caller owns grouping and unique
storage keys. Lifetime is a separately maintained vector, never inferred from
retained buckets. No retention policy runs in this package.

## Pricing

Schema version 1 is independent of package version. A table has a version,
USD currency, bounded rates (512), finite/nonnegative per-million rates for every
class, source URL/date/notes, unique IDs and provider/model aliases, and an
explicit nullable defaultRateId. No executable patterns. Matching is exact model,
explicit alias, nearest same-provider model by case-folded Levenshtein distance
(lexical rate-ID tie break), explicit table default, then null as last resort.
A missing model ID uses the explicit default. `codex` aliases provider `openai`;
`claude-code`/`claude` aliases `anthropic`. Pi model ownership is not inferred:
provide the actual upstream provider where known or accept explicit default.
Nearest/default matches return `approximate:true` and a reason. Individual rates
can also declare `approximate:true` (including the seed rates with unlisted
cache-write prices); this propagates even for exact model matches. All results are
`estimated:true`, including exact list-price matches. Source notes disclose
rate scope; model exactness does not prove billing precision.

At a fixed model/rate, price(v+w) = price(v)+price(w), within floating precision.
Group by provider/model before pricing; never price a mixed-model vector at one
rate. Do not round intermediate amounts; rendering owns currency formatting.
Rates remain caller-owned data. Seed import has no fetch or clock dependency.

Seed verified **2026-10-27**, standard text pricing, short contexts:

- [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing):
  first-party standard input/output, cache reads and 5-minute writes.
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing):
  standard short-context rates, 30-minute writes where listed. gpt-5.3-codex
  cache-write rate is unlisted; ordinary input is an explicit approximation.
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing):
  Gemini 2.5 Pro text prompts <=200k; input rate approximates cache writes.

The explicit cross-provider fallback is Sonnet 4.6, a policy choice, not a
provider's advertised default. Long context, cache duration, cache storage,
fast/flex/batch, regional uplifts, tools, multimodal fees, subscription allocation
and unreported requests are outside the four-class seed. Correct operator rates
can replace it. No pricing accuracy claim extends beyond the cited text tier.

## Proof limits

Emitted-entry tests cover monoid/linearity invariants, realistic normalized
translator fixtures, missing/inconsistent fields, duplicate/stale/reset epochs,
bucket boundaries and deterministic rate fallback. Packed declarations are
checked by a TS consumer. No live provider billing reconciliation is claimed.
Unknown upstream Codex reset semantics, Pi tool-loop completeness and overlapping
Claude background-task usage remain consumer coverage limitations.
