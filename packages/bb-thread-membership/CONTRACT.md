# bb-thread-membership contract (package 0.1.0, wire v1)

A **membership source** (first: Topics) answers which threads belong to an
opaque scope it defines, at which revision and with what coverage. A
**consumer** (first: the Inbox) pages that set and decides how to present it.

This package is **not** a store, registry, rule engine, permission system,
presentation or recognizer. It has no React entry. Presentation crosses plugins
only through the `@phosphorco/bb-context-recognition` presentation registry.

## 1. Ownership

| Source owns | Package owns | Consumer owns |
|---|---|---|
| Scope grammar and meaning (for example map, topic, project, descendant policy) | DTOs, codecs, `LIMITS`, method names, version negotiation | Which source and scope to read, and when |
| Exact membership, revision, coverage and reason | `registerThreadMembershipSupplier`, `createThreadMembershipClient` (owner-bound) | Paging schedule, cancellation and generation fences |
| Its own failure semantics (stale scope, not found) | Error classification, page validation, conformance kit | Presentation, intersection with its own rows, honest notices |

## 2. Methods

| Method | Input | Output |
|---|---|---|
| `threadMembershipV1Describe` | `null` | `{protocol:'bb.thread-membership', versions:number[]}` (tolerant) |
| `threadMembershipV1Page` | strict `{scope, cursor, limit (1..200), expectRevision?}` | `ready` page or closed failure |

Ready page: `{state:'ready', revision, members:[{threadId, relation:'direct'|'inherited'}], nextCursor, coverage:{state:'complete'|'partial'|'unknown', excluded?, reason?}}`.
Failure: `{state:'stale-scope'|'not-found'|'unavailable'|'unsupported', reason, message ≤200}`.

Register with `experimental_discoverable: true` as inert metadata. Consumers
never call `experimental_discoverRpc`.

## 3. Source obligations

1. **The revision covers membership.** `revision` MUST change whenever any
   input that can change the scope's member set changes, including:
   - the scope definition (map/topic revision, topic tree, descendant policy);
   - project binding;
   - admitted or removed evidence;
   - match policy or threshold;
   - retention and validity removals.
   A map revision alone, or a maximum admission ordinal alone, is not enough
   when other inputs can change membership. A source that cannot establish
   such a revision answers `coverage.state:'unknown'` for every page.
2. **Pages are consistent within a revision.** For a fixed revision, following
   `nextCursor` from `null` yields each member at most once. A page requested
   with `expectRevision` that no longer matches answers with the **current**
   revision; the consumer then discards earlier pages. It never mixes them.
3. **Coverage is honest.** Use `complete` only when the source can establish
   that every member of the scope at this revision is listed. Evidence that is
   partial, unassessed or not ingressed is `partial` (with `excluded` when it
   is countable) or `unknown`. "No members" with partial coverage is not
   "no threads belong".
4. **Read-only and bounded.** Page reads never write, never start paid work,
   respect `limit` and stay within `LIMITS.responseBytes`.
5. **Identity is attribution.** `experimental_caller` names the calling plugin.
   Do not add caller checks against trusted plugins.

## 4. Consumer obligations

- Build the client with the **source** plugin id; never use slot-scoped hooks.
- Apply membership first: never render a row that is not a member, and never
  fall back to an unfiltered list while loading, failing or stale.
- Fence every page with the generation (source, canonical scope, revision,
  viewer and host revision); abort superseded reads.
- Report truncation, partial or unknown coverage, and members that could not be
  shown (archived, hidden, unreadable).
- **Deadlines are local.** The client settles a call at `describeMs`/`pageMs`
  or on the caller's abort, even if the transport ignores cancellation; a late
  result or rejection is discarded. Aborting asks the host to stop but does not
  prove the source stopped working, so the remote side may still be busy.
  Consumers therefore own call admission: at most one outstanding page per
  view generation (supersede by aborting, never by stacking parallel calls),
  and **no automatic retry** after a timeout. A user action or a new
  generation may start the next call.
- **Deadlines are absolute.** The deadline is fixed when the call starts (monotonic clock) and is checked again after the transport fulfils and after decoding. A transport that blocks synchronously past it is `transient` even if its promise is already resolved. Nothing can preempt a synchronously blocking transport; the check only refuses the late result.
- **Scopes are plain data, sent as validated.** `ScopeSchema` reads only own, enumerable data properties: dense arrays, plain or null-prototype objects, string keys, finite numbers, strings, booleans, null. It never invokes getters, `toJSON`, or other hooks. Sparse arrays, accessors, non-enumerable or symbol keys, and class instances are rejected. The client sends a fresh wire object built from that detached snapshot, so later mutation of the caller's object cannot change what is sent.
- **Responses have no depth policy.** Output is additive: unknown fields are ignored however deeply they nest. The client's only local resource bound on a response is the published byte limit (`describeBytes` / `responseBytes`). It walks at most that many JSON values, iteratively (no recursion), and stops once the canonical UTF-8 size exceeds the limit. The response is already parsed in memory when this runs, so the bound limits the check's work, not the transport's allocation. Each container's own keys are enumerated before they count. A response that is not plain finite JSON (including a cyclic structure; a child shared by two parents is fine), or exceeds the byte limit, is `incompatible` (never `transient`).
- **One raw call per client.** `createThreadMembershipClient` holds one admission
  slot until the underlying SDK promise settles, even after its local deadline
  rejected the caller. Calls made while the slot is held fail immediately as
  `transient` without reaching the transport. Consumers keep one client per
  source for their lifetime (owner-bound, not a global registry); the slot
  bounds only what that client instance started.

## 5. Limits

`scopeBytes 1024`, `scopeDepth 6`, `pageMembers 200`, `revisionChars 128`,
`cursorChars 512`, `messageChars 200`, `describeBytes 8192`,
`responseBytes 65536`, `describeMs 2000`, `pageMs 5000`.

## 6. Error classification (client)

| Native result | Kind |
|---|---|
| 404 `unknown_method` | `absent` |
| 404 with body `{error: "unknown plugin …"}` (current host) or a bare `"unknown plugin …"` body | `vanished` |
| other 404 | `host-incompatible` |
| 503 | `unavailable` |
| 401/403 | `unauthorized` |
| 400 `invalid_input`, 500 `invalid_output`, schema/size/page violation | `incompatible` |
| other 500 | `error` |
| abort | `cancelled` |
| timeout or network | `transient` |

## 7. Proof levels

| Level | Shows | Does not show |
|---|---|---|
| Package tests | Schemas, negotiation, classification, client validation | Any source is correct |
| Supplier conformance (`/testing`) | That source's real handlers page consistently and match supplied witnesses | Live membership or volume |
| Consumer host tests | Paging, fences, filtering, notices with fakes | A real source loaded by BB |
| Live machine proof | The composition on a running BB | Other hosts or data |
