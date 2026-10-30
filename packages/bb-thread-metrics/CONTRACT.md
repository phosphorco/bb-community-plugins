# Thread metrics wire v1 (@phosphorco/bb-thread-metrics 0.2.0 candidate)

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

## Byte conformance and aggregate approximation hardening

The conformance kit admits every positive read/detail case with `parseBounded`
before invoking a handler; shape-only parsing is insufficient. Every supplier
must reject the mandatory shape-valid oversized read input: 200 unique IDs of
200 characters plus a 256-character known revision per ID (133051 UTF-8 JSON
bytes, above the 65536-byte input cap). Count/field validation alone accepts this
input, so the kit requires a structured invalid_input or Zod validation failure
from the real registered handler boundary. A raw-schema supplier that omits byte
admission fails source conformance even if all ordinary reads work. This proves
local handler admission, not a limit on the SDK's prior transport allocation.

Detail's top-level `approximation` describes the **aggregate total**, not merely
the page or a separate pricing lookup. If any contributing returned row has
`approximate:true`, the aggregate must also be approximate and retain every
reason on that row. A contradictory exact aggregate or a missing row reason is
rejected. This requirement applies on partial/unknown pages too. Aggregate
reasons may be a superset of current-page reasons (unseen contributors or
aggregation uncertainty); partial pages still need not sum to the whole total.
Across pages the supplier must retain the total's full provenance consistently.
Existing null-money requirements remain: null total requires top-level
missing-price provenance, and null row amounts require row missing-price
provenance. Additive unknown output fields remain tolerated.

Optional rate attribution remains optional; no caller is required to populate
`rates`. When present, every matched/closest-model/provider-default record must
have a non-null rateId identifying the selected priced rate. An unpriced record
must have a null rateId. The codec rejects both contradictory pairings; it does
not verify a rate against the supplier's operator-owned table.

## Ordinary client deadlines and publication fences

`createThreadMetricsClient` binds the owner and validates the wire data. It only
forwards the caller's AbortSignal to the SDK. It creates no per-call deadline,
queue, outstanding-read limit, generation fence or automatic retry, and does not
promise that abort rejects the call or stops remote work. A supplier/transport
that ignores abort can still return a schema-valid result after cancellation.
The discovery coordinator's bounded lifetime/admission does not extend to these
ordinary read/detail calls.

Consumers own read/detail deadlines and actual outstanding admission across
refresh/reconnect/replacement requests. Racing a call against a timeout permits
local UI progress but must not free its transport slot until the actual promise
settles. A new owner/client instance must not bypass the demand coordinator's
retained admission budget. After **every await**, before publishing/caching any
response or error, consumers check their abort state and current generation
(owner, thread/scope/archive/window/series demand and view lifecycle) and discard
obsolete outcomes. These post-await fences are required even when the SDK claims
cancellation support. Keep last good data during failure according to the host's
staleness policy; a late response cannot revive a disposed/replaced demand.
No package-global lifecycle or client cancellation machinery is introduced.


## Additive recent snapshot capability (package0.2)

The new optional boolean `recentSnapshotV1` capability requires the exact fixed
`threadMetricsRecentSnapshotV1` handler; registration rejects either mismatch.
Input is strict `{ifRevision?:string}` within1024 canonical UTF-8 JSON bytes.
Full replies have wire version1, `unchanged:false`, opaque revision, immutable
publication time, rank time,72h recent window, a published config revision/value,
explicit coverage/materialization-pending/cap state and rows. Unchanged replies
have version1, `unchanged:true`, revision and no recognized full-only payload.
Recognized rows/config/times/population/coverage/cap fields are rejected BEFORE
stripping; unrelated future additive fields remain allowed within the byte cap. The revision
must exactly match requested ifRevision. A new supplier instance must not reuse a
revision for different content. Reads do not advance revision or run fold,
closure, rank or materializer work; suppliers serve a held published object.
Adapters validate shape/bytes but cannot prove supplier implementation purity.

Each row has independent own/family last-fold timestamps, asOf and content
revision; at least one activity timestamp must be in the envelope's72h window.
The row score-config revision must match the published envelope config. Own and
family each carry memberCount/coverage/priceVersion, compact approximation
provenance, four raw dollar windows and
provider-attributed dollar windows, omitted-provider count, four weighted-score
windows, and separately named dollar/score percentile ranks. `estimate`/`floor`
values are finite nonnegative amounts; `unavailable` has null amount. Explicit
floor0 is a supplier attestation; unsupported root zeros must be unavailable,
never inferred from a partial population or a missing row. Family providers must
represent deduplicated actual members, not sums of other family rows.

Full canonical JSON is capped at4MiB including additive unknown fields,1000 rows,
8KiB per raw row before stripping, and32 provider entries per scope. Omitted
providers/rows, uncertain omission counts (`exact:false`, even lower-bound0),
and pending materialization cannot claim complete coverage. These
are post-transport decoded bounds, not raw-network/preparse allocation limits.
Providers select most recent rows within both row/byte caps, publish cutoff and
honest omission state; row omission alone proves neither absence nor zero. The
codec always checks finite known provider subtotals and weighted arithmetic,
including when other providers are unavailable or omitted. Available totals must
cover every known subtotal within eight relative machine epsilons (no absolute
small-dollar epsilon); incomplete provider sets or contributing floors
require a floor rather than an estimate. Unknown components may yield unavailable
totals, never invented zero. Complete provider sets reconcile exact totals.

Each scope AND provider has `approximation:{approximate,reasons}` independently
of observation coverage. Compact bounded reasons retain `closest-model`,
`provider-default`, `model-attribution`, `bucket-boundary`, `missing-price`, and
`source-gap`; aggregate provenance must include contributing provider reasons.
Unavailable prices require `missing-price`. Unavailable observations are different:
a partial/unknown projection with source-gap approximation and source-gap,
root-unattested, history-unavailable or missing-thread coverage may retain
unavailable values without claiming a price failure. Any explicit unpriced
coverage still requires missing-price, and provider missing-price reasons must
remain in aggregate approximation. Suppliers must not label an actual pricing
gap as an observation gap. This is the lossless reason mapping
from readV1; per-model rate associations remain in on-demand read/detail and are
not copied into listing rows. `priceVersion` still identifies the price table.
Real materializer conformance remains necessary before release.

Scoring-config schemaVersion2 is versioned separately from normalization semantics.
Default mode is percentile with gates .9 m20/h24/d7; omitted provider weights mean1.
Absolute mode supplies thresholds for all four windows. `weightedScoreV2` sums
provider dollars times weights, returns unknown when a component is unavailable,
and rejects invalid/duplicate provider values and arithmetic overflow. Weighting
never reprices the raw-dollar fields. UI, settings CAS and scoring policy remain
ledger/surface-owned; this package contains no settings storage or sliders.

Ranks cannot be non-null for an empty population; a positive singleton ranks0.
When rankAsOf is at or after the row value epoch, zero or unavailable amounts require null rank.
Older rank epochs may deliberately remain while newer amounts change; consumers
must gate heat on supported positive CURRENT amounts as well as ranks.
`recentPercentileHeat` applies that current weighted-score gate; legacy
`heat(ranks)` alone is insufficient for recent rows. This codec does not rebuild
or prove actual population percentiles.

Supplier ranks recompute at most once/minute outside reads. A publication binds
configuration and scored content atomically; pending changes retain explicit
coverage. Consumers hold the object by SDK-owner identity and use keyed row
selectors. They may conditionally poll at30s while interested/visible/connected,
coalescing existing hints without a per-thread request. Covered listing rows need
no readV1; explicit inspection outside the window may use the existing bounded
read/detail lane. The contract package itself never polls or retries.

### Optional recent token/count observations

A recent scope may carry `usage` with aggregate and per-provider token windows,
explicit `estimate`/`floor`/`unavailable` values, matching provider omissions,
and a descendant count with an exactness flag. Missing `usage` is unsupported,
not zero. Positive tokens do not depend on a price match or lifetime dollar
observations: wholly unpriced and bucket-only tokens can remain floors while
USD is unavailable. Unknown/legacy token inputs stay unavailable. A supplied
zero is an explicit observation attestation.

Provider identities must match the displayed dollar providers. The codec checks
componentwise conservation of known token observations and reconciles descendant
count with the loaded membership; it does not certify unseen global membership.
Omitted providers permit a larger aggregate supported subtotal, never a smaller
one. Presentation fitting removes dollar/token provider entries together and
retains aggregate supported observations with an explicit cap qualification.

Per-provider dollar contributions are the primary money presentation. Aggregate
cross-provider dollar windows remain internal reconciliation/ranking inputs and
must not be presented as a grand total. Weighted attention scores are unitless,
not currency; token counts and descendants are secondary to provider dollars.

An aggregate token `estimate` requires estimate-kind tokens for every displayed
provider and no omitted providers in that window. A floor or unavailable provider
cannot be upgraded by numerical equality alone. This requirement is independent
of USD pricing coverage: completely observed zero or positive tokens may remain
estimates while dollars are unpriced. Explicit member-cap, depth-cap or edge-cap
coverage cannot carry `descendants.exact=true`; other supplier membership
attestations still require evidence the codec cannot reconstruct.


### Unique seven-day root inputs (unpublished0.2 producer extension)

Optional `heatInputs` is a unique all-window root-family table captured in the SAME durable rank publication as `heat`. It is independent of `rows`, whose actual fold activity covers only72h and whose money may be newer. Never join current display money into captured ranks by ID, infer missing activity timestamps, or compare cross-epoch money as equal. Each input carries its financial `asOf`, config revision, explicit attested root topology, root-domain dollar/weighted ranks and all three decisions. `family.dollarRanks/scoreRanks` retain their original scoped meaning; root ranks live only under `heat`. Unknown metadata remains absent/null; title/native personal-or-project navigation is only bounded already-collected data, not identity/membership proof.

`cohortComplete` attests the supplied ROOT table, not complete source observation or exact spend. It requires no pending or omitted input and exact omission accounting. Per-window context population coverage and each family value/attribution remain independent. Full certified windows reconcile exact supported-positive counts and first-tie ordering against the complete table; partial transport preserves published ranks but cannot give exact reweighted draft percentiles. A five-day root can appear here without any72h display row. Hidden/archive activity is included; child/deleted/unknown topology never enters this table.

Display rows PLUS captured input rows share one aggregate1000 physical-entry budget, whole4MiB canonical JSON,8KiB per entry; duplicate IDs across these two DIFFERENT captures still consume two physical entries. Raw additive fields count before output stripping. Producer packing may retain only a subset; omissions/capped membership are explicit and prevent a complete input attestation. It never reconstructs from display rows or adds a per-ID population endpoint.

Optional scope `attribution` carries per-window `unknownProvider`, `attributionComplete` and `unpriced` evidence. Known provider USD is primary presentation. Cross-provider `windows` and unitless weighted `scores` are INTERNAL reconciliation/ranking inputs, not a dollar grand total. Unknown remainder is a lower bound/unavailable reconciliation amount, NEVER an invented provider at weight1. No omitted provider IDs and exact zero remainder are required for complete attribution; complete observation/price are separately required for estimates. Explicit unpriced usage retains missing-price provenance. Legacy scopes lacking this extension remain readable diagnostics; they cannot populate the new certified heat input table. No numeric evidence is invented on migration.

The supplier still attests actual membership and ordering; codecs prove internal coherence, not unseen global source truth. Bounds are post-transport parsing containment. The optional producer remains source-only until reviewed publication, exact registry pins, fresh composition gates and host byte/time measurement; the contract extension alone is no activation/adoption/freshness proof.


### Full publication identity and ordered consumer admission

An additive full-only `publication:{instance,sequence}` header exposes the
supplier's committed publication identity. `instance` is an opaque1–128-character
string; `sequence` is a positive safe integer. Old stored/full responses may omit
this header and remain readable for legacy diagnostics. New changed publications
from the ledger include it. A Heat capture adopter requires the header; absence
is unavailable, never inferred by parsing `revision`, rank time or a request
ordinal. Unchanged replies carry only the previously requested opaque revision,
never a new identity or recognized full-only fields.

Within one durable source history, changed committed publications strictly
increase sequence across writer-instance changes. No-op attempts and reopening
retain the exact held revision/pair/content. The publisher injects revision and
pair inside its guarded commit and excludes BOTH from the semantic digest. The
pair is validated against the stored instance/counter on hydration; reads return
the stored payload identity, not the newly registered writer. Actual encoded
header bytes count toward the same4MiB cap; no new allowance is created.

A retained owner resource, outside component mounts, must order validated full
responses by sequence before feeding Heat: lower is stale; equal accepts only
the same immutable pair/revision/content; greater with a new instance is an
ordered writer successor. Null, ordinary reconnect, facade changes and timeouts
do not reset this watermark or release actual transport admission. Source
replacement fences captured old callbacks. These are adopter obligations, not
facts proved by a stateless wire decoder or the presence of this header.

The persisted counter does NOT attest order across external database rollback,
reset or replacement. Such images may repeat or lower sequences while changed
writer UUIDs keep revisions distinct. A UUID alone must never authorize a reset;
a retained consumer holds/reports lower or equal-conflicting data until an
explicit authoritative selected-source replacement. This unit adds no restore
protocol or automatic reset. Counter exhaustion is explicit refusal, never wrap.
Settings Save CAS remains keyed by config version, not publication sequence;
settings published metadata must describe the exact held publication/config.


### Retained snapshot client session (unpublished0.2)

The optional `/bb` `createRecentSnapshotSession(ownerBoundClient)` helper is an
imperative admission and ordering boundary, owned by the existing selected-source
resource outside React. The surface owns discovery, source-selection authority,
refresh cadence, retries, observable state and rendering. The helper creates no
subscription, refresh loop, retry queue or shared global store; construction is
quiet. It holds at most one decoded immutable full snapshot and one actual read.
A native adopter must retain the SAME session through zero interest, remount,
ordinary reconnect and facade/writer changes while a read remains outstanding.
Independent factories do not share admission. This helper alone does not prove
an adopter's resource lifetime.

`read()` sends the held opaque revision conditionally; `read({full:true})` requests
a full response. Original full envelopes are publicly validated before ordering.
A full response requires the publication pair: lower sequences fail, equal
sequences require the same immutable pair/revision/decoded content, and greater
sequences must use a new opaque revision. An ordered new writer advances the
private owner generation once; an ordinary same-source facade update does not.
Valid unchanged content returns the exact held observation object, allowing the
caller to confirm recovery without allocating or notifying for changed data.
Null, invalid, missing-identity, stale or failed responses preserve last content
and highwater. Validation/content comparison still costs bounded payload work;
this is not a claim of constant-time end-to-end decoding.

The default local observation deadline is the existing2000ms contract call
limit (configurable1–2000ms). Timeout, caller abort, inactive state or explicit
replacement rejects local observation and aborts its signal, but the actual slot
remains held until the underlying source Promise settles, even if abort is
ignored. Busy/inactive/already-aborted reads return typed local
`RecentSnapshotNotStarted` without invoking the source. A source-thrown instance
of that type is wrapped and cannot claim this session's pre-invocation proof.
There is no queued replay. A permanently held transport keeps this lane
unavailable; caller deadline never proves remote cancellation.

`updateSource` is only a same-plugin facade update and retains ordering.
`replaceSource` requires authoritative selected-source replacement, fences old
callbacks and clears held lineage while retaining any actual old transport slot.
Do not invoke it for a new UUID, timeout, remount, lower sequence or an ordinary
reconnect. External restored/reset images require authority supplied by the
native resource; this API does not establish that authority. `setActive` changes
interest without clearing the lineage. Only admitted observations may feed Heat
owner-generation transitions. Publication identity is independent of matching
Save config bytes/version, which the retained Heat adapter must still check.

These are client source conformance guarantees, not released pins, native
resource adoption, host latency/freshness or live bytes/time acceptance. No
existing consumer is switched merely by exporting this helper.
