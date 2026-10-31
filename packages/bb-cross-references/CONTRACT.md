# Cross References, package 0.1.0 / wire v1

| Feature owns | Contract package owns | Rendering consumer owns |
| --- | --- | --- |
| Storage, migrations, keys and durable delivery | Resource DTOs, Zod bounds and canonicalization | Explicit target SDK injection and refresh schedule |
| CAS, revisions, outbox and write recovery | Fixed central RPC schemas and bounded client | Controls, layout, local policy and presentation |
| Permitted references and maximum count | Thread/URL normalization and conformance kit | Error presentation and optional dependency behavior |

This package makes Cross References v1 reusable across independently installed
plugins. It has no database, registry, lifecycle, authorization, singleton,
SDK slot hooks, retry loop or implicit write destination. Feature attachment DTOs and
storage remain feature-owned.

## Entries

Root exports existing central canonical functions/constants, resource and
projection DTOs, `normalizeProjectionCommand`, and the named v1 Zod schemas.
Root depends only on Zod and browser-safe `@noble/hashes`; SHA-256 is synchronous.
`/bb` exports `createCrossReferencesClient(sdk, targetPluginId =
"cross-references", options?)` using public server/browser SDK type imports.
`/react` provides shared controls with injected APIs; `/styles.css` their styles.
Data crosses plugin boundaries; React components never do.

`LinkedReferences` requires `ownerKey`, an explicit stable logical storage owner,
plus injected get/replace/search/thread callbacks and native navigation. Changing
ownerKey remounts its whole read/mutation/picker lifetime; late results from the
old owner are dropped. Callback objects may change without changing that logical
owner. Consumers adapt their local snapshots; the component does not call slot
hooks or central RPC. Refresh uses mount, reconnect, a changed refreshToken or the
explicit button, with no idle polling.

`/testing` exports `runCrossReferencesConformance({sdk, pluginId?, command})`.
Use an isolated active source with a nonempty target list and the adopter's
actual registered handlers. The helper drives describe, apply, duplicate
mutation, get round-trip and backlinks through the production client. It
reports source conformance, not host loading or live composition.

## Identity and digests

Identity is `{provider,keys}`; presentation never changes identity. Key names
are lexically sorted and values NFC-normalized. Identity JSON keeps exact
`{provider,keys}` property order. SHA-256 is lower-case hex over UTF-8 JSON.
Projection JSON keeps `{protocolVersion,producerPluginId,source,tombstone,targets}`
order; target order and presentation contribute to its digest. Existing Unicode
behavior, including UTF-8 replacement of a terminal high surrogate, is retained
exactly. No values are silently clipped.

Limits remain 32 keys, 512 bytes per key value, 8192 combined key/value bytes,
16384 identity bytes, 256 targets, 262144 projection bytes. Presentation limits
remain 256 label bytes, 1024 detail bytes, 2048 URL bytes and 4096 total bytes.
BB identities retain installation-local project, project/thread, and the fixed
Machine Monitor page shapes. URL identity is canonical HTTP(S), without
credentials or credential-shaped query/fragment parameters.

`normalizeThreadOrUrlReference(target)` uses these central bounds and permits
exact BB thread or safe URL resources. A supplied native presentation URL must
match `/projects/{project}/threads/{thread}` or `/threads/{thread}`. Callers own additional label and count
policy. `urlResource` serializes a URL; canonicalization validates it. Shared
picker helpers preserve Machine Monitor's reference-label messages and bounds.

`ReferenceSnapshot` (alias `AttachmentSnapshot`) is
`{revision,targets,status:{state:"synced"|"pending"|"degraded"|"blocked",
error:string|null}}`. It adapts feature storage for controls; it does not replace
Machine Monitor's wire attachment response/status.

## Fixed RPC and negotiation

`crossReferencesRpcSchemas` adds only `crossReferences.describe`: null input,
`{protocol:"cross-references",versions:[1]}` output. Its envelope tolerates extra
fields, bounds versions to 16 positive safe integers, and negotiates v1 when
advertised. No shared version raises `CrossReferencesProtocolError`. Only
transport `code:"unknown_method"` permits legacy v1 fallback; absent/disabled
peers, ordinary 404s, timeouts and malformed output fail. Describe is explicit;
clients perform no hidden listing, discovery or caching. Consumers own listing
and probing, or use the explicit central default.

Legacy methods stay `applyProjection`, `getProjection`, `listBacklinks`,
`listForwardReferences`, `checkForwardReferences`. Their strict schemas, DTOs,
identity, digest and CAS meanings are unchanged. Legacy strict outputs are a
compatibility constraint; new envelopes tolerate extension. Central registration
wraps shared schemas with existing `defineRpcContract` and supplies the fixed
describe handler. Changed wire meaning requires a new versioned method.

Every client call validates input before transport, targets the injected plugin
ID, passes abort, and enforces 1000 ms describe / 5000 ms other deadlines. Options
can lower those budgets only. Promise races enforce bounds even for transports
ignoring abort; listeners and timers are cleaned up. Decoded canonical JSON is
capped at 1048576 bytes before DTO parsing. The SDK already parses the envelope,
so raw transport byte admission remains outside this package's guarantee.

Transport errors retain their codes. `timeout` denotes deadline failure,
`incompatible_protocol` negotiation/result admission failure, and Zod errors
malformed data. Features classify these within their existing failure policy.
Clients never retry writes or attribute success after an unknown outcome.
Direct writes require a fresh read reconciled by submitted digest; durable
outbox policy remains feature-owned.

## Release and proof

Consumers pin `@phosphorco/bb-cross-references` exactly at `0.1.0`. Runtime pins
are Zod 4.3.6 and @noble/hashes 1.8.0. SDK and React are optional external peers.
Bun.build emits root, bb, react and testing with production automatic JSX,
followed by declarations and the CSS copy. Testing sibling entries stay external
so the conformance kit uses the same production module instance. Do not commit
`dist`.

Package self-tests, adopter source conformance, UI/host proof and live composition
are separate evidence levels. Rendering, dependency locks, publication and live
proof are owned by the coordinating lane.

## Recognition identity adapter (package 0.2.0; wire v1 unchanged)

Ownership: the recognition supplier owns its provider/id grammar; this package
owns the pure `recognitionIdentity` codec; the consumer owns existing-thread
verification, source eligibility, authored locators, persistence and scheduling.
`bb.thread` requires an explicit verified existing `{id,projectId,deletedAt?}`
and maps to existing `bb` project/thread keys. `bb.url` must pass safe canonical
HTTP(S) URL policy, including credential/sensitive-parameter rejection. Other
identities map to `recognition` keys `{provider,identity}`, where identity is
SHA-256 of recognition `canonicalJson([provider,id])`. `kind` is advisory and
excluded. This hashes, rather than truncates, recognition's bounded opaque id.
`recognitionIdentityRecord` preserves the complete provider/id in at most
16,384 UTF-8 bytes for a consumer-owned mapping. Authored href/span/URL remain
separate; no alias/redirect/host equivalence is inferred.

No v1 input, output, projection duplicate rule or resource-containment meaning
changes. Package 0.2.0 adds no evidence RPC, storage or lifecycle code. Source
codec tests import the emitted public entry; they do not prove live adoption.

### Verified file identity codec (unreleased 0.2.0)

`recognitionIdentity` requires `bb.file` callers to use `verifiedFileIdentity`
with a consumer-verified `VerifiedFileTargetSchema` value:
`{kind:'workspace',environmentId,path}` or `{kind:'thread-storage',threadId,path}`.
The graph is provider `recognition`, keys `{provider:'bb.file',identity}`, where
identity is SHA-256 of recognition `canonicalJson(['bb.file',kind,ownerId,path])`;
ownerId is environmentId for workspace and threadId for storage. No truncation.
`verifiedFileIdentityRecord` stores `{provider:'bb.file',verifiedFile:...}` in the
existing 16,384-byte mapping bound. It never stores a source-thread lexical ID
as the shared resource mapping. Original lexical identities remain per occurrence.

Paths are canonical slash-separated relative paths: reject empty/dot/parent
segments, leading slash, backslash, colon, percent, query/hash and controls.
Owner IDs use the existing BB ID alphabet/bound. Preserve exact Unicode/case and
authored symlink alias; do not normalize Unicode, case-fold or substitute realpath.
A leading `./` is already removed by the existing native recognition grammar.
The package validates/encodes data only; existence, regular-file and realpath
containment verification belongs to the consumer and shares its source deadline.

Workspace conversations in the same environment/path coalesce; different
environments, storage owners and alias paths stay distinct. Metadata preserves
future navigation/codec inputs, without claiming installation-local IDs are
portable. Phase-2 query and phase-3 Brief production must use this same codec and
frame rule. This helper adds no public wire method or v1 projection metadata
requirement; existing v1 producers remain unchanged.

## Wire V2: stored mention evidence (0.3.0 reservation)

V1 methods, strict schemas and projection semantics remain unchanged. A host
advertises `[1,2]` at `crossReferences.describe`; the separate explicit V2 client
requires advertised2 and never substitutes a V1 read. Root remains data/pure;
`/bb` provides `createCrossReferencesV2Client` and `registerCrossReferencesV2`;
`/testing` provides read-only `runCrossReferencesV2Conformance` against actual
registered handlers and caller-prepared fixtures. No registry publication is
implied by this source reservation.

`crossReferencesV2ListMentions` input is recursively strict:

```ts
{version:2,query:
  | {kind:'resource',target:ResourceIdentity,relation:'self'|'github-pr-family'}
  | {kind:'authored-url',href:string},
 source?:ResourceIdentity,producerPluginId?:string,pageSize?:number,
 cursor?:string,ifSnapshot?:string}
```

Page size defaults25/max100; cursor<=4096 UTF8 bytes and conditional64hex are
exclusive. Source is exact and a missing source gives an empty result. Existing
V1 exact-key lookup is unchanged; general containment is deferred. Current GitHub
recognition collapses PR root/comment/review destinations into ONE primary root
identity, selected directly with no descendant enumeration ceiling. There are no
alias claims or derived posting graph. Supported explicit safe GitHub URL codec
`githubLookup` is exported for every consumer: owner/repo lowercase and positive
safe number map through the SAME recognition identity helper. A `/pull/N` route
has PR authority; issue URLs select self. Bare repo#N/opaque hashes alone do not
prove PR kind. Original descendant URL remains evidence, never root navigation.
Future separately identified descendants need a separately documented codec.

A page contains exact CURRENT retained matching location counts, confirmed and
unconfirmed counts, producerClaims, DISTINCT indexedSources,
**claimsWithoutLocations**, and excerptUnavailable. Repeated locations do not
inflate primary claims; legacy/other producers without matching locations take
one ordinary row slot. Counts describe known active producer/source/target facts,
not all-time totals or complete source discovery. In a literal authored URL query,
primary URL identity claims can appear with `matchBasis:'primary-url-identity'`
without asserting original spelling; unknown typed history is coverage only.
Claim reasons are `legacy`, `producer-no-evidence`, `not-yet-collected`.

Occurrence rows keep the complete original UTF16 span, actual user/assistant role,
threadId/messageId/messageSeq/anchorSeq, body-derived sourceContentRevision,
occurrenceKey, evidenceRevision, source/target/producer, original messageCreatedAt,
observedAt, original recognition provenance, URL-proof state and confirmation.
Cap state is uncapped/capped/unknown with retained limit100/null and separate
sourceHistoryUnknown. Absent producer evidence never means uncapped.

Ready excerpts are contiguous slices of admitted original text, <=320 Unicode
code points AND1280 UTF8 bytes, with original sourceSpan, relative nonempty
matchSpan, context/match clipping flags and codecVersion1. No sentence/paragraph
can bridge excluded code, inline code, raw HTML, standalone/linked image intervals.
No reconstruction of offsets from rendered Markdown. Ordinary/reference link
context remains eligible even though recognition excludes it from the prose pass.
An overlong indivisible matching word gives unavailable/indivisible-word with full
location/navigation retained; no eligible context gives no-eligible-context.
Absent valid child gives not-materialized. A missing excerpt remains an occurrence.
Original-slice proof is established while collection/commit has the body;
persisted reads validate stored text/ranges/revision/codec without fetching it.

Literal href lookup compares the original SAFE captured destination string,
including query/fragment/case/spelling; no redirect, canonical alias or typed-hash
reconstruction. Historical URL state is unknown until an ordinary existing scan
observes original spelling. No reader-triggered enqueue or re-observation campaign.
Unknown active locations under the same source/producer filters contribute to
independent authoredUrlCoverage, including outside literal matched rows.

Responses are page(snapshot,items,counts,coverage,nextCursor), not-modified
(snapshot,**current coverage**), restart(snapshot-changed,snapshot), or unavailable
(index-warming/read-budget,retryable). Direct storage needs no warming bootstrap.
Semantic tokens bind query/filter/page size, relevant active graph revision/payload/
presentation and evidence digest/revision/binding. They exclude observation-only
clocks and unrelated filtered-out sources/producers; a producer/source evidence
change may invalidate its other matching queries. The independent URL-unknown
watermark updates coverage without resetting unchanged item cursors.

Order is messageCreatedAt descending, binary canonical source digest, producer,
target digest, item kind, message ID, original span start, occurrence key; stable
claim sentinel time0. Cursor binds the complete query and semantic snapshot;
mismatch restarts instead of mixing pages. The one shared1MiB canonical JSON
UTF8 budget covers rows+counts+coverage+cursor; cursor advances only through the
last emitted row. Individual row ceiling128KiB. Output unknown fields share that
budget before tolerant decoding; parsed transport cannot bound pre-parse memory.
Nested evolving outputs tolerate additive fields; unknown item/locator/excerpt
enums safely preserve an unsupported item slot, required known fields still
validate. Reasons are <=32 safe codes of <=128 UTF8 bytes, with honest clipping/
unknown mapping; no raw errors. Direct counts/token/sort may scan all relevant
facts. Cooperative server checks use2s and return read-budget on exhaustion;
synchronous SQLite cannot be preempted by a JS timer. Client call budget<=5s.

`crossReferencesV2ResolveLookup` is mandatory for pasted referents:
`{version:2,text,mode:'recognize'|'exact-url',context?}`. Text1..4096 UTF16 units /
<=16384 UTF8 bytes; complete input<=64KiB; context is the strict public recognition
subset with <=16 safe unpositioned links and no caller attribution. Options<=8
contain query,label<=256 UTF8 bytes,inputSpan,basis(supplier/native/stored-codec),
reasons; overall state ready/ambiguous/unrecognized/incomplete. Exact-url mode stays
literal. Recognition uses the existing service-owned supplier snapshot, shared
arbitration and labelled pure codec fallback; <=8 suppliers share a1500ms stage.
Native thread verification may use bounded SDK metadata reads. No discovery per
reader, card/body/timeline/filesystem/network resolve, collection enqueue or graph
write. Lexical file text cannot invent verified file identity. One failed supplier
preserves healthy/native results with incompleteness disclosed.

V2 invalidation channel `cross-references-mentions-v2-changed` carries version2,
producerPluginId,sourceIdentityDigest,graphRevision,evidenceRevision(nullable),
<=512 affectedIdentityDigests,scopeListClipped. Publish once after a changed
committed source; old strict V1 signals are unchanged. Clipped/coarse wakes can
refresh mounted literal-URL coverage conditionally. No idle polling/factory SDK
subscription/new worker. Later consumers share lazy mounted queries, cancel on
teardown and retain rows/cursors when only coverage changes.

## Producer ingress reservation (0.4, wire family1)

The separately negotiated producer family has four methods:
`crossReferencesProducer.describe`, `crossReferencesProducerV1GetState`,
`crossReferencesProducerV1Apply`, and `crossReferencesProducerV1ReportStatus`.
Use the exported schemas/client/registration helpers. Inputs are strict; outputs
admit bounded additive object fields. The existing V1 graph methods, digests,
claim uniqueness and counts retain their meaning. These source additions do not
establish registry availability of0.4 or compatibility with an older advertised SDK.

The first source kind is `thread-brief`, producer `thread-brief`, fixed verified
thread-storage `BRIEF.md`. One complete replacement contains the V1 projection,
its full primary evidence and an independently computed evidence digest. Existing
V1 resource/presentation validation remains authoritative. Limits are1MiB total,
256 targets/256KiB V1 payload,512 locations/100 per target and256UTF8 bytes per
named heading. Presentation limits remain256/1024/2048UTF8 bytes and4096 JSON
bytes. The preflight returns the actual closed hit codes; it never truncates,
splits, silently withholds an overlong safe presentation or partially installs.

Let G be current graph revision and S retained blocked attempt; high-water is
max(G,S). A prospective producer Apply must exceed that high-water and satisfy
unchanged graph CAS. Exact current bound graph/evidence replay is nonmutating,
ignores stale CAS like V1 duplicate/equal, and exposes rather than clears newer
status. Same graph payload with different/unbound evidence cannot graft evidence.
`currentRevision` always means G. Apply commits graph, evidence, mappings and
superseded status deletion atomically, before any invalidation. Status-only
writes create no graph resources/claims/evidence, including a first-ever source.

ReportStatus precedence is exact stored attempt+digest replay; nonreplay<=G
stale; lower prior status stale/same attempt different content conflict; then
expectedRevision graph CAS. Its digest excludes attempt/CAS/clocks. Unknown
write outcomes require exact GetState reconciliation, never an automatic retry.
Ordinary V1 writes remain compatible and unfenced by S: retained evidence can
become unconfirmed and retained status can become superseded-by-graph. There
is one prospective V1 allocator, not a separate evidence/status revision clock.

Blocked states are `over-limit` (actual hit codes) and `identity-unrepresentable`
(fixed identity codes and any actual limit hits). UI text is exactly “brief
references not updated: over limit” or “brief references not updated: identity
cannot be represented safely”. Neither status transports raw errors or metadata.

### Display safety and original locations

`classifyBriefDisplayTextV1` and `classifyBriefDisplayFieldsV1` are one pure bounded
lexical display-policy implementation, independent of recognition and Markdown.
They reuse existing safe URL/credential parameter policy, inspect raw plus at
most three strict security decode views, and return safe, unsafe or unclassified
with fixed reasons/work counters. URL userinfo, query/fragment parameters and
query-shaped sensitive-name assignments are covered. Percent UTF8, textual JSON
escapes and the closed numeric/ASCII HTML entity set are security views only.
Unknown, ambiguous, deep, malformed, control or budget-limited data is never safe.
No host/provider/resource discovery/parser call or cross-acceptance cache exists.
Bulk work admits required identities first, memoizes exact final values across
roles, and has fixed8192-field/4096-distinct/2MiB-original/8MiB-work limits.

Explicit B slots distinguish exact safe data, absent data and withheld digest plus
fixed generic display. Intro is null; named-empty is still a named heading.
Withheld digest is SHA256 of canonical `['brief-withheld',1,role,originalKnownValue]`.
Raw withheld values are never transported/stored. CR independently classifies
received safe/available fields; it cannot attest unseen originals behind digests.
Unsafe required identity rejects the whole revision. Optional unsafe metadata
keeps safe primary claims/counts/locations with explicit withholding; withheld
codec metadata supplies no new raw mapping/family authority. Exact authored URL
proof is separate from canonical identity and uses only safe original spelling.
Withheld/unknown URL proof contributes conservative coverage, never reconstruction.

Brief V2 rows are `brief-occurrence` with original ref-N, raw SHA/frame/bodyBase,
B section, original line/span and producer-attested/retained-unconfirmed binding.
They have no invented conversation role/messageSeq/time, and excerpts are only
unavailable/not-materialized. Direct active full producer/source/target joins,
query-relevant semantic tokens, keysets/counts/shared1MiB response admission and
independent coverage-on-not-modified remain. No derived postings or bootstrap.

### Navigation provider seam

`registerBriefNavigation` and `createBriefNavigationClient` negotiate the separate
Thread Brief provider. A strict request pins the fixed file, raw revision, full
UTF16/BOM/bodyBase/native-line frame and explicit section/original line. A ready
proof must match all of them and the same complete accepted revision. Otherwise
open only fixed BRIEF top with a bounded note. FileLink alone is not freshness.

The TB adopter must implement one fresh bounded contained RAW read/hash per
explicit primary click, bypass stat/idle caches, and reuse accepted section/native
facts only after source/raw/frame equality. No hidden parse/recognition/model
construction or newer-heading relocation. Intro needs explicit same-pass intro
facts. Source/service generation guards are independent of viewer teardown. BOM
and LF/CRLF/loneCR mapping require actual adopter proof; unknown means top.

One mounted CR surface owns pending proof and dispatch entitlement across all
rows. New modifier/defaultPrevented/download/nonprimary/aux/context-menu intent
cancels prior proof before native top dispatch, without interception/new read.
Identical in-flight primary shares one read AND open. Primary prevents default
synchronously; current validated continuation opens once, with no automatic retry.
The public provider/accessor repairs and exact published0.4 TB adoption remain
separate work; source schemas do not claim that provider is already installed.

PR-family membership requires authority on each admitted record, recomputed to
the same canonical target. A PR sibling never promotes issue/kindless/withheld
siblings. An own available typed descriptor can support the real claim sentinel
when no admitted family location exists. Resource-level kindless mappings are
insufficient. Missing authority is independently scoped partial coverage using
`pr-family-authority-unknown`, including an all-unknown empty result; known issue
alone is excluded without fabricated unknown. Exact-self/literal semantics stay
unchanged, and no parser/secondary graph edge/target enumeration is added.
