# @phosphorco/bb-thread-membership

Bounded, versioned thread-membership pages between independently installed BB
plugins. A **source** (for example Topics) says which threads belong to a scope
it defines, at which revision and with what coverage. A **consumer** (for
example the Inbox) pages that set and decides how to show it.

Read [CONTRACT.md](CONTRACT.md) first: ownership, method shapes, source and
consumer obligations, limits and error classification.

## Entries

| Entry | Runtime | Contents |
|---|---|---|
| `.` | Zod only | `PROTOCOL`, `WIRE_VERSIONS`, `METHODS`, `LIMITS`, `ScopeSchema`, `PageInputV1Schema` (strict), `PageOutputV1Schema` (tolerant), `DescribeV1Schema`, `negotiateVersion`, `pageViolation`, `plainJsonSnapshot(value, {maxNodes?})`, `canonicalJson`, `canonicalJsonWithin(value, maxBytes)` |
| `./bb` | injected `bb`/`sdk` | `registerThreadMembershipSupplier`, `createThreadMembershipClient`, `classifyMembershipError`, `MembershipCallError` |
| `./testing` | SDK fake host | `runThreadMembershipSupplierConformance` |

## Bounds (`LIMITS`)

| Name | Value | Applies to |
|---|---|---|
| `scopeBytes` / `scopeDepth` | 1024 / 6 | Canonical scope JSON |
| `pageMembers` | 200 | `limit` and members per page |
| `revisionChars` / `cursorChars` / `messageChars` | 128 / 512 / 200 | Output strings |
| `describeBytes` / `responseBytes` | 8192 / 65536 | Checked by the client before decoding |
| `describeMs` / `pageMs` | 2000 / 5000 | Local deadline per client call |

## Source

```ts
import { registerThreadMembershipSupplier } from '@phosphorco/bb-thread-membership/bb';

registerThreadMembershipSupplier(bb, {
  page: ({ scope, cursor, limit, expectRevision }, { caller }) => myStore.membershipPage(scope, cursor, limit),
});
```

- The revision must change on every change that can affect membership (CONTRACT §3.1).
- Pages are read-only, at most `limit` members, unique, and the cursor advances.
- The registration validates output and its byte bound before returning it.

## Consumer

```ts
import { createThreadMembershipClient } from '@phosphorco/bb-thread-membership/bb';

// One client per source plugin, kept for the consumer's lifetime.
const source = createThreadMembershipClient(bb.sdk, sourcePluginId);
const page = await source.page({ scope, cursor: null, limit: 20, expectRevision: null }, signal);
```

- **Local deadline.** The deadline is absolute (monotonic), measured from the start of the call. A call rejects when it passes, or on abort, even if the transport ignores cancellation or blocks synchronously. The deadline is checked again after fulfilment and after decoding. A late result or rejection is discarded.
- **Response checks.** Responses have no depth limit, and unknown fields are ignored. The only local bound is the published byte limit, checked by an iterative walk over at most that many values. The walk runs after the response is parsed, so it bounds the check, not allocation. Non-JSON (including cyclic) or over-size responses are `incompatible`. A child shared by two parents is serialized twice.
- **Plain-data scope.** The scope is validated as a detached plain-JSON snapshot, and that snapshot is what gets sent. Getters and `toJSON` are never invoked. Sparse arrays, accessors, hidden or symbol keys, and class instances are rejected.
- **One raw call per client.** The client keeps that call's slot until the SDK promise itself settles. Calls made meanwhile fail at once as `transient` and never reach the transport. There is no automatic retry. The slot only bounds calls made through that client instance; the package has no global registry.
- Apply membership before anything else. Never fall back to an unfiltered list. Fence pages by revision; a changed revision means discard earlier pages. Show truncation and partial or unknown coverage.

## Proof and limits

```sh
bun test ./test        # package tests (source)
```

- Package tests prove schemas, negotiation, classification, client deadline and admission behavior, and the conformance kit on reference suppliers.
- Supplier conformance proves one source's real handlers. It does not prove host discovery, loading or live membership.
- Aborting asks the host to stop. It does not prove the source stopped working.
- SDK peer `^0.6.31` (optional). The floor is backed by registry `@get-bb/plugin-sdk@0.6.31`: the emitted declarations compile strictly, and the `/testing` kit runs real registered handlers on its own `createFakePluginHost`. The installed fork artifact `0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820` was checked separately. Intervening and future 0.6.x releases are not individually exercised.
