# bb-plugin-perspectives

Perspectives registers five native BB agent tools:

- `help` asks one focused expert for a concise, read-only, source-cited answer. It is synchronous; the expert's answer is the tool result.
- `gather_perspectives` accepts 2–7 distinct caller-supplied lenses and starts a background panel.
- `perspectives_coordinator_step` reconciles one authenticated coordinator run through BB's thread and queue SDK.
- `perspectives_publish_result` creates and verifies that coordinator's immutable result artifact, then notifies the caller.
- `perspectives_read_result` lets a caller find or read the verified artifact of a coordinator it owns.

[COORDINATOR_DESIGN.md](COORDINATOR_DESIGN.md) records the recovery design in
detail; this file summarizes behavior and limits.

## Roles

| Thread | Relationship | Responsibility |
| --- | --- | --- |
| Caller | the agent that calls `gather_perspectives` | Launches the panel, then reads and presents the verified artifact when woken. |
| Coordinator | hidden root thread, lifecycle-owned by the caller | Agent turns call `perspectives_coordinator_step`; the coordinator writes the synthesis and calls `perspectives_publish_result`. |
| Worker | hidden child of the coordinator, also lifecycle-owned by it | Researches one lens read-only; its final message is the evidence. |

Plugin code, not the agents, does the orchestration: queue rows, worker spawns,
reconciliation, artifact bytes, the completion message, and the backstop.

## Wake budget

BB reports every turn a child finishes to its parent and starts a parent turn
for it. Workers are the coordinator's children, so each worker report wakes the
coordinator to reconcile. The coordinator has no parent: its bookkeeping turns
never wake the caller. Lifecycle ownership still archives and deletes the
panel with the caller.

The caller is woken once per successful run, by an agent-only
`Perspectives panel result ready` message that the publish tool sends after the
artifact passes readback verification. `gather_perspectives` also queues a
`Perspectives panel backstop` in the caller before it spawns the coordinator,
targeted 10 minutes after the run deadline (about 35 minutes after launch). An
completion message that BB has delivered to the caller removes it; a message
that is only queued keeps it, because a queued row can still fail. The
backstop is therefore delivered only when the completion was not confirmed
as delivered, the coordinator failed silently, publication
never happened, or the launch was uncertain. If its removal fails, it arrives
anyway and the read tool answers from the presentation receipt (below).

## Panel lifecycle

`gather_perspectives` validates the request and execution settings, confirms
the caller backstop row (no coordinator is spawned without it), then spawns
the coordinator with a versioned request in its first prompt. The coordinator
ID is the run ID. An ambiguous spawn is rediscovered from the first persisted
`client/turn/requested` input among this plugin's hidden root threads owned by
the caller; no unique match means launch uncertain, and the backstop remains
the recovery path. Replaying a request may create another coordinator.
Identical request identities can be intentional, so possible duplicates and
their artifacts stay separate.

The coordinator calls its registered BB tools from auto mode; orchestration
and artifact writes do not depend on shell commands or shell approval. Before
launching workers, it confirms both its wrap-up (20 minutes) and deadline
(25 minutes) queue rows. Only when both are confirmed or already due may it
create workers. Each lens first gets a launch-intent row in the coordinator,
scheduled at 26 minutes, so a late-committing ambiguous spawn is never blindly
retried. All of these rows are removed after the artifact passes readback; if
publication never completes, intent rows wake the coordinator to reconcile.

At the wrap-up time, active workers are asked to return their strongest
supported findings. When the deadline wake is handled, remaining active
workers are stopped and the available final outputs are reconciled.

If at least one required wake row has a persisted `failureReason`, the other
wake state is known, and no worker launch intent or child exists, the
coordinator can publish a failed artifact immediately. The publisher rechecks
the queue states and absence of worker attempts, and the artifact states that
no research was performed. An ambiguous or unavailable queue state does not
authorize workers or early publication; the coordinator ends the turn, and
recovery depends on a confirmed wake, the caller backstop, or explicit queue
recovery.

## Evidence and coverage

For each verified worker, BB's latest persisted final agent message is the
research output. If no final message exists, that lens is unavailable.
Intermediate event text and excerpts in native notices are not treated as
usable partial findings.

The coordinator supplies a conservative complete/partial coverage assessment.
Product code separately reports mechanical worker-output availability and caps
complete status unless every requested lens has exactly one idle verified
worker with a persisted final output. The assessment is not mechanically
verified: even `Status: complete` does not prove sources were adequately
inspected or that the synthesis is factually complete. Publish calls without
a coverage choice default to partial.

Experts cite material factual claims from primary evidence they actually
inspected, distinguish supplied context from inference, preserve disagreement,
and identify unknowns. Queue acceptance, spawn responses, worker count, and
native notices do not prove delivery or completion, and agreement is not
treated as proof.

## Authorization and trust limits

Coordinator operations authenticate the current `context.threadId` against
the persisted protocol-versioned request in its first `client/turn/requested`
event, the caller recorded there, and matching project/environment. A v2
coordinator must have no parent and be lifecycle-owned by that caller; a
legacy v1 coordinator must be the caller's direct child. Caller retrieval
accepts only such a verified coordinator of the current caller. Titles are
discovery hints only; renaming a coordinator or worker does not invalidate a
run. Coordinator effects are confined to its own children, queue, and storage,
plus the caller's completion message and backstop.

The synchronous tool-configuration callback cannot inspect persisted events,
so it only chooses what to advertise. Recognizable workers get no Perspectives
tools. Coordinators, identified by role metadata seeded at spawn (older v2 runs
by their title prefix, legacy v1 runs by their parent), get only the step and
publish tools. Other threads this plugin creates, the `help` planner and
expert, get none, so they cannot delegate. Every other thread, including other
plugins' threads, gets `help`, `gather_perspectives`, and
`perspectives_read_result`. Execution still verifies persisted identity, and
the gather and help handlers reject verified workers and coordinators.

Worker read-only behavior is an instruction, not a host sandbox guarantee.
Worker permission mode may be inherited or explicitly configured up to the
host ceiling; a source-content prompt injection could induce actions within
that authority. Set the worker permission mode to an approval-gated option
when the provider supports one, and review the host's actual permission
contract before using untrusted sources.

Persisted prompt text is durable identity evidence, not a cryptographic
capability. A user able to create a hidden thread with a lookalike request can
spoof the marker. Such a thread can affect only its own thread and direct
children, and retrieval still requires its actual lifecycle owner (or legacy
parent) to be the caller. The plugin adds no journal or checkpoint store.

## Artifact bytes and verification

The result file is `perspectives/results/<coordinator-id>.md` in coordinator
thread storage. Product code defines the body as the exact UTF-8 byte slice
between the first `<!-- perspectives-body:start -->` after the fixed header
and the final `<!-- perspectives-body:end -->` before the fixed footer. Quoted
delimiters inside the synthesis remain body text. It computes a SHA-256 over
that slice and places it in the file's terminal marker. The full-file SHA-256
is returned by the publish/read tools because embedding it in the same file
would change the bytes being hashed.

Publication uses the BB SDK's atomic create-only file write
(`expectedSha256: null`, mode `0600`) and then reads the file back. It checks
the exact UTF-8 body boundaries, run ID, status, body digest, terminal marker,
host SHA-256, and byte length. An identical existing file is idempotent; a
divergent or corrupt file is never overwritten. The caller tool repeats full
file verification against the coordinator ID before returning the artifact.

## Completion message and presentation receipts

The completion message is sent once per artifact digest. Send intent is
recorded in coordinator metadata before dispatch, and caller queue rows and
request events establish acceptance. Replays reconcile acceptance and never
blindly repeat a persisted attempt. An uncertain or merely queued message
keeps the backstop, and a failed queued row does not count as acceptance.
The metadata write is not a compare-and-set, so simultaneous publication calls
can still duplicate a notification.

After verifying the artifact, the read tool finds the caller's latest
successful `turn/completed` event and pages backward through that turn's
`item/completed` events. It suppresses the body only when the turn's last
completed item is an agent message containing the exact standalone receipt
comment with the run ID and full-file SHA-256. The BB event API returns stored
agent-message text, so the comment is available to this check while normal
Markdown rendering hides it. The caller includes the receipt line returned by
the tool in its final answer. A missing, mismatched, interrupted, or
unreadable final answer returns the full artifact again; the scan is bounded
to five 100-event pages. An explicit user request can retrieve it again with
`includeArtifact: true`. Legacy markerless presentations, duplicate messages,
and retries can still repeat a result, so the plugin does not claim
exactly-once presentation.

## Timing and delivery limits

The 20-minute wrap-up, 25-minute deadline, 26-minute launch-intent, and
35-minute backstop times are scheduling targets, not delivery guarantees.
Queue acceptance does not prove provider acknowledgement. If a scheduled row
gets `failureReason` and the other signals are also lost, BB does not
guarantee another wake; explicit queue recovery or operator action is
required. A run that is still unpublished when the backstop arrives is
reported as missing rather than awaited. The plugin does not claim eventual
delivery, exactly-once worker creation, or a strict wall-clock deadline.

## Execution settings

Planner settings apply to the synchronous `help` planner and the panel
coordinator, which also writes the synthesis. Worker settings apply to the
`help` expert and panel workers. Blank provider/model settings and `inherit`
selectors use the caller's resolved tuple; configured tuples are validated
before gather queues work. The plugin does not silently escalate a permission
mode. A `full` mode is used only when the caller already has it or the
operator explicitly selects it in settings.

## Compatibility

New runs use protocol v2 and require a BB host whose threads expose
`lifecycleOwnerThreadId`; on other hosts `gather_perspectives` fails before
any queue row or thread is created, and launch is acknowledged only after the
created coordinator's ownership is confirmed. The server SDK declarations of
the pinned `@get-bb/plugin-sdk` omit the field, so it is passed through the
public spawn request and checked on the returned thread. Protocol v1 runs
remain readable: they keep parent authentication and BB's native parent
reports, and their previously queued caller reminders are left untouched. The
persisted request decoder accepts exactly versions 1 and 2; a future request
format must add a version rather than change these. The legacy request field
`callerBackstopAtEpochMs` names the launch-intent time, not the caller
backstop.

## Install and development

From this directory:

```sh
bb plugin install .
```

After editing sources, reload with `bb plugin reload perspectives`.
Development checks for this package are `npm run test --workspace
@phosphorco/bb-plugin-perspectives`, `npm run typecheck --workspace
@phosphorco/bb-plugin-perspectives`, and `npm run build --workspace
@phosphorco/bb-plugin-perspectives` from `community-plugins/`.

### Provider settings local pilot (shipping held)

The source pilot registers the shared owner protocol for `planner` (help planner,
panel coordinator and synthesis) and `expert` (help experts and panel workers).
Each role owns only its provider/model/reasoning keys. Permission controls remain
in this plugin's native settings form and are never written by a shared Save.
Stored nonblank catalog IDs remain exact until deliberately changed. Blank legacy
values and the native `inherit` sentinel become absent fields in the adapter.

Shared intent is global; eligibility is checked against the calling thread at
invocation. Optional host/environment samples are read-only catalog context,
never caller defaults or a storage destination. Partial model/reasoning intent
without a provider stays deferred. Read does not browse catalogs, provision an
environment, or migrate settings. Inherit/reset needs no destination. Existing
runs retain the execution tuples frozen in their protocol-v2 request.

This increment is verified locally against a hash-bound npm archive, not a
published dependency or loaded native host. The production manifest and community
lockfile intentionally retain their original dependency metadata. Release is
blocked until the shared package is published and the ordinary npm dependency,
source file list, supported SDK/build target and app entry are separately agreed.
The existing native form remains the local editor; no shared React controls or
mounted native picker proof are claimed by this server-only increment.

The source-fixture runner lives at
`plugins/packages/bb-provider-settings/test/integration/consumers/perspectives/run-packed.mjs`
in the canonical workspace. It installs the immutable archive with ordinary npm,
temporarily links only that installed package for canonical source resolution,
checks the leaf and actual factory/handler driver, and retires its link, npm cache
and fixture. Receipts label SDK tests and bundles as source/build evidence, never
native role capabilities. Native first-turn execution, restart/wake behavior on
an actual host, owner calls and final release packaging remain separate gates.

The legacy native form still trims provider/model only at invocation. Shared
Read/Save and raw fingerprints preserve the configured nonblank bytes. Thus a
padded saved ID invokes the same tuple as its unpadded form without migrating the
stored intent. Specific unavailable-provider/model/reasoning diagnostics remain
feature-facing; diagnostic row lookup cannot generate an execution tuple.
