# Thread Attachments: wire v1

Package `@phosphorco/bb-thread-attachments` 0.1.0 is an independent, data-first
contract for shared attachment facts and family operations. Package version and
wire version are separate. Publication, registry availability, adoption and
live behavior each require separate evidence.

| Authority owns | Contract owns | Presentation owns |
| --- | --- | --- |
| Shared storage, revisions, immutable operation receipts, native top-level eligibility, source access, automatic recognition, manual precedence, cycle prevention and actor binding | DTOs, codecs, bounded validation, fixed RPC names, negotiation, injected adapters/client, source conformance | Listed discovery triggers, explicit authority selection, keyed bounded reads, caching, rendering, filter/order/drag and personal state |

No recognition, history I/O, storage, identity policy, React, SDK runtime,
presentation registry or lifecycle mutation lives in the root. Relationship
facts are shared rather than personal/view-as data. The authority must expose
only facts safe to return under its source access rules; a request supplies no
actor or write destination. Identity attribution alone does not authorize a
write. Only actual server-bound actor identity may authorize mutations.

## Entries and adapters

- Root: Zod schemas, DTO types, `METHODS`, `PROTOCOL`, `WIRE_VERSIONS`, `LIMITS`,
  `CHANGED_CHANNEL`, JSON helpers, negotiation, relational checks and reconciliation.
  Runtime dependency: Zod only.
- `/bb`: injected `createThreadAttachmentsClient`,
  `createThreadAttachmentsSupplierHandlers`, `threadAttachmentsRpcContract`,
  `registerThreadAttachmentsSupplier`, discovery and error handling. SDK imports
  are types only. No global instances or idle activity.
- `/testing`: `runThreadAttachmentsSupplierConformance` uses the optional SDK
  peer's fake host and the public `/bb` client. This entry requires the SDK
  installed; root and `/bb` do not require it at runtime.

All operational input schemas are strict. Every evolving output object,
including each record, is passthrough/additive. Added enum meanings require a
new protocol version; an unknown state is incompatible rather than `none`.

## Discovery and negotiation

The fixed describe method is `threadAttachmentsV1Describe`. Clients send `null`;
the supplier deliberately accepts and ignores any input. The tolerant envelope
is `{protocol:'phosphor.bb-thread-attachments',versions:number[]}`. `[1]` and
`[1,2]` negotiate v1; `[2]`, `[]`, another protocol or malformed envelopes do not.
Only after negotiation may the consumer use the v1 methods. Describe has no
version-specific details to decode.

Use `sdk.plugins.list()` once per discovery pass and probe running/degraded
listed IDs with at most four concurrent calls. Responses are keyed by target
plugin ID; no advertised owner can redirect a call. A failing supplier cannot
discard healthy results. Zero suppliers is an unavailable feature; multiple
ready authorities require explicit consumer selection, never list-order choice.
Mount, explicit refresh, plugin lifecycle and reconnect are caller-owned
triggers; do not poll. Retain one client per selected authority for the entire
consumer lifetime. For refresh/reconnect retain `createThreadAttachmentsDiscovery`:
it retains per-target clients, admits one raw list call and at most four raw
probes until transport settlement, including across timed-out passes. Exhausted
probe admission reports that target unavailable; refresh is explicit. Its
client-handle cache lives only with that consumer. The one-shot
`discoverThreadAttachmentsSuppliers` helper is for a single discovery pass.

## Wire

Stable thread IDs match exactly `thr_[23456789abcdefghijkmnpqrstuvwxyz]{10}`,
including prefix, case, alphabet and length. This is the native generated-ID
grammar, not a legacy arbitrary-string compatibility surface. Revision and
operation IDs are opaque 1..128 ASCII characters: initial alphanumeric, then
alphanumeric, underscore, period, colon or hyphen. Operation IDs are immutable,
consumer-generated attempt IDs; they cannot be reused for a different request.

All operation inputs include `version:1`.

| Method | Input beyond version | Output beyond version |
| --- | --- | --- |
| `threadAttachmentsV1Assess` | `threadIds:string[1..4]`, unique | `state:'queued',threadIds` (exact request order) |
| `threadAttachmentsV1Observe` | `threadId` | Read output with exactly that one requested ID |
| `threadAttachmentsV1Read` | `threadIds:string[1..200]`, unique | `revision,records` |
| `threadAttachmentsV1Family` | `threadId` | `revision,leadId,threadIds:string[0..500],coverage` |
| `threadAttachmentsV1Attach` | `operationId,threadId,leadId,expectedRevision` | `state,revision,operationId` |
| `threadAttachmentsV1Detach` | `operationId,threadId,expectedRevision` | `state,revision,operationId` |

Each read record is
`{threadId,state,leadId,sourceId,provenance,operationId}`. Every requested ID must
appear exactly once, with no unrequested IDs. Order is supplier-defined.

- `attached`: non-null lead, immediate source and `manual|automatic` provenance;
  neither lead nor source equals this thread. The lead is the original family
  anchor. Immediate source preserves provenance through flattened chains.
- `detached`: manual suppression, null lead/source. This is a durable decision.
- `none`: assessed no match, null lead/source/provenance/operation.
- `unassessed|unavailable`: no reliable assessment, null decision fields. Failed
  or unavailable evidence must never be downgraded to `none`.

Read performs no history I/O, recognition or assessment enqueue. Family is also strictly read-only. Empty facts are not evidence of
unattachment when the source failed.

Family coverage is `complete|partial|unavailable`. Complete includes both the
lead and requested member with unique IDs; incomplete outputs may omit unknown
members and must never claim completeness. Completeness concerns durable
attachment facts, not globally unassessed recognition candidates. A family
includes durable members excluded by presentation filters. At 500 members the
authority must reject growth or report incomplete coverage, never silently
truncate. Consumers disable family mutation/drag for partial/unavailable data.

Relationship writes (attach/detach) return `applied|conflict|unavailable` and
echo the exact operation ID. CAS compares `expectedRevision` against authority
state. Attach moves the whole source family atomically to the original target
lead; it preserves immediate-source provenance and manual precedence. Creating
attachments requires eligible native top-level threads; self-attachment and
cycles are invalid.

Detach stores individual manual suppression, including when no prior attachment
exists. New suppression without an existing attached edge still requires native
eligibility. Explicit removal of an existing attached edge can repair it even
when the member is now a native agent/owned thread, archived, deleted or
unavailable. The authority validates the actual actor and expected revision,
rechecks that attached edge inside the transaction, records the complete prior
fact and saved native status in an immutable operation-keyed audit, and replaces
only that edge with manual suppression. This repair performs no native I/O and
never manufactures native eligibility. It permits neither new attachment nor
whole-family movement from incomplete coverage. Detaching the original lead
does not dissolve its children. These policies, audits and immutable receipt
enforcement remain authority-owned; the contract's shape validation cannot
establish them.

No operation reparents native threads or changes permissions, pin flags,
ownership, assignment, unread, agent hierarchy or lifecycle. The authority
publishes `attachments-changed` with its new revision after confirmed mutation;
the package creates no subscriptions or timers at idle.

## Priority assessment scheduling

`threadAttachmentsV1Assess` is an explicit scheduling action, separate from the
strictly read-only `read` and `family` methods. It accepts at most four unique
native thread IDs and returns an additive `{version:1,state:'queued',threadIds}`
acknowledgement echoing the exact IDs in request order. It durably prioritizes
eligible unknown candidates so newly created or actively viewed work does not
wait behind historical backlog. The authority owns eligibility, pending-work
deduplication and bounded priority servicing; this action must never overwrite
attachment facts or perform history reads/expensive assessment on the RPC path.
Queued acknowledges the bounded request, including already-decided or ineligible
IDs that need no new pending work. It does not mean assessment completed or that
every ID was newly queued.

A consumer calls `client.assess(input,signal?)` once per explicit active-thread
or visibility change outside rendering, never per row or through polling. It
uses the same write admission and deadline as other mutations. A dispatched
failure has unknown outcome and is never automatically replayed. There is no
operation ID: scheduling is idempotent and repeating a subsequent explicit view
wake deduplicates pending work. Such a new wake is distinct from retrying a lost
response. `reconcileUnknownWrite` is for attach/detach operation receipts only;
a fact read cannot prove whether assessment queue intent was accepted. Read and
family calls must not implicitly queue assessment.

## Bounded event-backed observation

`threadAttachmentsV1Observe` accepts strict `{version:1,threadId}` and returns
`ReadOutputV1` with exactly the requested ID once. Its additive output follows
the existing read schemas and validation. `client.observe(input,signal?)` is a
read, so cancellation/response failure never carries unknown-write semantics.
It shares that client's existing one raw outstanding slot. Consumers needing
independent hydration, scheduling and observation retain separate bounded
clients; the package creates none automatically.

The authority waits on its own relevant completion/change events, without
history/source I/O, writes, assessment enqueue, retry or polling from observe.
It returns a current snapshot at event completion or by the observation wait
deadline. `unassessed` or `unavailable` at expiry remains honest unknown state;
queued assessment acknowledgement is not assessment completion. Observe must
not infer `none` merely because its wait elapsed. Caller lifetimes and actual
authority cleanup must dispose subscriptions/waiters.

Two raw supplier observation slots are separate from the two ordinary read
slots and the single write slot; no queue. The callback receives
`context.deadlineAt` at most **2500ms** after admission for its observation wait.
The existing **3500ms** supplier transport/validation guard remains outside it,
so returning a current snapshot at normal wait expiry does not race the same
hard timeout timer. Authorities must end the wait by the 2500ms deadline; the
outer guard protects callers against misbehaving callbacks and late validation.
Raw slots stay held until callbacks actually settle even after a hard timeout.
A consumer triggers a bounded observation for explicit active/visible intent,
never automatically chains expired observations or polls. Any event/reconnect
re-observation policy belongs to the consumer's explicit lifecycle.

## Bounds and cancellation

Per call: read IDs 200, assessment IDs 4, family IDs 500, input canonical JSON 32 KiB, response
256 KiB, describe 8 KiB, client 4.5 seconds, supplier 3.5 seconds; observation wait 2.5 seconds within that supplier guard. These are
published protocol budgets, not whole-discovery or whole-gesture deadlines.
Canonical JSON is sorted-key UTF-8. Unknown output fields count toward the byte
limit **before** DTO decoding, using a non-stripping unknown transport schema.
Transport JSON is already parsed: this bounds validation work and canonical
payload size, not raw transport bytes or prior allocation. JSON helpers reject
getters, cycles, nonfinite numbers and non-JSON values without executing hooks.

One raw call per client; supplier allows two raw read/family calls, two separate raw
observations and one raw write. There is no queue. Exhaustion fails immediately as `busy`. Slots remain
occupied until raw work settles, even if local deadlines expired. The limits
apply per retained client and per handler-factory instance; use one factory per
authority. Per-call timeouts bound asynchronous waiting and fence late replies;
JavaScript cannot preempt synchronous work. Authorities must bound their own
work and check the supplied signal/deadline before committing.

Caller abort fences local results and requests transport cancellation. It never
proves remote work stopped. Supplier handlers receive their own deadline/signal
and the exact original request context as `rpcContext`. Identity adopters must
register `threadAttachmentsRpcContract` and the factory handlers through their
identity server with the real invocation; never reconstruct actor identity from
raw SDK caller hints.

`client.whenIdle(signal?)` is a local transport lifecycle helper. It resolves
immediately when no raw call is outstanding, otherwise after the raw transport
settles and releases its admission slot. It rejects with a cancelled
`AttachmentCallError` on caller abort and removes that waiter and listener.
Successful waiters/listeners are cleared atomically with admission release.
There is no RPC, timer, retry, new wire method, or reservation of the next slot.
A permanently unsettled transport leaves the wait pending until caller abort;
consumers should pass their lifetime cancellation signal.

Consumers can retain the latest explicit intent whose call was rejected as
`busy` with `outcome:'not-dispatched'`, wait for local idle, then submit that
intent once. This never replays a previously dispatched assessment with unknown
outcome. Another caller may take the released slot first; `whenIdle` observes
transport settlement rather than guaranteeing future admission. It does not
confirm any write outcome or completed recognition.

## Errors and unknown writes

`AttachmentCallError.kind` classifies `absent`, `vanished`, `host-incompatible`,
`unavailable`, `incompatible`, `error`, `unauthorized`, `cancelled`, `transient`,
`busy` and `invalid-input`. Native status plus `body.error` string/structured code,
and supported legacy whole-body strings, distinguish missing method (404),
unknown plugin (404), disabled/not-running (503), invalid input/output (400/500),
unauthorized (401/403), owner failure (500) and transport failures. Local schema
failures are incompatible; local caller-input failures are invalid-input.

Before dispatch, a write failure has `outcome:'not-dispatched'`. Any failure
after transport dispatch is conservatively `outcome:'unknown'`, including lost,
late or malformed replies. Neither abort nor unchanged data proves failure to
commit. The package never retries writes. `reconcileUnknownWrite` makes one
fresh read and returns `observed` only for matching immutable operation ID,
manual provenance and matching decision kind. It otherwise returns `unknown`,
including when the raw transport still holds admission. An operation later
superseded may remain unknown. Authority receipts must be unique and immutable;
revision movement alone never confirms success. Reconciliation cannot overwrite
a newer decision or authorize an implicit replay.

## Proof and release

Package tests run emitted entries. The testing kit drives actual registered
handlers through a separate owner-bound consumer, checks strict inputs and
bounds, then runs ordered adopter-owned `cases:[{name,run(client)}]`. Cases must
assert real authority policy: durability/reload, manual suppression, late
recognition fencing, CAS, cycle rejection, complete families and family-wide
attach; priority assessment must be deduplicated and preserve existing decisions. No cases is skipped/nonpassing. Kit callbacks can still omit policy
witnesses: report exactly what each adopter tested. Source conformance is not
host discovery, network, running composition, performance or UI proof.

Release/validation workflows include dispatch choice, tag
`bb-thread-attachments/v0.1.0`, workspace/path mapping, dependency build and
pack inspection. The ordinary public/provenance release route applies. npm
trusted publishing or the existing first-release credential must be configured
separately. Publication requires a reviewed source revision and its matching
release tag. Verify registry version, artifact integrity and provenance
separately from source checks. Consumers pin exact registry `0.1.0` only after
release verification. Temporary local source links prove source compatibility
only and must never become manifest specifiers.
