# Thread metrics wire v1 (@phosphorco/bb-thread-metrics 0.1.0)

| Supplier owns | Package owns | Host owns |
| --- | --- | --- |
| Ledger, edge index, pricing data, observation/retention, source coverage and revisions | Bounded DTOs, dual-edge closure, dollar percentile/heat, fixed RPC, injected adapters and conformance | Discovery triggers, demand batching, caching, navigation, thread panel rendering and recovery |

The package is pure data and transport, without storage, collectors, pricing seeds,
React, polling or lifecycle scheduling. Root uses Zod and the seed-free algebra
`/vector` entry. `/bb` accepts injected SDK objects; `/testing` exercises real
registered handlers on the SDK fake host.

## API sketch (cross-lane alignment)

- `familyClosure(edges, roots, policy?)`: union of parent and lifecycle-owner
  links, reflexive, cycle/diamond safe, hidden always included, archived default
  true, deleted excluded. Explicit input/member/depth caps and coverage reasons.
- `dollarPercentiles(population)`: per-window host-wide active dollar
  population (finite positive amounts only); ties use strict-lower-count / (N-1).
  Singleton and all-equal populations rank 0; no median mark. Zero, unknown and
  inactive get null. `heat(ranks)` gates m20/on-fire, h24/hot, d7/heavy at >=0.9.
- `threadMetricsDescribe({})`: `{protocol:'bb-thread-metrics',versions:[1],
  capabilities:{summary:true,series:boolean,detail:boolean}}`. Negotiate envelope
  before decoding v1 capabilities; unknown output fields tolerated.
- `threadMetricsReadV1({threadIds,scope,includeArchived?,knownRevisions?,
  series?:{activeThreadId,maxPoints}})` <=200 unique IDs. A single active ID may
  request last-24h buckets, <=288. Summary rows never contain descendant records.
- `threadMetricsDetailV1({threadId,scope,includeArchived?,axis,window,cursor?,limit?})`
  is optional, explicitly on demand. Axis `model|time`; bounded rows,
  optional nextCursor, total and coverage metadata. No summary fanout.

Every summary row has threadId/scope/memberCount/coverage/coverageReasons/asOf/
revision/priceVersion/currency:'USD'/estimated:true/approximation/ranks. Changed
rows add windows `{m20,h24,d7,lifetime}` of `{tokens:UsageVector,amount:number|null}`;
unchanged rows omit windows but still carry current metadata and ranks. Revisions
must fingerprint scope/archive policy/window content/series demand; a producer
may return unchanged only for a matching known revision. Consumers merge the
fresh metadata even when unchanged. Price corrections and sliding windows must
invalidate content revisions. Approximation has bounded reasons and optional
provider/model/rate attribution (matched, closest-model, provider-default,
unpriced); missing price is last resort. Provider reported costs remain separate.

Inputs are strict and byte bounded; outputs strip additive fields and enforce
byte bounds before decoding. Suppliers echo only requested IDs once each; missing
IDs are partial coverage, never implicit zero. Detail rows reconcile to the stated
total only when complete; pagination and row limits are explicit. USD ranks must
be computed from the host-wide dollar population using the same scope and archived
policy, never token totals or the visible/requested set. Shared descendants count
once per root. Overlap across separate family roots is comparative data and must
never be summed into host spend. Ranks carry population asOf/count metadata per window.

Discovery lists once, deduplicates target IDs, probes bounded candidates using
bounded concurrency, per-call and overall deadlines. Aborting a probe does not
release its slot until its actual SDK promise settles. A deadline ends the pass;
late results cannot publish. Failures are independent, keyed by target plugin ID.
Mount/refresh/reconnect/plugin-lifecycle triggers belong to the consumer; no poll.

## Wire details and producer obligations

Timestamps are Unix milliseconds, finite safe nonnegative integers. Revisions
and price versions are nonempty strings <=256 characters. Thread/provider IDs
are <=200 characters, begin alphanumeric and contain only letters, digits,
underscore, period, colon or hyphen. Model and rate IDs are <=256 characters.
Amounts are finite nonnegative USD values or null. Null is unknown, never zero;
null estimates require `missing-price` approximation provenance. `reported`
uses its own currency and timestamp and is never added to estimated amounts.

Coverage is `complete|partial|unknown`; closed reasons are `source-gap`, `root-unattested`,
`history-unavailable`, `member-cap`, `depth-cap`, `edge-cap`, `missing-thread`,
`unpriced`, `retention`, `row-cap`, `pagination`, `population-incomplete`.
Approximation reasons are `closest-model`, `provider-default`,
`model-attribution`, `bucket-boundary`, `missing-price`, `source-gap`.
Nonempty approximation reasons or unmatched rate attribution require the
`approximate` flag. Each summary carries <=32 rate attribution records, not an
unbounded catalog; a supplier may omit that optional list while retaining reasons.

Family closure scans <=50,000 edge records and emits <=10,000 members to depth
<=256. Policy may lower each cap; it may never increase a package bound. Roots
are <=200. Duplicate edge identities are invalid. A missing root downgrades
coverage and contributes no invented member. Archived nodes remain traversable
when excluded from membership, so a live grandchild remains reachable. Deleted
nodes and traversal through them are excluded. Family results are traversal-order
arrays and callers must not infer rank from their order. Source completeness is
an explicit policy input: a complete closure only proves the supplied snapshot.

Dollar population input is explicitly supplied, one amount per distinct thread.
Amounts must match the requested scope/archive policy at a common snapshot.
Unknown and zero-dollar threads receive null rank and do not enter the active
priced population. For N positive known-dollar threads, rank is the number of
strictly lower amounts divided by N-1; N=1 yields zero. Thus equal peers share
rank, an all-equal population ranks zero, a unique maximum ranks one, and a
median thread receives no default heat. Unknown-priced active threads mean
population coverage is incomplete and must be disclosed. Per-window
`rankPopulation` contains priced-active count, asOf and coverage. The consumer
may suppress heat on incomplete coverage without replacing null dollars with zero.

Summary output is `{version:1,rows}`. Read omissions mean unavailable data;
consumers retain prior values as stale or show unavailable. An omitted row is
never zero spend. A changed row carries windows and optionally buckets;
unchanged carries current metadata/ranks only. Recognized `windows` or `buckets`
content is rejected on unchanged rows before output stripping, even if series was
requested. Truly unknown additive output fields are stripped. With no series requested the registration adapter strips no known
bucket field silently: it rejects it. The supplier must avoid computing raw
breakdowns for summaries; no descendant/model detail field exists in that DTO.
Buckets have aligned five-minute starts in the last 288 fixed buckets including
the current bucket at asOf, are strictly increasing, never future, and never
exceed the requested point count. Null bucket dollars require top-level
`missing-price` approximation provenance, including when all windows are priced. The input explicitly names
one active requested thread. The package cannot independently verify UI focus.

Known revisions are bounded by requested IDs and must refer to content for that
exact scope/archive/series projection. Ingest revision alone is insufficient:
the revision MUST change with every input capable of changing membership or
sums: rolling-window/bucket expiry, rate table generation, scope/archive/series
policy, edge/index revision, membership evidence and retention all participate.
A change to an input must change revision even if the current numeric sum happens
to remain equal. A source unable to establish this revision must disclose unknown
coverage and cannot safely reuse a known revision for an unchanged answer. An unchanged answer still updates asOf,
coverage, approximation and rank metadata in the consumer cache. Suppliers must
compare cheap projection revisions before expensive aggregation; the package
validates the echoed revision and shape but cannot inspect supplier storage or
prove that comparison cost.

Detail outputs echo thread/scope/axis/window and include asOf, revision,
priceVersion, currency, estimated, coverage, approximation, total, rows and an
optional nextCursor. Rows carry tokens, amount and approximation, plus either
providerId/modelId or start/end. Limits default to 200; cursors <=1024
characters. Identities are unique per page. Complete unpaginated detail must
reconcile all four vector components and dollars to total (relative tolerance
1e-8); null row dollars require a null total. A null detail total always requires
top-level `missing-price` approximation provenance, even on partial/unknown pages
with no rows. Pagination must disclose partial
coverage. Total describes the whole requested projection, not just the page.
Across pages the supplier must keep one revision stable or reject/restart its
cursor. Consumers must dedup page identities and discard mixed revisions.
Model rows aggregate by provider/model after deduplicating family members; time
rows partition the requested retained window without overlap. Sparse unoccupied
gaps are allowed and never imply invented spend. Source
observation/model/bucket uncertainty remains in coverage/approximation.

## Runtime adapters and admission

`registerThreadMetricsOwner(bb, port)` registers strict byte-admitted input
schemas and validates all responses. Port has capabilities, async read, and
optional async detail; detail capability must match the handler. Describe/read
are always registered; detail is registered only when supported. All use
`experimental_discoverable:true`; no experimental discovery endpoint is called.
SDK imports in `/bb` are type-only. Public SDK server and browser types are
accepted by client and discovery helpers.

`createThreadMetricsClient(sdk, pluginId)` binds every call to that target.
Describe negotiates wire 1 (highest shared supported wire version) before decoding
capabilities. Fixed read/detail methods are v1; discovery must precede consumer
use and optional capabilities must be honored. Native errors are classified:
404/unknown_method -> absent; 503 -> disabled; AbortError -> aborted;
TimeoutError -> timeout; ZodError -> malformed; other faults -> failed.

`createThreadMetricsDiscovery(sdk)` is one retained per-mounted-coordinator
resource. Its `discover(options?)` lists once and probes only running/degraded
plugins, deduped by target ID. It examines <=10,000 listed entries, probes <=128
candidates, with <=4 actual outstanding probe reads, <=2000ms per probe and a
<=5000ms overall deadline. Options can lower all budgets. Truncated/unstarted
candidates are counted in omittedCount and complete is false. This bounds work
after the SDK list materializes; the SDK owns list transport bytes and its native
list response is already materialized before this package can inspect it.

A local probe timeout aborts its signal and publishes timeout, but its lane stays
occupied until the actual promise settles. Overall deadline returns a result and
suppresses late publication. The coordinator tracks actual list/probe settlement
across passes, exposing `outstandingReads`. A new pass while running or draining
returns `listError:'busy'` and performs no I/O. Consumers must retain the same
coordinator over refresh/reconnect; recreating one bypasses admission. There is
no global registry or singleton, no automatic retry, queue or poll. Abort stops
publication, and failures remain per-target; callback faults do not discard
other target results. A genuinely unresponsive SDK leaves this coordinator busy
until that SDK read settles; this is honest backpressure, not proof of remote
cancellation. Consumers retain their last good snapshot during busy/failure.

Input byte limit is 64 KiB, all read/detail output 2 MiB, describe 16 KiB.
UTF-8 JSON size is checked before schema decoding (including additive fields).
SDK response objects are already materialized before this check. DTO/schema
admission does not claim to bound remote transport memory or arbitrary supplier
work. Output schemas strip additive fields and inputs reject unknown fields.

## Verification and remaining proof

`bun run test` builds JS and tsc declarations, then imports emitted public entries.
`bun run typecheck` checks source, and `tsc -p tsconfig.public-tests.json --noEmit`
checks emitted public types with both SDK environments. `npm pack --dry-run
--json` inventories the package. No dist is committed.

The `/testing` kit registers the adopter's real factory on createFakePluginHost,
then exercises negotiated describe, representative read/detail cases, strict
input rejection, count bounds and response semantics through real registered
handlers. Advertised detail requires detail cases. Every check is locally
bounded and the report identifies failures; registration/storage behavior and
live network cancellation are not proven by the kit. The kit does not generate
a replacement handler or claim exhaustive semantic proof. The supplier must add
its own rolling-expiry, rate-change, retained-revision, paginated consistency,
edge-index completeness and dollar-population tests. Host integration tests must
prove absence/failure/recovery/caching and navigation; live composition and registry
publication remain separate steward obligations. Optional SDK peers describe the
intended range; local checks use installed SDK 0.6.52+phosphor, not every version.


## Membership boundary and time clipping (owner rulings)

Shared metrics detail supports **model and time only**. It does not enumerate
members or offer descendant spend rows over RPC. The pure `familyClosure` export
is reusable internal algebra over an explicitly supplied edge snapshot, not a
membership discovery endpoint. `readV1` exposes memberCount only. Descendant
spend/member listing belongs to a ledger-specific internal debrief RPC pending
adoption of the existing `bb-thread-membership` protocol after stable publication.
No membership package dependency is added while its exact registry version is
unavailable. That protocol owns opaque scopes, member enumeration, revision-fenced
paging and direct/inherited attribution; metrics must not duplicate it.

Coverage vocabulary follows membership: `complete|partial|unknown`. Summary and
detail may include `excluded`, a nonnegative safe integer counting members/rows
known to be excluded under the supplier's projection. Omit it when not countable;
its absence never implies zero. Coverage reasons retain `source-gap` and describe
why data is partial. All membership/sum input revision duties above are mandatory.

Time detail uses five-minute fixed buckets, consistent with usage-algebra's
last-N windows. For asOf t, B=300000, and N=4/288/2016 for m20/h24/d7:
`lower=max(0,floor(t/B)*B-(N-1)*B)`. Lifetime time detail is limited to the same
retained 2016 buckets as d7; a lifetime total including earlier history therefore
needs partial retention coverage rather than claiming complete reconciliation.
`retainedWindowStart(asOf,window)` exposes this lower bound. Summary series uses
the same boundary with N=288.

Each time interval is half-open `[start,end)`. Start is aligned to B, at least
lower and strictly less than asOf. End is an aligned bucket boundary or exactly
asOf, is greater than start and no greater than asOf. Coarser groups spanning
multiple buckets are allowed. The current interval **must be clipped to asOf**;
it must not label future time up to the next bucket boundary. At an exact bucket
boundary the new current bucket contributes zero duration and its zero-width
interval is omitted. Within each page rows must be sorted by start and disjoint
(`next.start >= previous.end`); gaps are allowed. The validator enforces these
rules independently of whether dollar/vector totals happen to reconcile.
Cross-page interval ordering, completeness and revision consistency remain the
supplier/consumer paging obligation.


## Unattested root evidence (initial 0.1.0 owner ruling)

`root-unattested` means the supplier cannot attest the root thread's own usage
evidence. It is distinct from `source-gap` and general retention: observed
family/descendant spend does not establish the missing root's spend. The ledger
owns detection, omission/floor policy and later recovery; this contract adds no
membership enumeration or root-policy decision.

For partial coverage with `root-unattested`, positive reported dollars are an
observed lower bound (floor). Consumers phrase that value **"at least $X"**,
not a complete spend total. Heat compares these floor dollar amounts under the
same population policy, preserving partial population coverage; it must not
invent missing root dollars or substitute tokens. Zero observed root evidence
must not be shown as zero actual spend: omit the unsupported spend result or
render it unavailable, retaining any previous good value only as explicitly stale.
A missing/unattested root is never evidence that actual spend was $0.

When root evidence is later attested, the ledger reconciles it idempotently,
changes the projection revision when the membership/sum input changes and clears
`root-unattested` only after the matching evidence is recovered. The consumer
replaces its floor/unavailable state from the authoritative response. Actual
recovery/deduplication and UI wording implementations are separate adopter work;
this package supplies the reason codec and preserves observed values unchanged.
