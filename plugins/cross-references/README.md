# Cross References

Cross References makes the surrounding context of BB work visible and
navigable. While looking at a conversation, page, or resource, a person should
be able to tell whether it is mentioned elsewhere and whether it participates
in something larger than the thing directly in front of them. A directional
reference supplies that useful context at both ends.

It is not a replacement for a URL inspector or a collection of bookmarks.
It is the shared navigation layer built from observed and authored references.

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

### URL observation and cross-reference navigation have different jobs

[Thread Links](https://github.com/phosphorco/bb-plugins/tree/main/plugins/thread-links) remains the specialist
that observes URLs in messages and presents URL-specific information such as
their occurrences. Cross References consumes the relationships those
observations establish and makes them navigable across the application. When
its Forward references view is opened, it also performs the same bounded URL
status scan as Thread Links for current outgoing targets: one
unauthenticated GET per unique destination, up to ten, with manual redirects,
a five-second timeout, body cancellation, and a one-minute in-memory cache.
Status is ephemeral display data, never a graph fact.

That division keeps each surface honest:

- **Thread Links** answers: “Which URLs did this message contain?”
- **Cross References** answers: “What does this context point to, and what
  other contexts point here?” Its Forward references view can also show the
  bounded, current HTTP result for an outgoing URL.

The two products should feel coordinated, not competing. Every eligible
HTTP(S) URL seen in an assistant response creates a forward reference promptly;
a resolved BB-thread target also gains the corresponding backlink. An ordinary
external URL is still a meaningful forward reference even though BB cannot
show a native backlink at its destination.

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
References control. Machine Monitor and Thread Links are source adapters.

Thread Links now projects its automatic assistant-message observations using a
small, explicit URL convention. A generic web target has exact identity
`{ provider: "url", keys: { href } }`, where `href` is the platform-normalized
HTTP(S) URL. Query and fragment remain part of identity because Cross
References does not guess which URL components are semantic. URLs with
authority credentials are sanitized before Thread Links stores them; URLs with
credential-shaped query or fragment parameters, and URLs that exceed the
shared key bound, are not indexed. Cross References independently rejects
noncanonical or unsafe `url/href` targets at its RPC boundary.

For a same-installation URL that has the shape of a BB thread route, Thread
Links verifies the target through BB first. A verified target is represented
by its richer `bb/{project,thread}` identity and gains the native backlink. If
verification fails, its ordinary HTTP(S) URL identity remains the forward
reference instead. This preserves the observed relationship without claiming
that an unverified route is a live BB thread.

Thread Links sweeps existing eligible source threads in bounded, durable
batches after reload and periodically thereafter. The sweep reconciles each
source's complete projection with Cross References, so older observations gain
URL references and a reset Cross References index is repaired without a user
reopening every thread.

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
