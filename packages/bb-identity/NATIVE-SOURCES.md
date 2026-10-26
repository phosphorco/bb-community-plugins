# Native source evidence — 0.4.0 candidate

`@phosphorco/bb-identity/native` normalizes bounded, retained public SDK
snapshots into `NativeSourceEvidence`. It preserves native source facts without
manufacturing a Contribution, successful history lookup, attempt, person, or
agent identity. Existing Contribution/ExecutionProvenance APIs are unchanged.

| Caller owns | Package owns | Host/public SDK owns |
| --- | --- | --- |
| Reading and freezing snapshots; retention/rewrite fences | Bounds and validation | Retained events and visible timeline projection |
| Cursors, discovery, budgets, persistence and wake/recovery | Exact request/turn and projection/item joins | Native attribution fields when recorded |
| Product text selection and semantic support | Independent evidence coverage | Genuine Contribution/ExecutionProvenance history |
| Rendering and product acceptance | Optional bounded history read composition | Native producer semantics |

No registry, RPC, timers, scanner, subscription, storage, or background owner is
introduced. This is request-scoped normalization; the caller owns any durable
work resumed after restart. A wake is never source evidence.

## Public API

```ts
import { createNativeSourceAdapter } from '@phosphorco/bb-identity/native';

const adapter = createNativeSourceAdapter({ history: binding.server.history });
// These are actual public SDK return values captured by the caller's history reader.
const events = await bb.sdk.threads.events.list({ threadId, order: 'asc', limit: '200' });
const timeline = await bb.sdk.threads.timeline({
  threadId, includeNestedRows: 'true', deferContent: 'false',
  summaryOnly: 'false', segmentLimit: '200',
});
// The caller must freeze/fence matching retained snapshots before admission.
const result = adapter.resolve({
  source: {
    kind: 'assistant-terminal', threadId, terminalEventId,
    scope: { turnId },
  },
  events, timeline,
});
if (result.ok) {
  const nativeEvidence = result.value;
  // Optional: actual existing history reads, retaining their exact outcomes.
  const enriched = await adapter.enrich(nativeEvidence, { signal });
}
```

The example targets the inspected fork SDK
`0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820`. Timeline flags such as
`deferContent` are host-specific; the public registry SDK 0.6.31 does not
declare that flag. Its baseline witness calls `threads.timeline({threadId})`
using its own public contract. Do not add undeclared flags to a consumer.
The example illustrates public calls, not an atomic snapshot transaction.
Concurrent rewrites, history pagination, and changed projection snapshots need a
caller-owned fence. The adapter cannot authenticate the origin or revision of
injected snapshots. Do not combine an old event page and a new timeline page and
claim they describe one frozen retained history.

References are opaque native IDs:

- `request-group`: threadId, eventId, requestId, groupIndex (zero based).
- `event`: threadId, eventId; currently normalizes `client/turn/requested`.
  Multiple groups require an explicit `request-group`; other event types yield
  unsupported source coverage.
- `assistant-item`: threadId, itemId, terminalEventId, scope.turnId.
- `assistant-terminal`: threadId, terminalEventId, scope.turnId.

Terminal references contain no attemptId. A terminal event must be
`turn/completed` with the exact scope.turnId. Its status remains completed,
failed, or interrupted. Two terminals in one turn remain distinct sources.
An attempt ID appears only inside an actual optional history response.

## Source and identity semantics

A request group uses its exact `inputGroups[groupIndex]`, falling back to the
single native input only when groups were not recorded. Authors and editors
are accepted only from group-aligned native arrays. Missing/misaligned arrays
are explicit unknown coverage; the adapter never borrows another group's author.
Text includes visible text parts in order, separated by newlines. Non-text
attachments are not expanded, and agent-only text is excluded with an explicit
coverage reason. Request-wide native mentioned targets retain their structured
provider source and are never converted to per-group authorship.

`origin` preserves native dispatch initiator user/agent/system. `user` means the
native initiator value; it does not assert a person. Native structured author,
latest editor, mentions, and dispatch senderThreadId are independent. A machine
author can accompany a user initiator. No text envelope, participant roster,
first/latest author, display name, or parent thread supplies missing identity.

Assistant output has origin assistant, author/editor null, and no inherited
mentions. Its accepted inputs identify execution causes, never output authors.
`turn/input/accepted.data.clientRequestId` must join exactly one preceding
request event to the accepted event's scope.turnId. For a selected request
source, that exact event must be the unique preceding candidate; a later event
reusing its request ID cannot inherit an earlier event's acceptance. Many requests and groups
can share a turn. Supplied windows cannot prove all input causes were retained,
so execution coverage remains partial even when every included join succeeds.

The native source contract does not establish initiating person, carried person,
agentId, or personal delegation. Those fields remain explicitly unknown/null.
Optional genuine history may contain an integration assertion or execution
correlation; that assertion retains its original basis and does not silently
populate stronger native lineage fields.

## Retained terminal output join

The adapter uses the supported public `threads.timeline` projection. It does
not reconstruct visible text by concatenating transient deltas, nor select only
completed items. It accepts assistant conversation rows with the exact native
thread and turn and a source range wholly through the selected terminal.
Both range endpoints must join supplied text-bearing agentMessage delta or
completed agentMessage events with the same native item ID, recorded parentToolCallId,
and turn. IDs, nonempty endpoint text and optional commentary/final_answer phase
are validated before use. Omitted/nonstring request text and invalid visibility
are rejected rather than coerced. Missing/invalid row IDs withhold those rows.
Every returned text row preserves its recorded parentToolCallId; null means the
public field was absent, not recovered root delegation. An assistant-item selector
matching several recorded parent instances is ambiguous and supplies no text. The
projection's row ID is retained, never parsed for hidden identity. Per-text
source IDs, sequence range, item ID, and available completed-item phase survive.
Deltas without recorded phase keep phase null.

This permits retained visible commentary and final output, including text flushed
at failed/interrupted terminals without item/completed. Public timeline text is
the authority; the adapter does not invent projection behavior. Empty text and
non-assistant/tool rows contribute no text. Cross-terminal ranges, missing
endpoints, or different item IDs cannot supply text. Plan/reasoning rows are not
accepted as agentMessage output. Missing/deferred nested rows and incomplete
pages disclose coverage gaps. A bounded empty page never proves a turn had no
retained assistant text. The caller decides whether retained text is substantive.

Sequence endpoints prove the structural join within supplied matching snapshots.
They do not prove producer stability, identical revisions across independent
reads, or that this package observed a real interrupted producer.

## Independent coverage and optional history

`coverage.source` describes admitted text and the selected source within the
snapshot. It is separate from attribution, execution and personalLineage.
`known` source coverage does not imply complete thread traversal or identity.
Native facts do not change `binding.server.history` outcomes.

`enrich` optionally calls the existing history reader using native-event queries
for request sources or assistant input requests. It retains each exact Result,
including pending, unavailable, errors, partial pages and continuation cursors.
Attempts are queried only via genuinely returned same-thread Contribution refs.
Responses stay under `history` with their query basis; they are not relabeled as
source authors or resolved assistant executions. In particular, a returned
attempt with a different correlation turn is not an execution of this assistant
source. Consumers must match genuine correlation.threadId/turnId and contribution
causes before using optional attempts. No pages are silently followed, unknown
results retried, or history coverage upgraded. Existing readers may throw
programmer errors according to the existing Result contract.

`NATIVE_SOURCE_LIMITS` publishes 2000 events, 2000 nested projection rows, 2 MiB
UTF-8 serialized input, 8 nested levels, 16 total enrichment calls and 256-character
native identifiers, plus 64 levels for the complete plain-data representation.
A bounded stable copy reads own data descriptors, including non-enumerable data,
and rejects accessors, callable serialization hooks, cycles and exotic prototypes.
It bounds consumed UTF-8 data with structural overhead, then the UTF-8 JSON
serialization of that same copied representation (including escape expansion).
Normalization consumes only the checked copy; no original getters/toJSON run.
Oversized/malformed input returns invalid-input. Reads are
cancellable between operations and use the reader's supplied cancellation
semantics. No feature work is launched after return.

## Compatibility and proof

The new entry imports SDK types only; its emitted runtime imports no SDK or
React. Existing root, model, client, server and other exports/peer ranges retain
their previous contract. The current declaration witness uses installed SDK
`0.6.52+phosphor.975e38f02f1a.sdk.12eb78c20820`, including optional native
p6rAuthors/p6rEditors/p6rMentionedTargets. NativeActor and NativeMention derive
conditionally from the SDK's public optional properties; when absent (as in public
SDK 0.6.31), their member types are never and source attribution remains null/empty.
No fork property or protocol is copied to emulate a missing capability. Public
0.6.31 all-entry declarations and its minimal native calls are a separate actual-peer
conformance job, without skipLibCheck; missing upstream declaration dependencies
are resolved by that fixture separately. Existing peers and default exports
remain unchanged. Older hosts can keep existing entries;
using `/native` requires the public snapshot types/capabilities exercised by the
adopter. Missing optional attribution on a host stays unknown.

`@phosphorco/bb-identity/native/testing` exports
`defineNativeSourceConformance({test, resolve, cases})`. Pass the adopter's actual
source path and independently authored semantic oracles. The kit refuses empty
case lists; it does not substitute a fake adapter or assert live coverage.

Package source fixtures cover human/machine/agent dispatch, author/editor/mention
separation, multiple requests/groups sharing a turn, commentary/final and
failed/interrupted delta projections, exact joins and refusals, missing lineage,
bounds, and actual optional reader outcomes. These are synthetic SDK snapshots.
Public declarations, emitted entries and a scratch packed consumer are separate
package proofs. Registry publication, exact-version consumer adoption,
producer/live fixtures, rewrite/outage/restart and host acceptance remain
separate gates. Source version 0.4.0 is a candidate; installed org consumers on
0.3.1 do not gain this API until a separately authorized registry release and
exact-version adoption.
