# Opt-in shared work-product editing

`@phosphorco/bb-identity/editing` uses the production state controller and binding
lifetime with an explicit `bb-identity.editing/v1` protocol. Legacy `/state`
consumers retain their existing outcomes, codecs, auto-dispatch and blocked edit
behavior. This entry adds no mandatory SDK or React runtime dependency.

| Feature owns | Package owns | UI owns |
| --- | --- | --- |
| Shared storage, document targets and schema | Session and controller lifetime fences | Text controls and conflict choices |
| Atomic admission, immutable request receipts and retention | Desired generation, exact flight, acknowledged base | Explicit publication and checkpoint/export actions |
| Protocol advertisement and selected v1 transport | Versioned codecs and receipt/request validation | Separate publication and backup presentation |
| Real map epoch, monotone admission ordinal, opaque revision | Bounded reconnect and recovery | Feature diagnostics and labels |
| Draft adapter and conditional checkpoint revisions | Shared Provider retirement coordination | Explicit recovery candidate selection |

A shared map has no personal owner. `draftAddress.owner` is the actual actor
whose editing work is retained. `target` selects the shared feature document.
Do not send this editing scope to legacy personal-state server routes or
register a fake personal state owner for the shared document. The feature
adapter loads shared content into an actor's editing scope and supplies real
version metadata. Epoch changes on reset/recreation; sequence increases inside
the admission transaction. Keep opaque revision identity in the feature value
when the feature command needs it. Do not derive sequence from time, UUID or hash.

## Controller and binding

Construct `createIdentityEditingState({draftAddress,target,targetCodec,expected,
ownerSession,definition,transport,drafts?,scheduler?,onConflict,initializeEmpty,
currentSession})`. `currentSession` observes the live client, never a captured
initial session. The transport must be explicitly negotiated with the feature's
v1 endpoint before construction; the protocol literal and a successful local
codec do not prove remote capability or durable storage.

Prefer `useIdentityEditingBinding({resourceKey,target,targetCodec,create,
onUnpersistedDraft?})` and `useIdentityEditingSnapshot(binding)` from `/react`
under the continuously mounted `BbIdentity.Provider` and `BbIdentity.Context`.
`create({session,subject,ownerSession})` returns the controller; `subject` is the
actual actor. The hook acquires resources only after commit. Use a stable
`resourceKey` describing the feature/schema/draft record. Semantic encoded
Target changes replace the owner; object and callback recreation alone do not.
Callback changes are visible only after commit. A manually owned resource may
use `bindIdentityEditingState({...options,client,view})` from `/editing`.

The shared binding fences delayed recovery/conflict/checkpoint commands with
`currentOwnerSession()` before and after awaits. A1 → B2 → A3 creates distinct
controller incarnations even when actor A returns. A detached controller cannot
be revived; new work requires a new controller and explicit recovery. The
controller's borrowed `draftStorage` identity lets the Provider wait for an old
write before enumerating replacement recovery candidates. The Provider never
owns or disposes feature storage.

## Publication and backup are separate

`edit(B)` changes desired value and generation. Loaded active same-owner drafts
remain editable through conflict, unknown save, definitive rejection and failed
checkpoint. Session/owner change, detach/dispose, migration and load failure
fence editing. An authoritative successful reload can resolve a load failure;
returning to an old identity cannot revive a retired controller.

Edits never publish automatically. `flush()` captures an immutable request
before the first checkpoint or transport await. With pending A, one explicit
flush reconciles A only. It never follows reconciliation by sending newer B.
A successful `Result<void>` can mean A was acknowledged while B remains dirty;
always render the snapshot's desired/acknowledged/publication/backup facets.
A rejected receipt returns a failed Result, retires A without changing base,
and retains B plus structured diagnostics. After correction, a later explicit
flush submits a new operation. Retrying a checkpoint or reading unchanged data
cannot resolve rejection or an unknown save. Conflict is also a failed explicit
publication; decisions capture a token that changes immediately when typing B.

`checkpoint()` serializes desired B, acknowledged base, exact pending A and
last definitive rejection. `snapshot.draft` remains exportable when it fails.
`checkpoint.status` is disabled, local-only, writing, backed-up or failed;
`generation` and `revision` identify the last committed checkpoint. A generation
alone cannot prove backup: receipt/pending/base/rejection metadata must also
match. Without DraftStorage there is no browser-death recovery guarantee.

On retirement failure, `useIdentityEditingPreservationFailures()` retains the
full EditingDraft, including Target, without a fresh identity RPC. Its bounded
Provider presentation records have exact generation tokens.
`useAcknowledgeIdentityEditingPreservationFailure()(generation)` only dismisses
that record; it neither retries storage nor proves backup or publication.

## Exact request finality and recovery

An `EditingRequest` binds protocol, Target and the full immutable StateMutation,
including actual actor/session, ownerSession, expected version, local generation,
schema, operation ID and submitted value. Every final receipt echoes this exact
request. The feature must reserve/check its canonical request fingerprint before
CAS and atomically retain the original outcome, including rejected diagnostics.
Changed payload with the same ID is invalid-operation. The package validates the
full echoed request; matching operation ID alone cannot authorize retirement.
Bounds are exported as `EDITING_LIMITS`; codecs reject malformed versions,
diagnostics, recovery data and mismatched resource metadata.

`reconcile(originalRequest)` uses the current authenticated invocation to inspect
the original request, even when its actor's server session has since changed.
Never rewrite the original request's expected session or ownerSession. A final
saved outcome contains the admitted A snapshot, even if remote current is C.
Load C afterwards and review divergence against A's acknowledged base. A final
conflict likewise carries the original captured remote snapshot. Pending,
unknown, expired and ordinary transport errors retain A. Even absent-final does
not cause automatic or implicit replay in this manual v1 controller. No new
operation is created while A is unresolved.

Draft discovery is bounded to 20 candidates by full actor/draft address/Target.
Selection is explicit; codecs preserve B and A independently across controller
sessions. `remove({target,draftKey},revision)` must conditionally delete only that
exact checkpoint. A newer checkpoint cannot be erased by stale recovery UI.

Source/controller/binding tests and local packed-consumer tests establish only
the exercised source/artifact contracts. Actual feature negotiation, durable
atomic receipt storage, registry adoption and live runtime coverage require
separate evidence.

Protocol metadata is validated through typed normalization too: encoders retain
supplied protocol fields so an unsupported outer or nested version cannot be
rewritten into v1. Recovered rejection evidence must match the draft's schema
and cannot come from a future local generation or the same still-pending
operation. Historical actor session and ownerSession remain unchanged; a new
active session may recover and reconcile that exact historical request.

Use `editingCodecs(valueCodec,targetCodec).scope` at the feature's v1 load and
subscription wire boundary. It encodes/decodes the actual `EditingScope`:
`{draftAddress,schemaVersion,target,expected}`. Public ID and identity codecs
validate the draft owner and exact opaque session; draft owner must equal the
expected actual actor, while Target remains feature data. The codec rejects
unknown input keys and unsafe schema integers, preserves typed Target wire
conversion, and shares `EDITING_LIMITS.bytes`. A load scope contains no invented
operation, revision, submitted value or mutation. Protocol negotiation still
belongs to the selected v1 endpoint and transport.
