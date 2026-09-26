# bb-plugin-perspectives

Perspectives registers five native BB agent tools:

- `help` asks one focused expert for a concise, read-only, source-cited answer. It is synchronous; the expert's answer is the tool result.
- `gather_perspectives` accepts 2–7 distinct caller-supplied lenses and starts a background panel.
- `perspectives_coordinator_step` reconciles one authenticated coordinator run through BB's thread and queue SDK.
- `perspectives_publish_result` creates and verifies that coordinator's immutable result artifact.
- `perspectives_read_result` lets a caller find or read a verified direct-child coordinator artifact.

## Restart-resilient panel lifecycle

Before it spawns a hidden ordinary coordinator child, `gather_perspectives`
queues one caller backstop for about 26 minutes later and verifies the exact
pending row. The coordinator ID is the run ID. An ambiguous coordinator spawn
is rediscovered from the first persisted `client/turn/requested` input and
direct parent relation; no unique match means launch uncertain. Replaying a
request may create another coordinator. Identical request identities can be
intentional, so possible duplicates and their artifacts stay separate.

The coordinator calls its registered BB tools from auto mode; orchestration
and artifact writes do not depend on shell commands or shell approval. Before
launching workers, it confirms both the wrap-up and deadline queue rows.
Only when both are confirmed or already due may it create ordinary hidden
worker children. Each lens also gets a scheduled launch-intent row before its
spawn attempt. The 2–7 extra rows are scheduled for the caller backstop time:
they freeze a lens after an ambiguous spawn so a late child commit cannot be
blindly retried. Keep them until the final artifact has passed readback
verification; then remove the still-pending wrap-up, deadline, and launch
intent rows. If publication never completes, the intent rows can dispatch at
the backstop and prompt reconciliation.

If at least one required wake row has a persisted `failureReason`, the other
wake state is known, and no worker launch intent or child exists, the
coordinator can publish a failed artifact immediately. The publisher rechecks
the queue states and absence of worker attempts. It states that no research
was performed. An ambiguous or unavailable queue state does not authorize
workers or early publication; the coordinator ends the turn with setup
uncertainty and relies on any confirmed wake, the caller backstop, or explicit
queue recovery.

Native worker reports and scheduled wakes prompt reconciliation. For each
verified worker, BB's latest persisted final agent message is the research
output. If no final message exists, that lens is unavailable. Intermediate
event text and excerpts in native notices are not treated as usable partial
findings. When the deadline wake is handled, remaining verified active workers
are stopped and the available final outputs are reconciled. The coordinator
supplies a conservative complete/partial coverage assessment. Product code
separately reports mechanical worker-output availability and caps complete
status unless every requested lens has exactly one idle verified worker with a
persisted final output. Missing, duplicate, inactive, or unavailable worker
outputs prevent complete status. The coordinator's coverage assessment is not
mechanically verified: even `Status: complete` does not prove sources were
adequately inspected or that the synthesis is factually complete. The prompt
instructs the coordinator to choose partial whenever a lens could not inspect
sources, cannot answer, or coverage is uncertain. Legacy publish calls without
a coverage choice default to partial.

## Authorization and trust limits

Coordinator authentication uses the persisted protocol-versioned request in
the first `client/turn/requested` event, the current `context.threadId`, its
direct `parentThreadId`, and matching project/environment. A mutable title is
only a discovery hint; renaming a coordinator or worker does not invalidate a
run. Coordinator effects stay on that context thread's children, queue, and
storage. Caller retrieval accepts only a verified hidden direct child of the
current caller. The synchronous tool-configuration callback cannot inspect
persisted events, so a Perspectives-origin parented thread receives only
scoped coordinator operations unless its title marks a worker; that title is
used only to withhold tools. Other plugin-origin callers retain gather/read
access. Tool execution still verifies persisted identity and
parent/project/environment. Recognizable workers receive no Perspectives
tools, and the gather and help handlers reject verified workers after a rename.

Worker read-only behavior is an instruction, not a host sandbox guarantee.
Worker permission mode may be inherited or explicitly configured up to the
host ceiling; a source-content prompt injection could induce actions within
that authority. Set the worker permission mode to an approval-gated option
when the provider supports one, and review the host's actual permission
contract before using untrusted sources.

Persisted prompt text is durable identity evidence, not a cryptographic
capability. A user able to create a hidden thread with a lookalike request can
spoof the marker. Such a thread can affect only its own thread and direct
children, and retrieval still requires its actual parent to be the caller.
The plugin adds no journal or checkpoint store. Protocol version 1 has a
stable request decoder; future request-format changes must add a new version
without changing the v1 decoder.

## Artifact bytes and verification

The result file is `perspectives/results/<coordinator-id>.md` in coordinator
thread storage. Product code defines the body as the exact UTF-8 byte slice
between the first `<!-- perspectives-body:start -->` after the fixed header
and the final `<!-- perspectives-body:end -->` before the fixed footer. Quoted
delimiters inside the synthesis remain body text. It computes a SHA-256 over that slice and
places it in the file's terminal marker. The full-file SHA-256 is returned by
the publish/read tools because embedding it in the same file would change the
bytes being hashed.

Publication uses the BB SDK's atomic create-only file write
(`expectedSha256: null`, mode `0600`) and then reads the file back. It checks
the exact UTF-8 body boundaries, run ID, status, body digest, terminal marker,
host SHA-256, and byte length. An identical existing file is idempotent; a
divergent or corrupt file is never overwritten. The caller tool repeats full
file verification against the coordinator ID before returning the artifact.

## Timing and delivery limits

The 20-minute wrap-up, 25-minute deadline, and 26-minute caller backstop are
scheduling targets, not delivery guarantees. Queue acceptance does not prove
provider acknowledgement. If a scheduled row gets `failureReason` and the
native report is also lost, BB does not guarantee another wake; explicit
queue recovery or operator action is required. A caller backstop may therefore
find a missing artifact. The plugin does not claim eventual delivery,
exactly-once worker creation, or a strict wall-clock deadline.

## Execution settings and evidence

Planner settings apply to the synchronous `help` planner and the gather
coordinator. Worker settings apply to the helper and panel workers. Blank
provider/model settings and `inherit` selectors use the caller's resolved
tuple; configured tuples are validated before gather queues work. The plugin
does not silently escalate a permission mode. A `full` mode is used only when
the caller already has it or the operator explicitly selects it in settings.
Worker instructions are policy guidance; the selected provider permission
mode remains the actual authority envelope.

Experts cite material factual claims from primary evidence they actually
inspected, distinguish supplied context from inference, preserve disagreement,
and identify unknowns. Queue acceptance, spawn responses, worker count, and
native notices do not prove delivery or completion. The coordinator must not
claim eventual delivery, exactly-once execution, guaranteed recovery, complete
coverage, or reliability without direct primary evidence. It does not treat
agreement or worker count as proof. Use the presentation-receipt behavior
below to avoid repeating a result when durable evidence exists; keep internal
worker references out of the caller-facing answer.

The caller tool retains the scheduled backstop. After verifying the artifact,
it finds the latest successful `turn/completed` event, then pages backward
through that turn's `item/completed` events. Suppression requires the turn's
last completed item itself to be an agent message whose text contains an exact
standalone receipt comment with both the run ID and full-file SHA-256; a
receipt in an earlier assistant message followed by another completed item is
not enough. The BB
event API returns stored agent-message text, so the comment remains available
to the check while normal Markdown rendering hides it. The caller should
include the exact receipt line returned by the tool in its final answer after
presenting the result. A missing, mismatched, interrupted, or unreadable final
answer returns the full artifact again. The scan is bounded to five 100-event
pages; if the receipt is outside that window, the tool returns the artifact.
An explicit user request can retrieve it again with `includeArtifact: true`.
Legacy presentations without a receipt may repeat. The caller backstop is
never deleted on read, avoiding a crash window before a durable final answer.
Native duplicate reports and retries can still produce repeated visibility,
so the plugin does not claim exactly-once presentation.

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
