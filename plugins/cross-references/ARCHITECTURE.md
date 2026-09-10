# Cross References: vision and architectural constraints

> Status: this document records the long-term model and the constraints that
> shape it. The executable contract for the first exact-reference slice is
> [IMPLEMENTATION.md](./IMPLEMENTATION.md). Public definition helpers,
> containment reads, shared components, and additional providers below are
> vision unless that implementation document explicitly includes them.

## Vision

Cross References should make related work navigable wherever that work lives.
A machine-health page can retain the threads that repaired it. A sticky note
can cite a pull request comment. A thread can reveal everything that points to
it. A repository can roll up references to its pull requests, reviews, issues,
and comments without every producer writing synthetic links to every ancestor.

The leverage comes from one small representation: a resource is an open
provider name plus a multipart string-key map. Exact key maps identify exact
resources. Matching subsets describe containment. Presentation makes the
resource understandable and navigable without participating in identity.

```ts
export interface CrossReferenceResource {
  provider: string;
  keys: Readonly<Record<string, string>>;
  presentation: {
    label: string;
    detail?: string;
    url?: string;
  };
}
```

For example, a GitHub pull request comment may be described as:

```ts
{
  provider: "github",
  keys: {
    owner: "phosphorco",
    repo: "bb",
    pr: "412",
    comment: "2390182",
  },
  presentation: {
    label: "Consider the retry behavior",
    detail: "Comment on phosphorco/bb#412",
    url: "https://github.com/phosphorco/bb/pull/412#issuecomment-2390182",
  },
}
```

That exact key map identifies the comment. The same resource also participates
in lookups for matching subsets:

```text
github { owner }
github { owner, repo }
github { owner, repo, pr }
github { owner, repo, pr, comment }  exact identity
```

A repository lookup can therefore find references to the repository itself and
to resources contained within it. A pull request view can roll up its reviews
and comments. The core performs no GitHub-specific traversal; it only compares
provider names and key/value containment.

## Product value

This representation supports several behaviors from the same stored facts:

- exact deduplication of independently contributed references;
- backlinks from a resource to every context that points at it;
- rollups from a containing resource to referenced descendants;
- grouping several comment or review references beneath one pull request;
- resource breadcrumbs and progressively narrowed pickers;
- paste-to-attach through contributor-defined URL parsing;
- reusable list, dropdown, count, picker, and backlink presentations; and
- new resource domains without a core release or registry approval.

Cross References is not merely a bookmark collection. A bookmark is one view
of outgoing edges. Backlinks, containment queries, related-resource groups,
and future navigation surfaces are other views of the same reference graph.

## Authority-free definitions

No central package owns the meaning of a provider or its keys. Any contributor
may define a provider, key vocabulary, useful constructor names, and URL
patterns. Packages align when they independently emit the same provider name
and key/value map.

The `defineCrossLinks` examples in this section are a future authoring API.
They are not a registry, a prerequisite for persistence, or a first-slice
export. The first slice publishes only the BB conventions needed by its
Machine Monitor/thread integration, and accepts already-materialized resource
objects at its private RPC boundary.

The project may publish common definitions because importing them is a
convenient way for packages to stay aligned, not because those exports confer
authority or reserve a namespace.

```ts
export const githubCrossLinks = defineCrossLinks({
  provider: "github",
  keys: {
    owner: "Repository owner",
    repo: "Repository name",
    pr: "Pull request number",
    issue: "Issue number",
    comment: "Comment made to a pull request or issue",
    review: "Review made to a pull request",
  },
  kinds: {
    PullRequestComment: {
      keys: ["owner", "repo", "pr", "comment"],
      url: "https://github.com/:owner/:repo/pull/:pr#issuecomment-:comment",
    },
  },
});
```

`PullRequestComment` is an authoring convenience, not part of wire identity.
The definition produces a typed constructor whose input contains the declared
keys plus presentation:

```ts
githubCrossLinks.PullRequestComment({
  owner: "phosphorco",
  repo: "bb",
  pr: "412",
  comment: "2390182",
  presentation: {
    label: "Consider the retry behavior",
    detail: "Comment on phosphorco/bb#412",
  },
});
```

The URL template is deliberately bidirectional. It formats keys into a URL and
acts as the parsing instruction for turning a pasted URL back into provider,
kind, and keys. Definitions may expose both construction and parsing without a
second handwritten parser that can drift.

`defineCrossLinks` may enforce only mechanical consistency within the supplied
definition:

- a kind names keys declared by that same definition;
- constructor inputs follow that kind's key list;
- URL placeholders resolve from those keys;
- values are encoded and decoded safely; and
- multiple matching URL templates produce an explicit ambiguous result.

It must not reserve provider names, decide whether a key combination is valid
for the outside system, verify that a resource exists, or require another
package to import a preferred definition.

## Reference model

A cross-reference is a directional edge between two resources. Both endpoints
use the same authority-free representation. A producer replaces the complete
outgoing set it owns for one source resource at a monotonic revision.

```ts
export interface CrossReference {
  source: CrossReferenceResource;
  target: CrossReferenceResource;
}

export interface CrossReferenceProjection {
  producerPluginId: string;
  source: CrossReferenceResource;
  revision: number;
  targets: readonly CrossReferenceResource[];
}
```

Direction preserves context: “Machine Monitor page links to this thread” is a
different claim from “this thread links to Machine Monitor.” Interfaces may
show outgoing links, incoming backlinks, or both.

The source resource is the context shown in a backlink. Examples include a
sticky note, a BB thread message, a plugin page, a GitHub review, or a pull
request comment. Context is therefore not an unstructured label attached to an
otherwise context-free edge; it is the presentation of a first-class source
resource.

## Identity, equality, and containment (vision; exact is v1)

Identity is the exact pair `(provider, keys)`. Presentation, key declaration
descriptions, constructor name, URL template, discovery time, and source plugin
do not participate.

Keys have these wire-level constraints:

- keys and values are non-empty strings within explicit size limits;
- missing keys are omitted rather than serialized as `undefined` or `null`;
- key order is irrelevant;
- canonical serialization sorts keys and encodes them unambiguously; and
- an exact identity includes the complete emitted key set.

The first-slice wire profile makes those constraints executable: provider and
key names are lower-case ASCII matching `^[a-z][a-z0-9._-]{0,63}$`; a resource
has 1–32 keys; values are NFC-normalized, nonblank, free of NUL/control
characters, and at most 512 UTF-8 bytes; and the combined key/value material
is at most 8,192 UTF-8 bytes. Inputs are rejected rather than truncated.
Canonical identity JSON is compact UTF-8 JSON with the fixed object shape
`{"provider":"…","keys":{"…":"…"}}`, sorted key names, and no
presentation. Its maximum encoded size is 16 KiB. No case folding or trimming
changes an accepted value.

Exact matching requires the same provider and exactly the same key/value map;
this is the only public matching operation in the first slice. The contained
matching rule below is retained as a future storage/read-model constraint, not
as a first-slice API or acceptance promise.

Contained matching requires the same provider and every queried key/value pair
to be present on the candidate:

```ts
function contains(query: CrossReferenceResource, candidate: CrossReferenceResource) {
  return query.provider === candidate.provider
    && Object.entries(query.keys).every(
      ([key, value]) => candidate.keys[key] === value,
    );
}
```

Containment is syntactic, not an assertion about the outside world's ontology.
If two contributors use the same provider and keys consistently, their
resources line up. If they choose different or additional identity keys, they
do not. The core must not invent aliases, discard “unimportant” keys, or infer
equivalence beyond exact equality and subset containment.

## Presentation and navigation

Presentation is a bounded snapshot used when the originating integration is
unavailable or expensive to query. It is mutable and never changes resource
identity.

- `label` is the concise primary name.
- `detail` supplies optional context such as repository, thread, or source.
- `url` is optional navigation metadata and may be inferred by a definition.

Known consumers may refresh presentation from their own APIs. The index must
remain usable when they cannot. Renderers validate supported URL schemes and
use BB's semantic navigation components where available.

The first public component layer is future work. Candidate components include
`CrossReferenceList`, `CrossReferenceDropdown`, `CrossReferencePicker`, and
`CrossReferenceCount`; none is a first-slice promise. Components may receive
any definitions their owner wants to recognize; there is no runtime React
registry and no plugin may inject UI into another plugin's tree.

The shared component layer owns bounded search and parsing interactions,
keyboard behavior, focus restoration, accessible naming, empty and degraded
states, and stable rendering. Source adapters own RPC, persistence, optimistic
state, source-specific policy, and placement in their UI.

## Durable ownership and shared indexing

The plugin that owns a source resource remains authoritative for that source's
outgoing references. Sticky Notes owns the references in a note. Machine
Monitor owns the references attached to its page. Their primary operations must
not depend on the Cross References runtime being installed or available.

Each source mutation commits local truth and an idempotent projection command
in the same transaction. A durable outbox calls Cross References through BB's
plugin-to-plugin RPC and retries transient failure with bounded backoff.

The projection operation replaces the complete outgoing set owned by one
producer for one source identity. Projection ownership is
`(producerPluginId, source identity)`; the producer ID scopes replacement
authority but does not become part of resource identity. Revisions are
monotonic within that projection. Equal revision and equal payload is an
idempotent retry; equal revision with different payload is a protocol error; an
older revision cannot overwrite a newer projection. An active empty set means
the source still exists but has no targets; a tombstone means the source was
explicitly deleted. They are distinct durable states.

Cross References owns the shared projection and indexes targets for exact and
contained backlink queries. It does not become source truth and does not reach
into another plugin's private database.

This yields clear failure behavior:

- source UI reflects a successful local mutation immediately;
- backlink projection may be briefly eventually consistent;
- an unavailable index does not break the source feature;
- queued or permanently rejected projection remains diagnosable by the source;
- reloads and ambiguous RPC outcomes retry the same idempotent command; and
- disabling a producer preserves its last projection, presented as potentially
  stale, until an explicit tombstone or administrative cleanup.

## Storage and query constraints

The long-term index needs both exact identity and efficient key containment. A
future-ready schema stores canonical resource JSON once and normalizes its
key/value pairs:

```text
resources
  id, provider, canonical_keys

resource_keys
  provider, resource_id, key, value

source_projections
  id, producer_plugin_id, source_resource_id, revision,
  source_presentation_json, timestamps

references
  projection_id, target_resource_id, target_presentation_json,
  position, timestamps
```

The first exact slice calls the last table `reference_occurrences` and keeps
resources append-only. It enables SQLite foreign keys before migration and
uses explicit uniqueness for exact resources, projection ownership,
projection/target pairs, and projection positions. `resource_keys` may be
maintained as an internal normalized index for a later contained query, but no
contained-match RPC or UI is part of the first slice.

Presentation remains attached to the producer projection or reference
occurrence rather than becoming last-writer-wins global metadata for a deduped
resource. Two contributors can agree on identity while retaining the bounded
labels and navigation snapshots appropriate to their contexts.

The first slice uses the exact identity unique index and target-occurrence
index. A later contained query can use the normalized key table's index
beginning with provider, key, and value to intersect candidate resource IDs for
every requested pair.
The implementation must verify the complete candidate key map after indexed
selection rather than relying on a hash collision boundary.

Queries and UI results are bounded and paginated. Realtime invalidation is
scoped to the affected exact resource identities and useful containment
prefixes; it must not broadcast a global tick through every reference list.
There is no foreground polling.

## Trust, privacy, and lifecycle constraints

- Provider names and key maps are untrusted protocol data with explicit count,
  key-length, value-length, and payload-size limits.
- URL parsing is anchored to the contributed template and never executes code.
- Presentation is escaped as data. URLs are scheme-validated before activation.
- Cross-plugin RPC currently carries producer attribution in a full-trust
  environment; the protocol records and checks claimed producer identity for
  integrity but must not describe that as authenticated authorization.
- Backlink queries must not expand visibility beyond what the current BB
  deployment and contributing integrations allow. A future resource with
  per-principal visibility will require request-bound authorization rather than
  presentation filtering alone.
- A source owner may enqueue an explicit durable tombstone. The first slice
  does not subscribe automatic thread-deleted cleanup: `thread.deleted` is an
  observe-only hint, not a deletion transaction. Removing all attachments is
  an active revisioned empty set.
- Startup reconciliation is bounded and repairs projections missed across a
  crash or reload.
- Retention and administrative cleanup must distinguish a deleted source from
  an unavailable producer.

## First proving spine

The first meaningful vertical slice should stay deliberately narrow:

1. Freeze the bounded canonical resource and projection schemas for BB projects,
   BB threads, and the deployment-local Machine Monitor page. This is a
   convention, not a reserved authority or a `defineCrossLinks` registry.
2. Implement exact identity canonicalization, bounded schemas, and the private
   Cross References projection/read RPCs.
3. Persist Machine Monitor's complete outgoing thread set locally and project
   it with a coalescing durable outbox.
4. Add the bounded BB-thread picker to the Machine Monitor surface.
5. Add a compact Cross References thread-header backlink using the per-thread
   experimental slot and native BB navigation.
6. Demonstrate local-first attachment, reload/retry convergence, scoped
   realtime invalidation plus reconnect refetch, and durable removal.

This spine exercises source ownership, exact indexing, cross-plugin RPC,
backlinks, realtime invalidation, and degraded operation. It deliberately does
not exercise public URL parsing, contained queries, generic components,
federation, or automatic deleted-thread cleanup.

After review, Sticky Notes becomes the second source integration. It validates
compact composition, several independently changing source resources, paste
conversion, and projection updates while preserving its existing note-editing
behavior. GitHub definitions and pull-request/comment rollups follow only after
the BB spine proves the model.

## Proving-spine acceptance criteria

- Two independently created equivalent BB thread resources deduplicate by
  provider and exact keys; a project resource remains a different exact
  resource.
- Presentation-only changes do not create a second resource row.
- Machine Monitor remains usable while Cross References is disabled.
- Local attachment succeeds before projection and exposes actionable degraded
  state if projection cannot complete.
- Reordered, duplicated, delayed, and retried projection commands converge on
  the newest complete source revision.
- Backlinks show the first-class source context and use native BB navigation.
- An active empty projection removes live occurrences after durable delivery;
  a tombstone does the same while retaining deletion state.
- Exact backlink pages are bounded, cursor-stable, and refetched after a
  matching signal or reconnect.
- No provider registry, private DOM integration, global browser event bus, or
  plugin-to-plugin React injection is introduced.

## Deliberately deferred

- GitHub authentication, existence validation, and live metadata refresh;
- `defineCrossLinks`, public URL-template parsing/formatting, and a provider
  definition registry;
- automatic ingestion from the existing Thread Links plugin;
- contained-match RPCs, containment UI, rollups, and graph traversal;
- fuzzy provider aliases or key equivalence;
- cross-BB-instance federation;
- private-resource authorization without request-bound identity;
- a universal resource browser;
- a generic shared component package; and
- automatic cleanup driven only by BB lifecycle events.

The package should grow from demonstrated integrations. Its lasting primitive
is intentionally smaller than any one integration: provider-qualified
multipart keys, presentation snapshots, directional references, and exact
lookup first. Containment remains a later additive read model over the same
canonical identities.
