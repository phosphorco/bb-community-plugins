# Perspectives coordinator recovery design

## Durable ownership

`gather_perspectives` validates a request, stores a versioned request in the
first persisted coordinator prompt, queues the caller's 26-minute backstop, and
then creates one ordinary hidden coordinator child. The coordinator thread ID
is the run ID. The coordinator uses the registered Perspectives tools for BB
orchestration and result publication, so those operations do not depend on
shell approval in provider auto mode.

BB owns the durable run records:

- the coordinator's first requested event and subsequent transcript;
- direct hidden worker children and their persisted final outputs;
- wrap-up, deadline, and per-lens launch-intent queue rows;
- the final artifact in coordinator thread storage.

The plugin adds no journal, checkpoint database, or in-memory runner. Native
worker completion reports and scheduled tells prompt a fresh coordinator
turn; every turn reads BB's persisted state again. Queue rows and prompt text
are durable evidence of intent and state, not provider-delivery receipts.

## Authentication and protocol stability

Coordinator operations require all of the following: the tool's
`context.threadId`, a hidden thread whose direct parent is the request's caller,
the first persisted `client/turn/requested` event containing a valid protocol
request, and matching caller, project, and environment identity. Titles are
discovery hints only; renaming a coordinator does not invalidate the run.
Caller retrieval accepts only a verified hidden direct coordinator child of
the current caller. A worker cannot operate on its parent's queue, children,
or storage through Perspectives tools, and help and gather reject verified
workers. Worker read-only instructions do not constrain host permissions;
inherited or configured worker permission can allow actions outside the
plugin's tools. The synchronous dynamic-configuration callback cannot inspect
persisted events. A Perspectives-origin parented thread therefore receives
only the scoped coordinator operations unless its title marks it as a worker;
that title is used only to withhold orchestration tools. Other plugin-origin
callers retain gather/read access. Persisted identity and parent, project, and
environment checks at execution remain the authority. A renamed worker may see
the narrow operations advertised, but execution rejects it.

The request has an explicit protocol version. Keep the version 1 decoder
stable across plugin prompt edits and upgrades; add a separate decoder before
changing the stored request format. The persisted prompt is not a
cryptographic capability: an actor able to create a hidden lookalike child
may spoof it. Actual effects remain confined to that thread and its direct
children, and retrieval still requires the real parent-child relationship.

## Wake and worker ordering

On each coordinator turn, `perspectives_coordinator_step` reconciles exactly
one wrap-up row and one deadline row. A row is ready only if it is confirmed
pending or its target time is due. **Both** rows must be ready before any
worker launch. The coordinator does not spawn research workers with one failed,
ambiguous, duplicate, or unavailable required wake.

If at least one required row has a persisted `failureReason`, the other wake
state is known (confirmed, due, or failed), and no worker launch has been
attempted, the product checks the queue records again and verifies that no
worker child or per-lens launch-intent record exists. Only that definite
no-research state can publish an immediate failed artifact. If the failure
cannot be independently verified, the other state is ambiguous/unavailable,
or any worker launch may have been attempted, the step reports setup
uncertainty and keeps publication closed. The coordinator ends the turn;
recovery depends on an already confirmed wake, the caller backstop, or explicit
queue recovery/operator action.

Once both required wakes are ready, the coordinator writes one scheduled
launch-intent row per lens before attempting its ordinary hidden worker spawn.
Those 2–7 additional rows are scheduled for the caller backstop time. They
freeze a slot after an ambiguous spawn so a later wake cannot blindly create a
duplicate if the original spawn committed late. Keep them until the final
artifact passes readback verification, then remove the still-pending run
wakes and launch-intent rows. If publication never finishes, intent rows can
cause extra backstop-time wakes for reconciliation.

On each native child report or scheduled wake, the coordinator matches
workers using direct parentage, project/environment, and the exact persisted
first prompt for a lens slot. A title can flag a malformed child for review,
but does not establish worker identity. BB's latest persisted final agent
message is the only worker output treated as evidence. If `threads.output`
returns no final message, that lens is unavailable; intermediate transcript
events and excerpts in native notices are not treated as partial research.
At or after the deadline, the coordinator stops verified active workers,
reconciles status/output again, and publishes complete, partial, or failed
status from the available final outputs and the coordinator's explicit
coverage assessment. Product code records worker-output availability
separately. Complete status requires exactly one idle verified worker with a
persisted final output for every requested lens and a `complete` coordinator
assessment. That assessment is not mechanically verified: complete output
availability does not prove that sources were inspected adequately or that
the synthesis is factually complete. Missing, unknown, or unsupported lens
coverage must be labeled partial. Legacy publication calls that omit the
assessment default to partial.

## Artifact protocol

The coordinator publishes
`perspectives/results/<coordinator-id>.md` through `perspectives_publish_result`.
Product code defines the body as the exact UTF-8 byte slice between
`<!-- perspectives-body:start -->` and `<!-- perspectives-body:end -->`.
It computes SHA-256 over those bytes, places that body digest and a terminal
run/status marker in the file, and returns the full-file digest separately
because a digest embedded in its own file would change the bytes being hashed.

Publication uses `threads.storageLocation` and the BB SDK file API with
`expectedSha256: null`, mode `0600`, and parent creation enabled. It reads the
file back and verifies exact bytes, UTF-8 round-trip, run ID, status, body
boundary and digest, terminal marker, host-reported full-file digest, and byte
length. An identical existing artifact is idempotent. A conflict, divergent
file, or corrupt file is never overwritten. The caller's read tool verifies
direct parentage first, then repeats byte-level validation against the
coordinator ID.

Caller result retrieval never deletes the scheduled backstop. After the
artifact is verified, it reads the latest `turn/completed` row and requires a
successful completion. It then pages backward through that turn's
`item/completed` rows. Suppression requires the turn's last completed item to
be an agent message containing an exact standalone HTML comment with the
coordinator ID and full-file SHA-256; a receipt on an earlier assistant item
followed by another completed item is insufficient. BB returns event rows with sequence, turn scope, and stored
item text; the comment therefore remains available to this check while normal
Markdown rendering hides it. The caller should include the receipt line
returned with the artifact in its final answer after presenting the result. If
no final answer was saved before a crash, the marker is absent and the full
artifact is returned; the backstop remains available. Mismatched markers,
interrupted turns, and event-read failures also return the artifact. The scan
is bounded to five 100-event pages; if the marker falls outside that window,
the artifact is returned. An explicit user request can retrieve it with
`includeArtifact: true`. Legacy markerless presentations may be repeated.
Native duplicate reports and retries remain possible, so this is not an
exactly-once visible-delivery guarantee.

Run queue rows are removed only after successful artifact readback. A missed
or failed delete leaves an extra native wake; it does not invalidate the
verified artifact. A divergent pre-existing artifact remains an error and is
not replaced.

## Timing and failure limits

The wrap-up, deadline, and caller backstop targets are 20, 25, and 26 minutes
from the gather request. They are queue targets, not delivery guarantees.
Host availability, queue dispatch, and provider scheduling can delay a wake.
If the sole scheduled row has `failureReason` and the native report is lost,
BB does not guarantee another wake; explicit queue recovery or operator action
is required. The caller backstop may therefore arrive without an artifact.
The plugin does not claim eventual delivery, exactly-once worker creation, or
a strict wall-clock completion bound.

An interrupted worker without a stored final message is unavailable even if
intermediate text exists. An unavailable host/file read is not equivalent to
an absent file. An invalid digest or terminal marker is never reported as a
successful result. Ambiguous coordinator spawn can leave multiple possible
runs after a replay; separate run IDs and artifacts are disclosed rather than
merged.

## Verification evidence

Product tests invoke the registered tool handlers against an injected BB SDK
boundary. They cover registration/configuration, coordinator and caller
authorization, title changes, normal worker reconciliation, failed and
ambiguous wake setup, definite no-research publication, create-only byte
verification, corrupt artifact rejection, and caller readback. These tests do
not prove that a provider in auto mode calls the tools or that scheduled rows
dispatch after an actual server restart. Those claims require an isolated
live-runtime turn with the server restarted during worker activity and a
post-restart scheduled wake dispatch observed in BB's persisted events.
