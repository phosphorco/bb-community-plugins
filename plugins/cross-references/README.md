# Cross References

Cross References makes the surrounding context of BB work visible and
navigable. While looking at a conversation, page, or resource, a person should
be able to tell whether it is mentioned elsewhere and whether it participates
in something larger than the thing directly in front of them. A directional
reference supplies that useful context at both ends.

It is not a replacement for a URL inspector or a collection of bookmarks.
It is the shared navigation layer built from observed and authored references.

## Shared package

`@phosphorco/bb-cross-references@0.2.0` provides the canonical resource/projection
contract, explicit SDK client, conformance kit, and `LinkedReferences` React
editor. This plugin owns the graph service and persistence; Machine Monitor and
Prompt Rules own their local attachments and delivery. See the
[package contract](../../packages/bb-cross-references/CONTRACT.md).

## Product doctrine

### Make the surrounding context visible

Cross References exists to answer a simple orienting question: **what is
happening around the thing I am looking at?** A forward reference reveals what
the current context reaches toward. A backlink reveals where the current thing
has been brought into another context. Future containment and rollup views can
show the larger work a resource participates in without losing the exact
reference that established the connection.

The goal is not to create a graph for its own sake, or to make people leave
their current work to search for context. It is to make relevant surrounding
activity legible where they already are.

### A reference starts at its source

An assistant message that includes a URL has made a claim of relevance: this
conversation points to that resource. That observed URL is a **forward
reference** of the conversation. A user-created attachment or a link from
another BB surface is the same kind of claim, even when it was created through
a different product feature.

The source owns the claim. It decides the complete set of references it
currently contributes and publishes a durable projection of that set. Cross
References should not guess at, rewrite, or silently manufacture claims on a
source's behalf.

### A thread link is naturally a backlink

When a forward reference targets another BB thread, the target thread should
show the source conversation as an incoming **backlink**. This is not a second
or reversed edge stored in the database. It is the other view of the same
directed occurrence:

```text
source conversation ──forward reference──▶ target thread
target thread      ◀────────backlink──── source conversation
```

The direction preserves meaning. “This conversation cites that thread” is not
the same claim as “that thread cites this conversation.” Both views are
valuable, but one durable fact supplies them.

### Conversation mentions and recency

Cross References collects settled user and assistant conversation rows through
BB's public timeline API. Ordinary agent relays arriving as user text count;
native system notifications, tool/work rows and nested transcripts do not.
It walks positioned Markdown/GFM and calls the shared context-recognition
linkify stage on eligible text and authored link destinations. Recognition
suppliers own contextual PR and other typed grammars; collection never fetches
PR metadata or calls card resolution. With no suppliers, native thread mentions,
bare generated thread IDs, file candidates and safe web links remain available.
Local thread targets are verified against an existing thread/project before
becoming native `bb` references. No Brief or Linky collection runs in this phase.

Fenced, indented and inline code, standalone images, **linked images (including
the outer link destination)**, definitions and raw HTML are excluded. Excluding
linked-image destinations is a behavior change from the earlier assistant-only
Markdown walker. Ordinary reference-style links still count at each use, with
spans at that use rather than at the definition. Offsets address original UTF-16
source text. A location keeps row ID, actual role and `messageSeq`; its exact
native route is `/projects/P/threads/T#msg=N`. Pagination/source-range metadata
is not a substitute for `messageSeq`. Missing message sequences are disclosed
as incomplete collection, with prior evidence retained.

One source/target edge per producer supplies the existing distinct-resource
counts and latest source-message time. Repeated mentions keep separate durable
locations, up to the newest 100 per producer edge; they do not inflate v1
counts. Locations and coverage have an independent evidence revision/digest,
so source/span/provenance changes do not by themselves change the graph digest.
There is no public occurrence read API or snippet display yet.

Collection is limited to known sources: idle/failed/deleted events, forward
reads and startup reconciliation of existing native/legacy sources. It does
not enumerate every thread. Each scan stops at 50 timeline pages (100 segments
per request), 5,000 messages or 2,097,152 UTF-16 units. Recognition shares 128
supplier windows and a 10-second deadline across the whole source; a message
is limited to 262,144 UTF-16 units, 16 positioned text windows and the shared
per-call candidate/context bounds. A window, candidate or exclusion cap marks
the message incomplete. The source retains at most 256 target identities and
the newest 100 locations per producer edge, with deterministic message/offset
ties. Coverage/cap reasons are stored with the evidence stream.

Incomplete scans replace only fully observed messages and retain unvisited
locations as unconfirmed within the caps. Transient supplier failures retain
prior typed locations as unconfirmed; authoritative supplier removal allows
the native fallback to replace the same observed location. A typed winner
replaces the generic claim only at its occurrence; no historical URL aliases
or external producer claims are merged. Existing legacy Thread Links claims
remain until explicit source deletion, and may have no locations. These limits
are disclosed in the References dialog. Counts and retained locations describe
indexed facts, not a complete or all-time inventory.

Supplier discovery uses package listing/probe helpers once per server lifecycle
or plugin/reconnect event, with bounded calls and cancellation. Pure successful
linkification is cached by text, context and supplier revision in a bounded
server cache. Native candidates survive supplier absence/failure. The context
includes the thread/environment IDs, eligible authored links and a sanitized
project remote hint when available; it does not scan host repositories, invent
branch/upstream metadata, or perform per-viewer supplier work. Collection jobs
live in SQLite; reload resumes pending work, and the existing job generation
fences the atomic graph/location transaction before publishing v1 changes.
Among ready jobs, viewed sources run before newly settled/deleted event sources,
then cold startup/reconnect backfill. Priority survives failure and reload;
viewing a retry never resets its backoff, attempts or generation. Background
sources remain runnable while higher-priority retries wait for their ready time.
The migration recovers legacy fresh viewed intent, but failed legacy rows did
not retain that fact; a new view request promotes those rows.

Forward references and backlinks show the latest source-message time as a
muted relative timestamp, with the full date on hover. Unknown times are omitted.

Opening Forward references performs a bounded URL status scan: one
unauthenticated GET per unique destination, up to ten, with manual redirects,
a five-second timeout, body cancellation, and a one-minute in-memory cache.
Status is ephemeral display data, never a graph fact.

Thread Links is retired on bb-machine. Its installed registration and private
data remain retained while Cross References owns new conversation-mention collection.

### References should be present only when there is a relationship to show

The compact thread-header affordance is not a permanently visible “Links”
button. It appears when the thread has one or more forward references or
backlinks, shows the two counts with distinct directional icons, and opens the
full reference view. Its absence means there is no relationship currently
known for that thread; it should not make a user wait for a separate discovery
step once a qualifying assistant URL has been observed.

### Source truth survives shared-service failure

Every producing feature retains its local truth and its own durable outbox.
Cross References provides the shared projection and reads; it never reaches
into a producer's private database. If Cross References is unavailable, a
source feature remains useful, retries delivery later, and eventually removes
references it no longer owns. This is what lets navigation be additive rather
than a new availability dependency for message links or local attachments.

## Current implementation and intended direction

The shipped proving slice already supplies the directed, source-owned model:
exact resource identity, durable complete-set projections, forward-reference
and backlink reads, source-aware invalidation, and a compact per-thread
References control. Machine Monitor remains a source adapter; Cross References
also owns its native assistant-message observations.

The lists show each exact target once in Forward references and each exact
source once in Backlinks, even when multiple producers assert the same link.
Counts and pagination use those distinct resources. The first matching
occurrence supplies the displayed label; each producer keeps its own durable
projection, so removing one assertion leaves the link visible while another
producer still supplies it.
If a producer changes while pages are loading, the list merges repeated
identities and adopts the surviving producer's complete row. Realtime refresh
reconciles removals. The first matching presentation may omit a clickable URL
even if another producer supplies one.

Automatic assistant-message observations use a small, explicit URL convention. A generic web target has exact identity
`{ provider: "url", keys: { href } }`, where `href` is the platform-normalized
HTTP(S) URL. Query and fragment remain part of identity because Cross
References does not guess which URL components are semantic. URLs with
authority credentials are sanitized before indexing; URLs with
credential-shaped query or fragment parameters, and URLs that exceed the
shared key bound, are not indexed. Cross References independently rejects
noncanonical or unsafe `url/href` targets at its RPC boundary.

For a same-installation URL that has the shape of a BB thread route, Cross
References verifies the target through BB first. A verified target is represented
by its richer `bb/{project,thread}` identity and gains the native backlink. If
verification fails, its ordinary HTTP(S) URL identity remains the forward
reference instead. This preserves the observed relationship without claiming
that an unverified route is a live BB thread.

A single supervised worker persists pending source IDs, retries failures, and
resumes after reload. Startup seeds known native and legacy source projections;
thread completion/failure/deletion events and reading a thread's forward list
also enqueue work. Each scan reads at most 50 timeline pages and publishes at
most 256 distinct targets, preferring recent links. An incomplete scan retains
previously known native references. Historical legacy assertions remain visible
until explicit source deletion, because disabling a producer preserves its last
projection. Cross References does not read the retired plugin's private data or
import its manual additions, hidden-link preferences, or edited titles.
Relative timestamps update when the view renders; there is no row timer.

## Technical contracts

[IMPLEMENTATION.md](./IMPLEMENTATION.md) is the normative, executable contract
for the current exact-reference slice. It specifies the RPC protocol,
canonicalization, storage, retries, migration rules, and current non-goals.

[ARCHITECTURE.md](./ARCHITECTURE.md) records the longer-term authority-free
resource model, including providers, exact identity, future containment, and
the constraints that keep independently authored references interoperable.

## Development

```sh
npm run test --workspace @phosphorco/bb-plugin-cross-references
npm run typecheck --workspace @phosphorco/bb-plugin-cross-references
npm run build --workspace @phosphorco/bb-plugin-cross-references
```


### Durable location caps

`mention_edge_caps` is a producer/source/target child of the evidence stream.
Rows record `capped` or `unknown`; an active edge without a row is `uncapped`.
A later incomplete scan preserves prior cap truth even if it sees at most the
retained 100 locations. Only sufficient complete observation, or that producer's
source tombstone, clears the fact. Other sources and producers keep their own
cap state. A pre-cap-migration global clipping flag cannot identify which edge
was clipped, so migration marks its existing edges `unknown` until reconciliation.
This does not claim an exact historical count.

Per-edge caps participate in evidence digest/revision and source coverage. A
cap-only change invalidates references through the existing strict changed-signal
shape with the unchanged graph revision; it does not change the v1 projection
digest, counts or resource identities. Cap rows, evidence and graph changes share
the collector's existing fenced SQLite transaction. These internal facts prepare
a future evidence read without extending any current public v1 DTO.


Keyed cap rows are bounded by the retained graph's 256-target source limit. If a
partial rotation drops a capped target, a durable source `cap_history_unknown`
bit preserves clipping uncertainty instead of accumulating inactive rows. A
returning target under partial coverage is conservatively `unknown` when its
exact history was discarded. Complete authoritative observation or that owned
source's tombstone clears this marker. It participates in evidence coverage and
digest; it is not an exact historical occurrence count. An append-only migration
compresses pre-existing inactive cap rows into the same bounded representation.


### Verified native files

Native `bb.file` candidates become graph claims only after targeted verification
of an existing, contained regular file. The unchanged shared recognizer supplies
the lexical candidate; the collector performs no bespoke file recognition.
It resolves a fresh source thread through the public SDK, then uses that thread's
storage location and environment. Included source host, environment ID/project
and host are checked before a bounded owner-bound host call. The host checks
opened file facts and realpath containment, closes the descriptor and reads no
content. There are no recursive scans, filesystem watchers or card-resolution
calls. Checks and source metadata are cached only within one source scan; repeated
mentions do not multiply I/O. All waits share the 10-second recognition deadline
and 500ms per-native-call bound, and aborted/late results cannot commit.

Unframed files use thread storage, then the source environment after an
authoritative absence. Explicit thread-storage/workspace frames pin that root
and never fall back across it. Missing/unsafe candidates are dropped; transient
verification keeps prior known evidence unconfirmed with incomplete coverage.

A verified workspace file uses the shared `verifiedFileIdentity` tuple codec
(environment ID plus canonical lexical relative path). A storage file uses its
owning thread ID plus path. Both use bounded hashed `recognition` keys while
resource mappings retain the full verified frame/path. Original lexical source
IDs and authored locations stay in occurrence provenance; conversations sharing
an environment coalesce without assigning an arbitrary source-thread identity
to the shared resource. Paths preserve Unicode/case and authored symlink aliases;
realpath proves containment and never renames identity. These are installation-
local keys; phase 4 needs a separate portable codec. Phase 2 lookup and future
Brief production must consume the same exported helper and filesystem frame rule.


Conversation target admission also respects the unchanged 256KiB canonical v1
projection payload bound. It selects deterministically by the existing recency/
identity order, measuring canonical source overhead and incremental target bytes.
Targets that cannot fit are omitted before the strict writer; locations and cap
metadata follow the committed subset. `projection-payload-budget` and durable
retention uncertainty disclose the loss. Incomplete scans preserve prior indexed
truth within count/byte bounds; sufficient complete smaller observation or the
owned tombstone clears uncertainty. This avoids a permanent retry of otherwise
valid near-limit URLs without weakening any existing v1 validator or limit.
