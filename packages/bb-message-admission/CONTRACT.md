# Native message admission, wire version 1

Package version `0.1.0-alpha.2`. This document specifies the protocol. Package
fixtures are synthetic boundary examples, not evidence that native operations,
queue behavior, provider delivery or feedback recovery have been implemented.
The authoritative types and codecs are exported by `/protocol`.

## Ownership

| Owner | Owns |
| --- | --- |
| Native core | Submission normalization, actual authority, immutable publication storage/enrollment, operations and acceptance transactions, evidence capture/revalidation, placement selector, durable originals/activity, request mappings, feedback obligations and handoff recovery |
| Contract package | Data shapes, codecs, version negotiation, exact injected method binding, canonical fingerprints, bounds and controlled-port test driver |
| Message Rules | Authored global catalog, scopes/enables, policy semantics, complete applicability, inference ledger, evaluator, authoring/testbench and product feedback |
| Affected consumers | Feature attempts/session/actor binding, durable cursor consumption and product rendering |

There is no supplier registry, storage, permission service, provider client,
React, polling, timer or independent delivery runner in this package. Native
renderer projections may retain native types; the public original manifest is
`AcceptedOriginalV1`, not a reconstruction from a lead renderer projection.

## Negotiation and binding

Call `bindMessageAdmission(bb: unknown)` from `/bb`. A public registry
`BbPluginApi` or browser SDK is assignable without copying or augmenting its
declarations. The optional member is treated as unknown until negotiation.

`describe(null)` returns a tolerant envelope:

```ts
{
  protocol: 'bb-message-admission',
  versions: [1],
  capabilities: {
    admission: true, publication: true, operations: true,
    placement: false, originalManifest: false, activity: false, feedback: false,
    limits: {
      requestBytes, responseBytes, snapshotBytes, evidenceBytes, manifestBytes,
      evaluationMs, concurrentEvaluations,
    },
  },
}
```

The envelope is decoded first; capabilities are decoded only if version 1 is
advertised. `[1]` and `[1,2]` negotiate 1; `[2]` and `[]` are incompatible.
Malformed versions are incompatible. Describe is capped at 65,536 canonical
UTF-8 bytes and 16 advertised versions. Unknown envelope/capability additions
are preserved. Admission, publication and operations are the required baseline.
Optional flags must stay false until their real implementations exist. Every
method required by an advertised feature is validated; a missing method makes
the binding incompatible. Method validation alone does not prove semantics.

The result is exactly one of:

- `{status:'unsupported', reason:'absent'|'incompatible', detail}`;
- `{status:'unavailable', detail}` for capability access/describe failure;
- `{status:'available', version:1, capabilities, client}`.

Operational inputs are strict at every typed nested boundary; output objects
preserve additive fields recursively. Opaque native JSON, policy bytes and
execution configuration are deliberately data, not unknown typed extensions.
Enum meanings are closed; incompatible enum/semantic changes require another
protocol version. The binding preserves native method `this`. It never discovers
plugins, falls back to legacy prefix grouping or simulates enforcement.

## Required methods

| Exact native method | Input | Result |
| --- | --- | --- |
| `describe` | `null` | `DescribeV1` |
| `registerEvaluator` | `{version:1,evaluatorVersion}`, `EvaluatorV1` callback as second argument | `RegistrationV1` |
| `unregisterEvaluator` | `{version:1,registrationId,generation}` | `{version:1,removed}` |
| `publish` | `PublishInputV1` | `PublishResultV1` |
| `readActivePublication` | `{version:1,providerId}` | `PublicationV1` or `null` |
| `lookupOperation` | `{version:1,operation}` | `LookupOperationResultV1` |
| `recheckOperation` | `{version:1,operation,expectedRequestFingerprint,recheckId}` | `LookupOperationResultV1` |

A native implementation is typed by `NativeAdmissionProtocolV1`. The injected
client methods return promises even if a native read returns synchronously.

An operation key is `{namespace,operationId}`, both bounded nonempty IDs.
Native owns namespaces and binds registration/publication to the actual calling
plugin lifecycle. A caller-provided provider ID, source label or text is not
identity evidence or authority. A registration returns a generation and ID;
unregister compares both, so stale teardown cannot remove a newer evaluator.
Reload invalidates uncommitted tickets. An expected enforcing evaluator that is
unavailable produces unresolved work; it does not silently disable enrollment.
Accepted revisions replay their frozen semantic admission across reload/restart.

## Publications and explicit enrollment

`PublishInputV1` contains a stable operation, provider ID, nullable
`expectedActivePublication` CAS reference, exact `snapshotBytes`, nonsecret
configuration version, compatible evaluator version and explicit enrollment:

```ts
{mode:'disabled', projectIds:[]}
// or
{mode:'enforce', projectIds:['explicit-test-project-id']}
```

An enforcing empty list, duplicate projects or disabled nonempty list is invalid.
There is no wildcard/global implicit enrollment. Installation, migration, save
and Test all cannot activate policy. Initial live use must name the dedicated
test project permitted by the grant. Scope/enrollment changes require a new
immutable publication and the same expected-pointer transaction; deactivation
publishes disabled enrollment and retains evidence. Native may not read mutable
feature tables as a replacement for immutable publication bytes.

`snapshotBytes` is exact canonical JSON text; strings containing noncanonical
whitespace, invalid JSON or data above the native snapshot budget are rejected
before the binding invokes a write. Core stores exact bytes. The policy DSL and
credentials stay feature-owned. A failed publication leaves the old active
pointer authoritative; the saved and active revisions remain distinct.

`PublicationRef = {providerId,publicationId,fingerprint}`. The fingerprint is
`publicationFingerprint({version:1,providerId,snapshotBytes,configurationVersion,
evaluatorVersion,enrollment}, maxBytes)`. It excludes only publication operation
and expected active pointer, which remain journal/CAS facts. It includes the
entire activation configuration. IDs and fingerprints do not confer authority.
`PublishResultV1.status` is `published` or `conflict`, with operation, immutable
publication (nullable), active reference (nullable) and complete reasons.

The binding recomputes the full immutable content fingerprint before evaluator
work and whenever full publication data re-enters through publish responses,
active reads, operation lookup or recheck. Canonical bytes with a mismatching
fingerprint are invalid, even when their shape and JSON encoding are valid.
All method inputs are copied and frozen before native invocation; callback
registration identity uses that retained snapshot, not a caller-mutable object.

After reload, read the native active publication before choosing a new CAS basis.
After an ambiguous write, use the same publication operation lookup and compare
immutable content; never manufacture a new operation to replay an unknown effect.

## Submission, verdict and original boundaries

`SubmissionV1` preserves the stable operation, request fingerprint, exact
`original:{originalId,revision}` (positive safe integer), native thread/project,
raw native JSON input, typed policy context, requested intent, source, kind,
explicit full override and nullable promised placement witness.

`policyContext` is native-derived `{messageText,projectTitle,senderTitle,
destinationTitle}` with nullable titles. Message Rules uses these declared
fields, not heuristics over raw native JSON. Evidence metadata is exactly
`{projectId,threadId,senderThreadId,policyContext}` (outputs allow additions).
Selected titles/routing metadata belong to the native read set and commit check.

`RequestedIntent` separates:

- `mode`: `proceed`, `steer` or `queue`;
- `schedule`: ordinary, scheduled with ISO `notBefore`, or legacy-unknown;
- `membership`: preserve, separate or join-next-ordinary;
- `execution`: explicit provider/model/reasoning/serviceTier/permissionMode
  nullable choices, `canAsk` and preserved JSON configuration.

`EffectiveIntent` retains the same dimensions and an ordered list of changes
with field, cause rule IDs and explanation. Queue batched means queue plus
join-next-ordinary. A schedule is immutable intent, distinct from operational
wait timestamps. Unknown legacy timing is not inferred from current row order.
Sender diversity does not itself prevent grouping; incompatible explicit
execution choices do. Restrictive escalation is a meet of all members' actual
ceilings, never adoption of the lead member's settings.

`OriginalSource` keeps raw sender thread, initiator, author, latest editor,
origin, external operation and native visible-human-activity fact. Native
attribution JSON is preserved as data; the package creates no replacement
identity or permissions. Original input carries attachments in its native JSON
representation. A diverse group cannot substitute one scalar sender/author for
its originals or grant authority through order. There is no reply-to-all.

`submissionFingerprint` covers every declared submission field except operation
and the fingerprint itself, with a versioned domain separator. Core normalizes
actual input/identity before computing it. Same key and fingerprint replays the
known operation without repeating evaluation or native insertion. A changed
fingerprint conflicts and cannot overwrite the old operation. Producers without
a retained client key cannot claim lost-response deduplication across requests.

A rule observation retains group/rule/revision, pass/reject/unresolved/
not-applicable status, causes, advice and routing/membership preferences.
`reduceObservations` merges all supplied observations, keeps every known cause
and distinct advice in order, and returns accepted/rejected/unresolved.
The feature must enumerate **all** applicable enabled rules from the frozen
catalog; a helper cannot establish completeness of that catalog enumeration.
Conflicting applicable preferences or missing required results produce
`verdict:'unresolved', complete:false`, with known causes/advice retained.
Unresolved cannot be final partial rejection or accepted. A complete rejection
collects all applicable causes before returning. Reject/unknown work has no
accepted queue/provider eligibility and preserves the draft/original identity.

A native operation record includes key/fingerprint, kind, status, assessments,
nullable accepted original/publication/feedback, explicit delivery state and
reasons. Alpha.2 adds optional `acceptanceReceipt?: JsonValue`, native-produced
immutable source-specific acceptance response metadata. It remains the original
acceptance response as live queue/request/provider state advances or its queue
row disappears. Native core owns atomic persistence with acceptance and
immutability; the package validates finite JSON within the full response budget
and preserves its data without interpreting source-specific fields.

For direct queue acceptance, a receipt can omit raw input; the native API may
restore it from the canonical `acceptedOriginal`. A native preparation receipt
may remain initially accepted/preparing even after `delivery.state` advances.
Never reconstruct canonical originals or infer current delivery/provider status
from the receipt. It supplies no new authority, capability flag or host method.
Alpha.1 absence is valid and distinct from an explicit JSON null; neither absence
nor receipt payload labels change the operation's verdict or negotiated support.
Existing strict inputs, additive output fields and unknown-write reconciliation
semantics are unchanged. The controlled-port replay driver compares explicitly
present receipts as immutable admission data while permitting delivery progress.

`lookupOperation` returns found+record or missing+null; failure is not
missing. Recheck is an explicit operation on the same original/fingerprint with
a stable recheck ID. It fences generations and cannot blindly replay an
invoked-but-unknown paid partition. The package does not run inference.

## Evaluator and selected evidence

`EvaluatorV1(input, context)` receives `EvaluatorInputV1` with version,
stable assessment ID, current evaluator and cancellation generations, native
deadline, normalized submission and exact immutable publication bytes/identity.
The context supplies `AbortSignal` and callback-local `captureEvidence`.
The binding validates and freezes a data copy before feature execution; it
fences late completion after cancellation. Native enforces its own deadline,
concurrency and synchronous acceptance generation check. Caller cancellation
cannot prove remote work or paid inference never executed.

Evidence requests name up to 16 sender/destination windows, latest/since-clear
selection, per-window limit (1..2000) and `prefixMode:'native-candidate'`.
There is no arbitrary caller-provided history replacement, prefix or thread ID.
The native candidate determines counterfactual retained prefix for an edit.
Across an assessment the binding permits at most 16 captures and 16 total
requested windows. The native service must apply the same limits to direct
capability callback consumers as well.

`EvidenceV1` returns a bounded opaque native validation token, exact operation,
original and assessment, capture time, typed metadata, ordered windows and
read-set fingerprint. Each window states thread/side/selection, complete/partial/
unavailable coverage, as-of cursor, latest-clear marker, missing reason and
ordered native events `{id,revision,sequence,text,data}`. Text is explicitly
native-derived; raw event data is preserved for diagnosis.

The binding verifies exact operation/original/assessment, every requested
window/thread/selection and count; only issued evidence tokens can appear in
the evaluator result. A token is not a security credential or fixture commit
ticket. Core owns the selected query and validates ordered content, metadata,
coverage, negative/empty facts, backfill/clear/rewrite and retained prefix in the
acceptance transaction. Continued existence of event IDs is insufficient.
Later appends after the as-of cursor do not continually invalidate a submission.
No process-local rewrite counter can substitute for restart-safe revalidation.

## Optional placement and original manifest

| Capability | Method | Input / result |
| --- | --- | --- |
| `placement` | `previewPlacement` | `PreviewPlacementInputV1` / `PreviewPlacementResultV1` |
| `originalManifest` | `readOriginalManifest` | `{version:1,threadId,requestId}` / `OriginalManifestV1` |

Preview requires `simulation:true`, a bounded saved fixture queue, native-shaped
candidate and fixture clock. Groups preserve ordered accepted originals,
open/divider/frozen state, claim/block state, order key and snapshot witness.
The result remains `simulation:true`, with join/singleton/separate/conflict,
exact target or null, ordered original IDs and full reasons. There is no live
original authority, acceptance token or write path. The **actual native pure
selector**, shared with native commit, must implement this method; the package
provides no second selector. An unavailable preview cannot report native test
success. Contract fixtures do not prove native placement parity.

Required semantics: `Q(A), S(T), B(queue batched)` becomes `Q(A,B), S(T)` while S
retains its schedule and own original. Scheduled S is not a divider or ordinary
attach target even after its due time. Initially absent/closed ordinary target
permits a visible singleton reason; an evaluated/promised target changing or
closing conflicts and preserves draft. Explicit dividers/incompatible choices
return complete conflicts, never forward search or silent retarget. Closing a
batch for first preparation/claim is durable; release/backoff/restart/head cancel
cannot reopen it. Ready Q precedes due S; blocked Q permits independently ready
S to progress under live execution constraints. Sustained arrivals cannot extend
a closed batch indefinitely. No exact wall-clock guarantee is made.

`OriginalManifestV1` includes exact thread/request, status, complete flag and
ordered `AcceptedOriginalV1` entries, maximum 256 total originals. Each keeps
original revision, namespaced operation, fingerprint, raw input/attachments,
source, requested/effective intent, acceptance timestamp/sequence and frozen
admission basis. Available means nonempty and complete; duplicates/overflow
are invalid. Legacy-unverified is an explicit compatibility state; missing
cannot claim complete. No drop-first-N or inferred erased legacy intent.
Request settlement maps every original to the exact native request/group index;
queue deletion or a missed callback cannot erase that correlation.

## Optional accepted activity

`activity` advertises both `readThreadActivity({version:1,threadId})` and
`listAcceptedActivity({version:1,threadId,afterSequence,limit})`.

The summary carries `messageAcceptanceSequence`, last visible human acceptance
time and original reference. The journal feed is ordered by acceptance sequence,
with source/original/time, explicit through/latest cursors and completeness.
A page limit is 1..256; incomplete catch-up cannot claim complete idle coverage.
The sequence is not an event cursor. Native commits these facts with acceptance;
queue cancellation/deletion/restart preserve them. Later dispatch/retry/import/
feedback cannot manufacture a new human-activity timestamp. Existing wakes are
hints; the durable summary/feed remains authoritative. Native and affected
observers must separately prove they use it.

## Optional feedback and exact exemptions

`feedback` advertises `submitFeedback({version:1,providerId,original,
rejectionAssessmentId})`. It accepts no text, recipient override or bypass flag.
Native derives complete immutable advice, cause binding and known recipient from
the existing obligation. The result names obligation/operation/provider/original/
assessment/recipient, causes/advice, native request, verification and reasons.
States distinguish pending, blocked-by-policy, native-accepted,
provider-input-accepted, consumed-verified, uncertain,
superseded-without-send and undeliverable. Consumed-verified requires causal
request/verification evidence; codec validity alone cannot prove consumption.

The genuine delayed final disposition transaction must create the deterministic
obligation atomically, before any feature receipt or call to submitFeedback.
Native startup/catch-up discovers obligations in bounded indexed pages and owns
recovery through the normal native operation path. A failed disposition CAS
creates none. No feedback obligation is invented merely because policy changed
after frozen acceptance. Unknown effects are reconciled by exact native
operation/request, never blind resend. Native acceptance is not provider input
acceptance, and neither alone is verified advice consumption.

The optional native-derived `SubmissionV1.feedbackBinding` names exact provider,
obligation, parent original/assessment, recipient and advice fingerprint. Native
must validate it against its stored obligation and immutable payload. Message
Rules may exempt only its own exact binding. Other providers, neighboring
originals and ordinary lookalike text remain subject to normal policy. There is
no trust in caller labels or generic null sender exemption.

The closed `OPERATIONAL_EXEMPTIONS` set names standalone clear/compact,
historical import/accepted replay, exact accepted retry/continuation, and eight
native notices: ownership-assigned/removed, child-needs-attention/completed/
failed/interrupted/outcome-batch and tool-result-delivered. A typed exemption
correlates to an actual native operation/original. New or edited content and
compact-first content remain covered. Future/unlabeled kinds are not implicitly
exempt. Full Send-now is a separate recorded override. Identity, protocol,
execution, lifecycle, readiness and capacity still apply. Public coverage must
name exemptions and old-client limits before claiming universal admission.

## Bounds, errors and recovery

Wire invariants: 256 originals per manifest/fixture queue, 16 history windows per
assessment, 2000 events per window, 256 activity items per page, 256 ID characters,
8192 validation-token characters and JSON depth 64. IDs reject controls. Every
numeric cursor/revision/budget is a safe integer with the declared sign.

Byte/concurrency/deadline limits are required native-advertised connection
configuration, not package defaults: request/response/snapshot/evidence/manifest
bytes, evaluation milliseconds and concurrent evaluations. Hosts must calibrate
these against their supported real native inputs and reject capacity **before
acceptance** rather than truncate/drop originals or silently lower existing
support. Package fixture budgets are examples only, not a claimed measured safe
host configuration or latency guarantee. Each native release must witness exact
boundary and over-bound cases against its selected configuration.

`decodeBounded` validates canonical UTF-8 JSON bytes before DTO decoding, including
unknown output fields, plus finite plain JSON/depth. It rejects getters, cycles,
nonfinite values, sparse arrays and executable values without calling toJSON.
The native/transport may already have parsed/allocated input: this does not bound
raw wire bytes or pre-parse allocation. Native transport limits remain necessary.
Opaque snapshot text is additionally checked against its own budget. Evidence
and manifests use their dedicated advertised output budgets.

`AdmissionCallError.outcome` is `not-invoked` for binding input validation or an
unsupported optional feature, `read-failed` for read failures, or `unknown` for
write invocation/response validation failures. No error is converted into false
success, missing data or accepted work. No automatic retry, replay, lookup or
unregister occurs. Reconcile an ambiguous operation with one fresh lookup and
compare identity/content. Publication recovery also reads the active pointer.
If read reconciliation fails, keep uncertainty. Registration/unregister are
lifecycle/generation operations, with native plugin teardown responsible for
orphan bindings. Aborting a caller never proves non-execution.

## Conformance and release evidence

`/testing` exports `runCapabilityConformance` over the real caller-supplied
capability and named behavioral cases. Zero behavioral cases cannot pass.
Absent/incompatible/unavailable capabilities cannot pass. It reports only the
supplied coverage. `runNativeAdmissionConformance` additionally requires a real
caller-owned submission adapter over native prepare/commit or the public route,
a pristine disposable test publication/project and explicit fixtures. It uses a
controlled evaluator and checks immutable publications, active-pointer/replay,
verdict/advice completeness, journal lookup, exact fixture original ID/revision,
canonical destination/source/raw input/requested intent, evaluation count on
exact replay and generation-fenced unregister. Evaluator inputs are anchored to
the normalized submission fixture; publication replay and evaluator publication
are anchored to the initially published identity/content. Immutable replay
bases are captured before later calls, so an internally consistent wrong first
response or a later mutation cannot become its own expected result. The caller owns isolated
DB/project cleanup and remaining native proof cases. A scripted host used to
test the driver is kit self-test evidence only.

`CONFORMANCE_OBLIGATIONS` lists additional required native boundaries: changed
fingerprint conflict, publication/acceptance races, selected-evidence changes,
all queue/group races, durable closure, every-original settlement, activity
restart and atomic feedback obligation recovery. The built-in fixture driver
does not claim to cover them all. Real migrated DB, writer route, adverse
concurrency, process restart, actual provider/agent consumption and whole
product evidence stay separate. Source fixture parity is not live conformance.

Consumers pin this exact registry package version; no file/link/tarball/source
aliases in released manifests. Native/fork SDK declarations import authoritative
`/protocol` types and declare the exact dependency; emitted SDK declaration
bundling must preserve that external owned import and install resolution.
There is no SDK→protocol→SDK dependency cycle. The local packed probe uses the
owned tarball plus actual registry SDK 0.6.52, proving installed entry/type
resolution and unaugmented baseline input only. Publication, emitted fork SDK
conformance, full repository checks and runtime activation are separate steward
steps. No publication or deployment authority is supplied by this package.

### SDK testing fixture prerequisites

The SDK is not a runtime dependency of `/protocol`, `/bb` or `/testing` in this
package. A consumer that imports the separate registry SDK's `/testing` entry
must provide the optional peers that its actual fixture uses. The SDK 0.6.52
Message Rules factory fixture was checked with `cron-parser@5.10.0`,
`hono@4.11.9` and `better-sqlite3@12.11.1`; SQLite requires a working native
binding. A missing `cron-parser` stopped the first isolated adopter before
product execution. With the explicit peers, the actual controlled factory
fixture passed 8/8 against registry alpha.1 and a locally packed MR artifact.
This recorded predecessor evidence does not establish alpha.2 publication,
native behavior, live enrollment or provider inference. The package's local
packed probe tests receipt/type/entry boundaries without claiming to execute
that SDK factory fixture or installing its optional native peers.
