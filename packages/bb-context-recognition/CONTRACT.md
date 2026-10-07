# @phosphorco/bb-context-recognition — v1 contract

Status: **v1 contract, revision 4; package 0.3.0 source candidate.** Package
0.2.0 is published; Thread Brief, GitHub Review and Plan Graph are source
adopters of that boundary. Their 0.3.0 pins follow acceptance and release.
Package source checks do not establish host or live composition proof.

This package gives BB plugins one way to **recognize** mentions in text
(*linkify*) and to turn the recognized identities into **presentation data**
(*resolve*). The two stages are independent: a consumer can linkify without
resolving, resolve identities it already has, or mix built-in and contributed
handlers in either stage. Thread Brief is the first consumer; chat messages,
Cross References or any other plugin surface can consume it the same way.

It is not a registry, a store, a cache, a renderer, a permission system, a
search index or a rule engine. It never reads the machine, the network or a
git repository on anyone's behalf. It supersedes
`@phosphorco/bb-brief-references` (§12).

Vocabulary follows the separation of source identity, recruitment, revision
and reasons in [Workbench context](https://github.com/phosphorco/workbench-go/blob/65f62403b31126431c8098d986dbba90d2fbdddd/docs/context.md);
no Workbench wire compatibility is promised and nothing here is delivered to a
model.

## 1. Ownership

| Supplier plugin owns | This package owns | Consumer plugin owns |
|---|---|---|
| Its recognition rules and inference policy (e.g. how `#N` picks a repo) | DTOs, codecs and bounds (Zod), `LIMITS` | Building the context bundle (git, thread, environment, links) |
| Its sources, credentials, rate limits, reads | Fixed method names, describe envelope, version negotiation | Which text is linkified and which ranges are excluded |
| Its card content, freshness and reasons | Pure functions: `arbitrate`, `identityKey`, `canonicalJson`, span checks | Schedule, triggers, budgets actually applied, caching |
| Its own failure semantics | `/bb` registration and owner-bound client helpers, enumeration, error classification | Built-in handlers for reserved `bb.*` providers |
| Which providers and kinds it advertises | Bounded stage runners that apply isolation (`linkifyAll`, `resolveAll`) | Rendering, layout, Markdown sanitization, provenance display |
| | Conformance kit (`/testing`) | Per-supplier error presentation |

Rules that follow from the table:

- A linkifier receives **only** what the consumer sends. It never scans files,
  runs git, calls the network or reads BB state during linkify.
- A resolver reads its own sources with its own credentials. The consumer never
  passes credentials or a viewer.
- **Identity is attribution only.** Inputs name the consumer and thread so a
  supplier can log and explain; no handler gates on caller or viewer identity,
  and no consumer gates cards per viewer. A supplier must therefore return only
  what it is willing to show to every user of this BB deployment.

## 2. Public entries

| Entry | Runtime imports | Contents |
|---|---|---|
| `.` (root) | `zod` only | DTO schemas and types, `LIMITS`, `METHODS`, `WIRE_VERSIONS`, `RESERVED_PROVIDER_PREFIX`, `identityKey`, `canonicalJson`, `checkCandidate`, `arbitrate`, `nearestSpan`, `negotiateVersion` |
| `./bb` | none at runtime; takes injected `bb` / `sdk` (`@get-bb/plugin-sdk` is an optional peer, types only) | `registerRecognitionSupplier`, `createSupplierClient`, `enumerateRecognitionSuppliers`, `classifyRecognitionError`, `linkifyAll`, `resolveAll` |
| `./testing` | root and `./bb` as externals, SDK testing peer | Conformance kit, version and arbitration fixtures; DOM-free |

There is no `/react` entry in v1. Consumers render cards with their own
components (rule 4: data crosses plugins, components do not).

Package version (`0.3.0`) and wire version (`1`) are separate numbers (§10).

## 3. Identities, spans and shared types

### 3.1 Canonical source identity

```ts
type SourceIdentity = { provider: string; id: string; kind?: string };
```

| Field | Grammar | Meaning |
|---|---|---|
| `provider` | `/^[a-z][a-z0-9-]{0,31}(\.[a-z][a-z0-9-]{0,31}){0,3}$/`, ≤ 64 | Referent namespace (`github`, `plan-graph`, `bb.thread`). Not a plugin id and not proof that a plugin is present. |
| `id` | 1–2048 UTF-16 units, no control characters | Stable, canonical within the provider. |
| `kind` | `/^[a-z][a-z0-9-]{0,31}$/`, optional | Advisory in linkify, authoritative in resolve (`issue`, `pull-request`, `plan`, `session`, `file`). |

- **Identity key = `(provider, id)`.** `kind` is not part of identity: `#312`
  can be recognized before anyone knows whether it is an issue or a pull
  request. `identityKey(source)` returns `canonicalJson([provider, id])`.
- Ids must be **context-free** wherever the referent has a global name
  (`github.com/phosphorco/bb-plugins#312`). When a referent only exists relative
  to a frame, the id embeds that frame (`env_abc123:plans/x.plan.pkl`), so the
  same id means the same thing in every consumer.
- Providers starting with `bb.` are **reserved** for BB-native referents
  implemented as consumer built-ins. Their id grammars are consumer-defined,
  not extra wire DTO fields. Thread Brief uses `bb.thread` (id `thr_…`, kind
  `session`) and `bb.file` (kind `file`) with these file identity examples:
  `thr_…:path` for unframed bare paths, `thr_…:workspace:path` and
  `thr_…:thread-storage:path` for explicitly framed or absolute destinations.
  Unframed bare paths resolve storage-first, then workspace, because the pure
  linker cannot know which file exists. Framed identities resolve only in the
  named root. To keep this grammar unambiguous, Thread Brief rejects unframed
  paths whose first segment is literally `workspace:` or `thread-storage:`.
  Built-in resolution derives the frame from the id; `context.threadId` is
  attribution only. A `bb.thread` resolver checks the target id independently
  of that context. A consumer ignores contributed advertisements and candidates
  for a reserved provider it implements itself.

### 3.2 Spans

`{start, end}` are UTF-16 code unit offsets into the exact `text` sent to
linkify, `end` exclusive, `0 ≤ start < end ≤ text.length`. Every candidate also
carries `match`, and `text.slice(start, end) === match` must hold. Consumers
translate offsets back to their own document (e.g. add a window offset).

### 3.3 Safe link targets (carried over unchanged)

- `SafeHref`: absolute `http:`/`https:` without credentials, or a root-relative
  BB route; rejects protocol-relative URLs, backslashes, control characters,
  whitespace and encoded leading slashes.
- `FileTarget`: `{kind:'workspace', environmentId, path}` or
  `{kind:'thread-storage', threadId, path}`. A target is not a permission and
  does not prove the file exists; the resolver checks containment and existence
  on the right host before returning one. A saved-projection supplier may instead
  return the target recorded by a verified export, disclosing the projection age
  and that current source existence is not re-checked. It performs no resolve-time
  source stat or read; the native file opener handles a missing file.

### 3.4 Reasons (closed codes)

`{code, summary}` with `summary` ≤ 512 characters. Codes:

| Code | Meaning |
|---|---|
| `not-found` | The source says the referent does not exist. |
| `forbidden` | The supplier's own credentials cannot read it. |
| `unauthenticated` | The supplier has no usable credentials configured. |
| `rate-limited` | The source is throttling the supplier. |
| `timeout` | The supplier's own read exceeded its budget. |
| `source-error` | The source failed for another reason. |
| `unsupported` | Recognized namespace, but this kind or form is not supported. |
| `stale` | Data served from the supplier's cache past its freshness. |
| `informational` | Neutral note (e.g. "Projection from 2 h ago"). |

Outputs tolerate unknown codes by mapping them to `source-error` on decode;
inputs never contain reasons.

## 4. Discovery

### 4.1 Describe

Method `contextRecognitionDescribe`, input `null` (anything is ignored).

```ts
// Envelope: parsed tolerantly. Capabilities decoded only under a negotiated version.
type DescribeEnvelope = { protocol: 'bb-context-recognition'; versions: number[]; capabilities: unknown };
// versions: 1..16 integers in 1..1000

type CapabilitiesV1 = {
  revision: string;                 // 1..64, changes whenever recognition rules or card shape change
  linkify?: { providers: ProviderClaimV1[] };   // absent = no linkify stage
  resolve?: { providers: ProviderClaimV1[] };   // absent = no resolve stage
};
type ProviderClaimV1 = {
  provider: string;                 // §3.1 grammar; unique within the list
  kinds: string[];                  // 1..16 kind tokens
  specificity?: 'typed' | 'generic';  // linkify only; default 'typed'
};
```

At least one of `linkify` / `resolve` must be present; each list holds 1–16
claims. `negotiateVersion(envelope, [1])` returns `max(shared)`:

| `versions` | Result |
|---|---|
| `[1]`, `[1,2]` | v1, capabilities decoded with `CapabilitiesV1` |
| `[2]` | `incompatible(version)`; capabilities not decoded |
| `[]`, `[0]`, non-integers, > 16 entries, wrong `protocol` | `incompatible(schema)` |

### 4.2 Enumeration

`enumerateRecognitionSuppliers({sdk, owner, signal, onRow, onProgress, exclude, knownAbsent, previouslyReady})`:

`owner` is a per-consumer handle from `createRecognitionDiscoveryOwner()`. It
owns only the current pass generation and abort controller; consumers dispose it
on release. Consumers sharing an SDK use separate owners, never a global registry.

1. Call `sdk.plugins.list()` once per pass.
2. Probe every plugin whose status is `running` (or `degraded`), excluding the
   consumer's own id. Previously ready IDs go first, then unknown IDs; each
   group is sorted by ID. Explicit consumer-owned `knownAbsent` IDs are skipped
   until a relevant `plugins-changed` event (or a whole-list invalidation) clears
   them. `previouslyReady` takes precedence over a contradictory absent entry.
3. Describe with concurrency `LIMITS.concurrency` and at most `LIMITS.describeMs`
   per call, under a `LIMITS.discoveryMs` discovery slice. Targets not reached
   remain `pending`; an immediate continuation of the same generation opens
   another slice. This is a finite drain of the one listed set, not polling or
   retrying completed failures. Cancellation fences the entire drain.
   `LIMITS.plugins` caps **ready suppliers admitted per consumer**, not targets
   probed. Admission uses the same priority order; excess ready rows have
   `admitted: false` and contribute no routes. They remain visible diagnostics.
4. Rows are keyed by **target plugin id**; names inside describe are not trusted
   as the key. `onRow` fires per plugin so a slow supplier never hides others.
   `onProgress` supplies isolated row and route snapshots as states settle,
   after initializing the entire pending/known-absent inventory once. Eligible
   IDs are ordered once per pass. Settlement snapshots are coalesced over
   16 ms, with immediate initial, continuation and final flushes; no timer
   survives the pass and stale generations publish nothing. `onRow` retains
   individual initial and settlement transitions. Snapshots include
   admission/contested-provider changes. Consumers may patch a late
   supplier immediately without waiting for the drain to finish. `omittedCount`
   counts ready suppliers excluded by admission, not absent plugins or the
   excluded consumer. Cache inputs are explicit ID collections; the helper has
   no SDK-global cache or scheduler.
5. Each pass carries a generation token; starting a pass aborts the previous one
   and drops its late rows.

Per-plugin states:

| State | Cause | Consumer behaviour |
|---|---|---|
| `ready` | Negotiated v1, valid capabilities | Participates |
| `absent` | `unknown_method` on describe | Not a supplier; cached until lifecycle change |
| `incompatible` | Version or schema mismatch | Excluded; one diagnostic |
| `unavailable` | Disabled / not running | Excluded |
| `transient` | Timeout, network, unclassified 5xx other than 500 | Excluded this pass; bounded retry (§4.4) |
| `error` | Supplier fault (any otherwise unclassified 500, including empty bodies) | Excluded; diagnostic |
| `contested` | Provider claimed for **resolve** by > 1 ready plugin | That provider has no resolver; claims for other providers still count |

Contested resolution is deliberately conservative: the consumer renders the
candidate without a card and reports both plugin ids, instead of letting
install order pick a winner. Contested **linkify** claims are fine; arbitration
(§5.4) handles them.

### 4.3 Error classification

`classifyRecognitionError(error)` uses native status **and** body shape:

| Status and body | Kind |
|---|---|
| 404, `body.error.code === 'unknown_method'` | `absent` |
| 404, string body naming an unknown plugin | `vanished` (treated as `unavailable`) |
| Generic 404 `not_found` | `host-incompatible` |
| 503, string body `not running (status: X)` | `unavailable` |
| 400 `invalid_input`, 500 `invalid_output`, local output-schema failure, result bytes over limit | `incompatible` |
| Other 500 | `error` |
| 401 / 403 | `unauthorized` (treated as `error`; never a viewer gate) |
| `AbortError` from the consumer's signal | `cancelled` (no state change) |
| Network failure or deadline | `transient` |

### 4.4 Triggers

Discovery runs on consumer start, on `system:changed` with `plugins-changed`,
on realtime reconnect and on explicit user retry. A `transient` row gets at most
three backoff retries (1 s, 4 s, 16 s); after that it waits for the next trigger.
There is no polling or periodic re-describe beyond these bounded retries;
retry scheduling belongs to the consumer, never to the package runners.

## 5. Stage 1: linkify

### 5.1 Method and input

Method `contextRecognitionV1Linkify`. Input is strict (unknown fields rejected).

```ts
type LinkifyInputV1 = {
  version: 1;
  text: string;                     // ≤ LIMITS.textChars UTF-16 units
  format: 'markdown' | 'plain';     // a hint; linkifiers still treat text as characters
  excluded: Span[];                 // ≤ LIMITS.excludedRanges, sorted, non-overlapping
  context: ContextBundleV1;
};

type ContextBundleV1 = {
  consumer: { pluginId: string; surface?: string };   // attribution: 'thread-brief' / 'document'
  threadId?: string;
  projectId?: string;
  environmentId?: string;
  git?: {
    branch?: string;                                   // current branch, ≤ 256
    upstream?: { remote: string; branch: string };     // tracking ref of the current branch
    remotes: { name: string; url: string }[];          // ≤ LIMITS.remotes, credentials stripped
  };
  links: { href: SafeHref; span?: Span }[];            // links already present, ≤ LIMITS.links
  locale?: string;                                     // BCP 47, ≤ 35
  timeZone?: string;                                   // IANA, ≤ 64
};
```

Consumer duties when building input:

- **Excluded ranges** cover code spans and blocks, raw HTML, explicit Markdown
  links/images/definitions and anything else the consumer will not turn into a
  mention. Plain autolinked URLs stay eligible.
- **`links`** lists the hrefs of links already in the text (explicit and
  autolinks), with their spans when they are inside this text. They are
  evidence for inference; an autolink in eligible text may also be a candidate.
- **`git`** is read by the consumer from the frame the text belongs to (Thread
  Brief: the thread's environment, through its own host worker). Remote URLs
  have userinfo and tokens removed. `git` is omitted when there is no
  repository; a linkifier must work without it.
- **No clock.** There is no `now`; linkify output must not depend on time.
- Texts longer than `LIMITS.textChars` are split by the consumer at block
  boundaries into at most `LIMITS.windows` windows; each window is a separate
  call with the same bundle.

### 5.2 Output

```ts
type LinkifyOutputV1 = { candidates: CandidateV1[] };   // ≤ LIMITS.candidatesPerCall

type CandidateV1 = {
  span: Span;
  match: string;                    // exact text at span
  source: SourceIdentity;           // canonical identity (§3.1)
  confidence: 'high' | 'medium' | 'low';
  provenance: {
    basis: 'explicit' | 'text-url' | 'existing-link' | 'git-remote' | 'context';
    explanation: string;            // 1..200, shown to the user for non-explicit bases
    evidence?: { span?: Span; link?: number; remote?: string };
  };
};
```

| `basis` | Meaning | Example |
|---|---|---|
| `explicit` | The text alone, read in the consumer's frame, names the referent | `phosphorco/bb-plugins#312`, a GitHub PR URL, `plans/x.plan.pkl` in an environment |
| `text-url` | Completed from a URL elsewhere in `text` (`evidence.span`) | `#312` → repo of the nearest GitHub URL |
| `existing-link` | Completed from `context.links[evidence.link]` | `#312` next to `[the PR](https://github.com/…/pull/310)` |
| `git-remote` | Completed from `context.git` (`evidence.remote`) | `#4` → upstream remote of the current branch |
| `context` | Completed from another bundle field (thread, environment) | A bare node id resolved against the thread's only plan |

Every basis except `explicit` is **inferred**. Inferred candidates should not
use `high` confidence.

### 5.3 Linkifier obligations

1. **Pure and deterministic.** No I/O. Identical input yields byte-identical
   canonical output. The conformance kit calls twice and compares.
2. Candidates lie inside `text`, satisfy `match`, and do not intersect any
   `excluded` span.
3. Only providers the plugin advertised for `linkify` appear in `source`.
4. **At most one candidate per span per plugin.** A plugin that sees two
   plausible identities for one span chooses one and says why in
   `explanation`. Alternatives are reserved for a later version.
5. Candidates from one plugin may overlap each other; the consumer arbitrates.
6. Output is sorted by `(start, end)`; the consumer re-validates anyway.

### 5.4 Arbitration (consumer, pure `arbitrate`)

The consumer collects candidates from built-in handlers and every ready
contributed linkifier, tagging each with `origin: 'builtin' | 'contributed'`,
`pluginId`, the claim's `specificity`, and its advertised `providers` list. `arbitrate(tagged, {text, excluded, implementedProviders?})`
is deterministic. The optional `implementedProviders` names built-in providers
that may return no candidates for this text; built-in tagged claims are also
considered, so reserved-provider filtering never requires a fabricated match:

1. **Check.** Drop candidates that fail §5.3 (2) or (3), reserved-provider
   candidates from contributed plugins that the consumer implements, and
   providers the plugin did not advertise. Count drops per plugin.
2. **Merge duplicates.** Candidates with the same span and identity key become
   one; the best-ranked provenance is kept and the other plugin ids are listed
   in `alsoBy`.
3. **Rank** with this total order (first difference wins):
   1. longer span first (maximal munch),
   2. `explicit` before inferred,
   3. `typed` before `generic` specificity,
   4. confidence `high` > `medium` > `low`,
   5. earlier `start`,
   6. `builtin` before `contributed`,
   7. `pluginId`, then `provider`, then `id`, by UTF-16 code unit comparison.
4. **Select.** Walk in rank order; accept a candidate if its span does not
   overlap an accepted one.
5. **Fallback.** For each accepted candidate, consider rejected candidates
   with the **identical span** and a different identity. Prefer the best-ranked
   `builtin` candidate with `generic` specificity if present; otherwise use
   the best-ranked other candidate. Keep at most one `fallback`. The primary
   ranking above is unchanged. This native fallback floor preserves navigation
   when several typed suppliers claim a span and typed resolution fails.
6. **Emit** occurrences sorted by `start`, plus the unique set of identities
   (primaries and fallbacks) in first-occurrence order.

Generic claims are recognizers that match a whole class without knowing the
referent: Thread Brief's built-in file paths, a plain URL recognizer. A typed
claim knows its referent type. This is what lets a plan path become a plan card
while keeping the file link as fallback (§11.3).

Consumers own occurrence and card caps (Thread Brief keeps its document limits, e.g. 8 cards).
Low-confidence candidates may be rendered as plain text with a hint instead of a
link; that is consumer policy.

## 6. Stage 2: resolve

### 6.1 Method and input

Method `contextRecognitionV1Resolve`. Strict input:

```ts
type ResolveInputV1 = {
  version: 1;
  context: { consumer: { pluginId: string; surface?: string }; threadId?: string; locale?: string; timeZone?: string };
  sources: SourceIdentity[];        // 1..LIMITS.identitiesPerResolve, unique identity keys
  detail: 'label' | 'card';         // 'label' asks for label/href/target only
};
```

There is no span, mention text or git bundle: resolution depends on identity
only, so results can be shared across documents and consumers. The context is
attribution and formatting only.

### 6.2 Output

```ts
type ResolveOutputV1 = { resolutions: ResolutionV1[] };

type ResolutionV1 = {
  source: SourceIdentity;           // echoes the requested provider and id
  state: 'ready' | 'unrecognized' | 'unavailable';
  kind?: string;                    // authoritative kind, e.g. 'pull-request'
  revision?: string;                // ≤ 256, source revision (etag, updated_at, ledger digest)
  label?: string;                   // ≤ 256, short inline text
  href?: SafeHref;
  fileTarget?: FileTarget;
  card?: CardV1;                    // only when detail = 'card' and state = 'ready'
  maxAgeSeconds?: number;           // 0..3600 freshness hint for consumer caches
  reasons: Reason[];                // ≤ 8, may be empty
};

type CardV1 = {
  title: string;                    // 1..256
  subtitle?: string;                // ≤ 512
  status?: string;                  // ≤ 256, e.g. 'Merged'
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';
  meta?: { label: string; value: string }[];   // ≤ 8
  updatedAt?: string;               // ISO 8601 with offset
  excerptMarkdown?: string;         // ≤ 1024 UTF-16; sanitized by the consumer
};
```

| State | Meaning | Consumer renders |
|---|---|---|
| `ready` | Referent exists and was read | Link/card from the resolution |
| `unrecognized` | Identity is not one this resolver knows (wrong form, foreign id) | Fallback if any, else plain text |
| `unavailable` | Recognized but cannot be shown now (`reasons` say why) | Fallback if any, else plain text or a muted mention with the reason |

Resolver obligations:

1. Return **at most one resolution per requested identity**, echoing its
   provider and id. Omitted identities are treated as transient, not negative.
2. Never return unrequested identities; the consumer rejects the whole response
   if it does.
3. Reads are GET-only and side-effect free; no writes, no expensive catalog or
   export to answer a resolve.
4. Respect `LIMITS.resolveMs` and return `unavailable` + `timeout` for items it
   could not finish, rather than letting the call run out.
5. Cards are plain data; never HTML, scripts, components or callbacks. Markdown
   in `excerptMarkdown` is never trusted: consumers sanitize, and excerpts
   never recruit further mentions (depth 1).

### 6.3 Routing

The consumer sends each identity to the single ready plugin that claims its
provider for `resolve` (or to its built-in for reserved providers). Linkifier
and resolver may be different plugins. Identities whose provider has no resolver
or is `contested` are not sent; they render from the candidate alone (plain text
or a bare `href` the consumer can derive itself). Identities are grouped per
resolver and split into batches of `LIMITS.identitiesPerResolve`.

## 7. `/bb` helpers: registration, clients, stage runners

```ts
registerRecognitionSupplier(bb, {
  revision: 'github-review/1',
  linkify?: { providers: ProviderClaimV1[]; handler(input: LinkifyInputV1, signal): LinkifyOutputV1 | Promise<LinkifyOutputV1> },
  resolve?: { providers: ProviderClaimV1[]; handler(input: ResolveInputV1, signal): Promise<ResolveOutputV1> },
});
```

- **Registration** adds the three fixed methods through `bb.rpc.register` with
  strict input schemas and `experimental_discoverable: true` as inert metadata
  (callers never use `experimental_discoverRpc`). One registration per plugin,
  so a plugin has exactly one describe. Handlers receive explicit input only
  and throw only for genuine faults. The public SDK registration accepts input
  only: this helper supplies a registration-owned per-call deadline signal
  (`linkifyMs` / `resolveMs`) and cleans it up on settlement. Caller cancellation
  is enforced locally by clients/runners; the SDK does not propagate it to the
  remote handler. Calling a stage absent from the advertised capabilities is
  programmer misuse (`UnsupportedStageError`); all three methods are registered.
- **Clients.** `createSupplierClient(sdk, pluginId)` binds
  `sdk.plugins.callRpc({pluginId, method, input, outputSchema, signal})` to one
  target. Shared code never uses slot-scoped hooks (`useRpc`,
  `experimental_usePluginId`).
- **Stage runners.** `linkifyAll({clients, builtins, input, signal, budgets})`
  and `resolveAll({routes, sources, detail, context, signal, budgets})` apply
  isolation once: each call has its own deadline and abort; each call passes
  `outputSchema: z.unknown()` (the SDK requires one) so the result arrives
  unchanged as `unknown`; its canonical JSON UTF-8 size
  is checked against `LIMITS.responseBytes` before any DTO decoding, then it is
  validated against the package schema; outputs are validated
  and resolve output is correlated with the request; a slow, failing or
  malformed supplier yields a per-plugin outcome and never removes other
  suppliers' results. They return `{results, outcomes}` and never cache,
  schedule, retry or render. Budgets default to `LIMITS` and may only be lowered. A consumer chaining
  linkify and resolve supplies the same `budgets.overallDeadline` in both calls
  (absolute `performance.now()` timebase) to enforce their shared `overallMs`
  window; independent calls have independent windows, with no hidden shared state.
- **Built-ins** have the same handler signature, so a consumer's built-ins and
  contributions run through one path and one arbitration.

## 8. Limits

`LIMITS` is exported from the root; schemas enforce the data bounds, runners
enforce the time bounds. Discovery admission, concurrency and time budgets are
consumer policy; they are not wire DTO bounds.

| Limit | Value | Applies to |
|---|---|---|
| `plugins` | 32 | Ready suppliers admitted per consumer (discovery policy) |
| `concurrency` | 4 | Parallel calls per stage |
| `describeMs` | 500 | Per describe |
| `discoveryMs` | 3000 | Each immediate discovery continuation slice |
| `linkifyMs` | 500 | Per linkify call |
| `linkifyStageMs` | 1500 | All linkify calls for one text |
| `resolveMs` | 1500 | Per resolve call |
| `resolveStageMs` | 4000 | All resolve calls for one text |
| `overallMs` | 6000 | Linkify + resolve for one text |
| `textChars` | 65 536 | UTF-16 units per linkify call |
| `windows` | 16 | Linkify windows per text |
| `excludedRanges` | 512 | Per linkify call |
| `links` / `remotes` | 64 / 8 | Context bundle |
| `candidatesPerCall` | 64 | Linkify output |
| `identitiesPerResolve` | 32 | Resolve input and output |
| `responseBytes` | 65 536 | Canonical-JSON UTF-8 bytes of any decoded RPC result, checked before DTO decoding |
| `explanationChars` / `excerptChars` | 200 / 1024 | DTO text |
| `reasonCount` / `metaEntries` | 8 / 8 | Resolution |
| `providersPerClaim` / `kindsPerProvider` | 16 / 16 | Describe |

Oversized data is rejected, never clipped by the package. A consumer may clip
its own presentation.

**Transport boundary.** The public `sdk.plugins.callRpc` parses the JSON
envelope before returning, and exposes no raw-byte or size option, so the
package cannot bound raw transport bytes or whitespace. Raw pre-parse admission
belongs to the BB host's RPC layer and is outside this contract; the package
guarantees only the canonical-result cap above. (SDK 0.5.29 offers no raw access.)

## 9. Performance and caching

- **Where.** Both stages run **server-side, once per text revision**, in the
  consumer's server. The browser receives one ready model; no per-viewer or
  per-view RPC fan-out. Because identity is attribution only, results are not
  fenced per viewer.
- **Linkify cache key** = SHA-256 of
  `canonicalJson([wireVersion, pluginId, capabilities.revision, sha256(text), excluded, contextBundle])`.
  The bundle includes `git` and `links`, so a branch or remote change yields a
  new key. Because linkify is pure, a hit is always valid until the plugin's
  revision changes.
- **Resolve cache key** = `(pluginId, capabilities.revision, identityKey, detail)`.
  Lifetimes: `ready` for `min(maxAgeSeconds ?? 60, consumer cap)`;
  `unrecognized` until the plugin revision changes; `unavailable` ≤ 30 s;
  transport failures, omissions and timeouts are not cached.
- **Invalidation triggers.** Text revision; context bundle change (the consumer
  rebuilds the bundle on environment change and at each text revision; see
  open question 1 for branch switches between revisions); `plugins-changed`
  (drop that plugin's describe row and its cache entries); explicit retry.
- **Fallback cost.** Built-in fallbacks are cheap and may be resolved eagerly
  in the same pass so a failed typed resolve still paints a link on first
  paint. Fallback identities count toward `identitiesPerResolve`.
- **Zero suppliers** is the common case and costs one `plugins.list()` per
  discovery trigger plus the built-ins.

## 10. Versioning

| Change | Mechanism |
|---|---|
| Added optional output field | Same wire version; outputs tolerate unknown fields |
| Added input field, changed meaning, new required field | New wire version and new method names (`…V2Linkify`) |
| New reason code, basis or tone | New wire version (decoders map unknown reasons to `source-error`, but bases and tones are strict) |
| New entry or helper, changed discovery policy | New package version; wire data bounds do not change within wire v1 |

Suppliers may advertise `[1, 2]` and serve both. Consumers negotiate per
plugin. Package `0.x` minors may add helpers; exports and peer ranges stay
stable within a version. Consumers pin an exact registry version.

## 11. Worked examples

### 11.1 Bare `#N` (contextual expansion), GitHub Review supplier

GitHub Review's policy (supplier-owned, §1), a bare `#N` takes
the repository of the nearest GitHub URL in the text or `context.links`
(`nearestSpan`, ties to the preceding one); else the current branch's upstream
remote; else `origin`; else the only remote; else no candidate.

Text A: `Follows https://github.com/phosphorco/bb-plugins/pull/310; see also #312.`
(the URL is also in `links` with span 8–57). Linkify output:

```json
{ "candidates": [
  { "span": {"start":8,"end":57}, "match": "https://github.com/phosphorco/bb-plugins/pull/310",
    "source": {"provider":"github","id":"github.com/phosphorco/bb-plugins#310","kind":"pull-request"},
    "confidence": "high", "provenance": {"basis":"explicit","explanation":"GitHub pull request URL."} },
  { "span": {"start":68,"end":72}, "match": "#312",
    "source": {"provider":"github","id":"github.com/phosphorco/bb-plugins#312"}, "confidence": "medium",
    "provenance": {"basis":"text-url","explanation":"Repository from the nearest GitHub link (phosphorco/bb-plugins).",
                   "evidence": {"span": {"start":8,"end":57}}} } ] }
```

Text B: `Remaining: #4.` with no GitHub URL, environment on branch `brief-suppliers`
tracking `origin/brief-suppliers`, bundle
`git: {branch:'brief-suppliers', upstream:{remote:'origin', branch:'brief-suppliers'}, remotes:[{name:'origin', url:'git@github.com:phosphorco/bb-community-plugins.git'}]}`:

```json
{ "span": {"start":11,"end":13}, "match": "#4",
  "source": {"provider":"github","id":"github.com/phosphorco/bb-community-plugins#4"}, "confidence": "low",
  "provenance": {"basis":"git-remote","explanation":"Repository from origin, the upstream of branch brief-suppliers.",
                 "evidence": {"remote":"origin"}} }
```

No competitors, so arbitration keeps every candidate. Thread Brief resolves
them with one `github-review` call (`detail: 'card'`). Resolution for `#312`:

```json
{ "source": {"provider":"github","id":"github.com/phosphorco/bb-plugins#312"},
  "state": "ready", "kind": "issue", "revision": "2026-10-06T16:02:11Z",
  "label": "phosphorco/bb-plugins#312", "href": "https://github.com/phosphorco/bb-plugins/issues/312",
  "card": { "title": "Brief cards drop on transient describe", "subtitle": "phosphorco/bb-plugins · issue #312",
            "status": "Open", "tone": "success", "updatedAt": "2026-10-06T16:02:11Z" },
  "maxAgeSeconds": 120, "reasons": [] }
```

Without Issues read scope the same identity is `unavailable` with
`{code:'forbidden', summary:'GitHub token cannot read issues in phosphorco/bb-plugins.'}`.
Thread Brief shows the card and the inferred provenance line ("Repository from
the nearest GitHub link"). Switching to a branch that tracks another repository
changes the bundle hash, so the next linkify of text B yields a new identity.

### 11.2 GitHub URL in prose

`https://github.com/phosphorco/bb-plugins/pull/310` is a plain autolink, so it
is eligible. GitHub Review returns the `explicit`, `high`, typed candidate
above. If a consumer also runs a generic URL recognizer, both share a span;
rank step 3 (`typed` before `generic`) picks GitHub, and the generic URL
becomes the fallback, so an unavailable card still leaves a working link. The
same URL inside `[the PR](…)` is excluded text and only appears in
`context.links`.

### 11.3 Bare `plans/x.plan.pkl` vs Thread Brief's file linkifier

Text: `Plan: plans/x.plan.pkl` in thread `thr_example`, whose environment is
`env_abc123`.

| Origin | Candidate | Claim |
|---|---|---|
| Thread Brief built-in | `bb.file` id `thr_example:plans/x.plan.pkl`, `explicit`, `high` | `generic` |
| Plan Graph | `plan-graph` id `env_abc123:plans/x.plan.pkl`, kind `plan`, `explicit`, `high` | `typed` |

The thread-framed `bb.file` identity and environment-framed `plan-graph`
identity deliberately differ. Arbitration joins them only as primary and
fallback for this occurrence, without equating their identity keys.

Same span, same length, both explicit; step 3 makes Plan Graph primary and
`bb.file` its fallback. Thread Brief resolves both in one pass (the file
resolver is a cheap built-in). Plan Graph returns a card (title, goal,
ready/blocked/done counts, next ready node, projection freshness as an
`informational` reason) with `fileTarget: {kind:'workspace', environmentId:'env_abc123', path:'plans/x.plan.pkl'}`
so the file still opens. If Plan Graph is disabled, slow, or returns
`unavailable` (no saved projection), the occurrence renders from the `bb.file`
fallback as today's file link. This is the "card upgrade": the generic file link
is the floor, the typed card replaces it when it resolves.

### 11.4 `@thread:` built-in

`@thread:thr_example` is recognized by Thread Brief's built-in linkifier as
`bb.thread` / `thr_example` / `session`, `explicit`, `high`, typed. `bb.thread`
is reserved, so any contributed candidate for it is dropped at step 1. The
built-in resolver checks that target thread independently of the attribution
`context.threadId`, then produces its native card (title, status, brief excerpt).
Contributed linkifiers may still claim *other* providers on
overlapping text; maximal munch and rank decide as usual.

## 12. Migration from `@phosphorco/bb-brief-references`

| bb-brief-references | bb-context-recognition | Note |
|---|---|---|
| `resourcePresentation.v1.describe` → `{protocol:1, providers:[{provider,kinds,mentions:{prefixes}}]}` | `contextRecognitionDescribe` → envelope with `versions` and `CapabilitiesV1` | Tolerant envelope and negotiation added |
| `mentions.prefixes` literal hints | **Dropped.** Replaced by the linkify stage | Prefixes could not express bare `#N`, `owner/repo#N` or `.plan.pkl` suffixes |
| Consumer-side hint matching in `recognizeReferenceText` | Built-in linkifiers through `linkifyAll` + `arbitrate` | One path for built-in and contributed |
| `Source {provider,id,kind,label?,path?}`, kind ∈ `file/session/trigger/other` | `SourceIdentity {provider,id,kind?}`, open kind token | `label`/`path` move to resolution; identity key drops `kind` |
| `Recruitment {kind:'mention',text,span}` sent to resolve | `CandidateV1` (span, match, confidence, provenance); not sent to resolve | Resolve depends on identity only |
| `resourcePresentation.v1.resolve` `{sourceThreadId, references, presentations:['web']}` | `contextRecognitionV1Resolve` `{version, context, sources, detail}` | `sourceThreadId` becomes attribution-only `context.threadId` |
| `Resolution.web` | `ResolutionV1.card` + `tone`; `kind`, `maxAgeSeconds` added | Field names otherwise unchanged |
| `Resolution.body` | **Dropped** (never rendered) | Reserved for a future projection method |
| `SafeHrefSchema`, `FileTargetSchema`, `revision`, states | Unchanged | |
| Open `Reason.code` | Closed codes (§3.4) | Thread Brief built-ins map `thread`/`file` to `informational` |
| Viewer access fencing in README | Removed | Identity is attribution only (design decision) |
| Ambiguous provider → silently dropped | `contested` state with diagnostic | |
| One describe failure aborts the pass (Thread Brief today) | Per-plugin outcomes | |

Thread Brief retires the old package in the same change that adopts this one;
no supplier ever shipped against the old protocol beyond Thread Brief's own
built-ins, so no compatibility shim is provided.

## 13. Conformance kit (`/testing`)

- `runSupplierConformance({pluginId, register, linkifyCases?, resolveCases?})`
  installs the plugin's **real** registration into `createFakePluginHost` and
  calls it through the SDK client. It never reimplements a handler.
- Describe: envelope shape, negotiation fixtures (`[1]`, `[1,2]`, `[2]`, `[]`,
  `[0]`, non-integer, 17 entries), claims within limits, reserved `bb.*` claims
  reported as a conformance failure for contributed suppliers.
- Linkify: schema validity; spans inside text with exact `match`; no candidate
  intersects `excluded`; only advertised providers; at most one candidate per
  span; identical canonical JSON on a repeated call; each supplied call is locally
  bounded by `linkifyMs`; strict input rejection of unknown fields; behaviour with no
  `git` and with empty `links`.
- Resolve: at most one resolution per requested identity; omissions allowed
  as transient outcomes; no unrequested identities;
  `card` only for `detail:'card'`; closed reason codes; response bytes within
  limit; each supplied call is locally bounded by `resolveMs`. The kit does
  not inject source stalls, prove remote cancellation, or verify that a
  supplier converts its own deadline into per-item `timeout` reasons.
- Malformed-input probes accept structured `invalid_input` (the SDK error
  code or transport body) or a named `ZodError` with structured validation
  issues. Generic faults, message matches and timeouts are failures. The kit
  cannot prove the absence of handler I/O or all supplier policy from probes.
- Arbitration vectors: shared JSON fixtures for `arbitrate` (overlap, containment,
  equal span typed vs generic, explicit vs inferred, duplicates across plugins,
  fallbacks) that consumers in any repository can replay.
- Kit results are **source conformance**. They are not host, network or live
  proof (bb-plugin-contracts proof levels).

Host proof (Thread Brief) separately covers zero, one, failing, slow, malformed,
contested and multiple suppliers, and a live machine run covers the composition.

## 14. Out of scope (v1)

Viewer authorization, agent or model delivery of references, multiple
alternatives per span, search or autocomplete, cross-document relationship
storage (Cross References' domain), React components, frontend leases,
recursive resolution of excerpts, writes of any kind, polling, and fork changes.

## 15. Design decisions

1. **Branch switches between revisions.** Thread Brief's host worker watches
   the environment repository's `HEAD` (and the current branch's upstream
   config) with its existing host-watch mechanism; a change rebuilds the
   context bundle and re-linkifies the retained text. No polling.
2. **Contested resolvers.** Keep v1's conservative rule: no card, both plugin
   ids in the diagnostic. Native `github` does not implement this contract, so
   contention only arises between our own plugins and is fixed at the source.
   An operator choice is deferred until a real contention exists.
3. **GitHub id grammar.** Keep `github.com/owner/repo#N`. The host segment is
   part of the canonical id so Enterprise hosts never collide.
4. **Plan Graph identity.** Keep `env_…:path` for v1. Cross-environment and
   cross-host plan references are out of scope until a consumer needs them.
5. **Low-confidence rendering.** Link every accepted candidate. Thread Brief
   marks inferred candidates (any basis other than `explicit`) with a subtle
   "inferred" affordance whose tooltip is the provenance explanation, so a
   wrong guess is visible rather than hidden as plain text.

Explicit Markdown destinations may be submitted as separate linkify windows
by a consumer, using the existing text/context input. This is consumer policy,
not a wire extension. The consumer preserves authored hrefs, titles and anchor
children, classifies local fragments and native routes, retains filesystem
frames, and applies its document-wide budgets. Images, definitions and raw
HTML admission likewise belong to the consumer.

Package 0.2.0 changes discovery admission and adds explicit cache inputs and
progressive continuation snapshots. RPC names and wire v1 DTO bounds remain unchanged.

Package 0.3.0 adds the identical-span native fallback floor, stricter conformance
validation evidence and coalesced discovery snapshots. Wire v1 DTOs, RPC names,
entry exports and peer range remain unchanged. Package verification includes
emitted-entry tests and a disposable consumer that installs the npm tarball and
SDK 0.5.29 and imports all three entries. The 500/2000 eligible-plugin benchmark
reports sample timing and callback/row counts; it is not a universal CPU bound
or live SDK compatibility proof.
