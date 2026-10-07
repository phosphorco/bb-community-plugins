# Cross References

Cross References makes the surrounding context of BB work visible and
navigable. While looking at a conversation, page, or resource, a person should
be able to tell whether it is mentioned elsewhere and whether it participates
in something larger than the thing directly in front of them. A directional
reference supplies that useful context at both ends.

It is not a replacement for a URL inspector or a collection of bookmarks.
It is the shared navigation layer built from observed and authored references.

## Shared package

`@phosphorco/bb-cross-references@0.1.0` provides the canonical resource/projection
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

### Assistant links and recency

Cross References collects HTTP(S) links directly from assistant messages using
BB's public thread timeline API. A local thread route is verified before it
becomes a native thread reference; other web links remain exact URL resources.
Forward references and backlinks show the latest source-message time as a
muted relative timestamp, with the full date on hover. Unknown times are omitted.
Repeated links count once; their latest occurrence supplies recency.

Opening Forward references performs a bounded URL status scan: one
unauthenticated GET per unique destination, up to ten, with manual redirects,
a five-second timeout, body cancellation, and a one-minute in-memory cache.
Status is ephemeral display data, never a graph fact.

Thread Links is retired on bb-machine. Its installed registration and private
data remain retained while Cross References owns new assistant-link collection.

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
