# v0.1 implementation and operation

Subscribe to Anything runs alongside Background Jobs. It replaces recurring
observation prompts and reminders, while Background Jobs retains detached tasks
and services. Existing jobs and timers are not migrated.

## What runs

`server.ts` registers tools, CLI, settings and one supervisor through the public
SDK. `engine.ts` owns state transitions. `store.ts` persists obligations, bounded
recent evidence and a separate finding outbox in the plugin's SQLite database.
`collector.ts` owns a durable task mailbox and a provider-launched worker;
`mailbox.ts` supplies its bounded connection client;
`runner.ts` collects evidence inside that worker. `classifier.ts` evaluates
exact JSON scalar predicates or optionally calls Jev. The observer prepares
recipes and reviews every candidate finding and collection/classification error.

The service accepts and persists before launching an observer. Observer threads
are hidden, lifecycle-owned roots, without ordinary parent completion reports.
Only this service sends findings to the entry thread. Observer operations verify
the persisted assignment, invoking thread, project and lifecycle ownership.
An observer that starts before its spawn response can bind itself using its exact
first persisted request and the preexisting launch intent.

The four public tools are `subscription_until`, `subscription_changes`,
`subscription_inspect` and `subscription_cancel`. Inspect without an ID lists
bounded summaries. Debug inspection exposes the executor only for troubleshooting.
Creation returns a durable subscription ID; launch uncertainty belongs to that
record rather than a separate recovery reference. Repeating identical requests
creates separate obligations. A lost creation receipt can be investigated with
inspection's list form; it is not automatically deduplicated.

## Native timing

After and interval use durable acceptance timestamps. Intervals coalesce missed
boundaries and report the missed count. Queue delivery maps to BB's
`queue-if-active`; explicit steer maps to `steer-if-active`.

Idle is explicitly `activity: "visible_input"`: time since a persisted visible
input without an agent-thread sender or system-message marker. This is not a
claim that the agent has stopped working, nor proof of the author's human
identity. Subscription notifications are agent-only and cannot reset this clock.
Idle initially starts at subscription acceptance; subsequent inputs rearm it.
Per-episode and during-idle repetition, plus maximum-wait branches, are supported.
The supervisor catches up event pages before making an idle determination.

```bash
bb subscribe until '{"trigger":{"kind":"after","seconds":600},"message":"Ten minutes have passed."}'
bb subscribe changes '{"trigger":{"kind":"interval","seconds":600},"message":"Periodic reminder."}'
bb subscribe list
bb subscribe inspect sub_ID
bb subscribe cancel sub_ID
```

Creation CLI requests use the same validation as agent tools. No observer ID is
needed. Archive/delete terminates owned work; unarchive does not reopen it.

## Recipes and evidence

Observer tools are context, install, wait, report and fail. Setup receives public
endpoint examples and capability limits. Material ambiguity closes with a precise
clarification request; the caller submits a clarified subscription. Each turn has
15 minutes to submit a disposition. One subscription permits five recipe revisions
and twenty observer turns, including setup and review; ongoing changes are still
subject to those limits.

A recipe has `script`, `parameters`, `interpretation`, `coverage`,
`interval_seconds` (30–86400), `timeout_seconds` (1–120), `history_count` (0–4),
and `evaluation`. Evaluation is `json_equals` with a path and scalar value,
`json_changes` with a scalar path, or `semantic`. Conditions requiring arithmetic
can project exact computed facts in Bash/jq before selecting a scalar predicate.
The setup agent remains responsible for preserving the requested semantics.

The observer reuses the parent's exact BB environment, provider and permission
mode. Installing a recipe returns `collector_command`; the observer launches it
through its **normal provider shell tool** in a provider-supported continuing
session, then ends its turn. Run the returned foreground command with short yield
and session retention, or the provider native managed-background facility. Keep
the owning shell/session alive without polling it. `nohup` followed by shell exit
does not establish survival inside provider tool containers; do not use that
launch shape. A printed PID and exit zero alone are not a collector receipt. The worker retains that process's cwd, HOME, PATH, existing CLI credentials
and OS sandbox. The server never executes recipes locally or uses an SDK terminal
as a fallback. Missing environments, permission mismatches, unavailable tools and
launch denial produce actionable failure or bounded observer repair. They never
authorize escalation. Node, `/bin/bash`, `/bin/sleep`, and the installed `bb` CLI
must be available inside the provider's allowed execution environment.

Observation scope, no remote mutation, credential redaction and history-file
immutability are **trusted delegation instructions**, not an additional read-only
security sandbox. Existing authenticated `gh`, local jobs/logs and `bb` read
commands can be used within the assigned observation. Credentials must never be
embedded in recipes, parameters, logs or evidence. Provenance in sealed runs names
the verified BB assignment environment/host/observer/permission mode; it is not
remote hardware attestation or a guarantee about every provider's credential path.
Provider approvals and restrictions still govern the actual launch. A provider
that kills background children after its tool/turn ends needs an actionable
failure; this implementation cannot bypass that restriction.

The server persists one current task identity and monotonic sequence per
subscription/generation. Sequence numbers upgrade retained pre-sequence tasks
without changing their identity. The worker retains only its highest sequence
and task ID: delayed older replies cannot replay work or abort newer work; a
conflicting ID at the same sequence stops the worker. A
random generation token and one worker identity bind claims and results to that
assignment. The worker executes its fixed installed recipe and never reruns the
same task after a lost receipt. Duplicate identical reports are idempotent;
changed, out-of-order, cancelled, expired and stale-generation results are rejected.
Tokens are omitted from tool launch arguments, observer context, ordinary/debug
inspection and UI diagnostics. They are visible to same-user process inspection
in the Node/CLI argv and are stored in the private plugin database: this is a
trusted local boundary, not protection from a hostile same-user process.

Each check uses private scratch, an output file and bounded copied history. A
Bash watchdog explicitly kills the complete process group at the recipe deadline,
even if the Node worker dies. Foreground completion kills the group before output
is read and sealed. Scripts must not escape the process group or create services;
session-escaping descendants are outside this trusted cleanup guarantee. A
SIGKILLed worker can leave private scratch until host temporary-file cleanup.
CPU/file-size and capture limits remain bounded; no adversarial aggregate memory
accounting or extra filesystem sandbox is claimed. Evidence caps at128KiB, combined
logs cap at128KiB, and retained log excerpts are16k characters per stream. Empty,
replaced, oversized, timed-out or nonzero output always returns for review.

The worker uses a20-second authenticated mailbox long poll. On the reviewed
stock CLI build, `mailbox.ts` posts the exact CLI JSON request (argv, actual cwd,
trimmed and validated caller IDs) to the same existing Plugin CLI endpoint.
Normal server admission and assignment checks remain in place. Native eligibility
requires an explicit canonical plain HTTP loopback root URL, no custom Node,
proxy or TLS settings, and the exact reviewed SHA256 aggregate of the installed
CLI entry and its50JavaScript chunks. Its env-node interpreter must resolve to
the worker's Node. CLI upgrades, unknown/custom wrappers, unsupported connections
and `BB_SUBSCRIBE_TRANSPORT=cli` retain CLI compatibility and its resident cost.
Relative/bare BB_CLI overrides retain CLI because its re-exec rules differ from
PATH lookup. Slash-containing paths resolve from the actual cwd; absent/empty PATH
refuses native optimization. The fingerprint identifies supported bytes, not
protection against a hostile same-user process changing files after selection.

Transport is fixed before the first request and never changes after an ambiguous
effect. Native responses accept newline keepalives followed by one bounded JSON
envelope, enforce HTTP/envelope/output limits, and use25s poll/10s other deadlines.
Shutdown aborts outstanding requests/CLI children; the final stopped receipt is
separately bounded. A lost result receipt retries only the same sealed payload,
within a15-second retry window plus one bounded10-second request/backoff, even if a concurrent poll sees the already sealed task as
absent. It never reexecutes the recipe to obtain another payload.

Private in-process hints wake assignment/result waits, registered before the
SQLite read and followed by an authoritative reread. Heartbeat-only saves emit
neither private hints nor public UI invalidations. Mailboxes reconcile independent
writers every5seconds, renew heartbeat on each20-second poll, and release bounded
listeners/timers on response, abort, errors and plugin disposal. Waiting runs
reconcile every1second. Reload loses hints but retains authoritative records and
the existing current-task recovery rules. The ordinary supervisor still scans
active records; retained sealed result snapshots have not been compacted.

A missing heartbeat after30seconds, or an overdue task, returns to review.
Loss of mailbox connectivity stops the worker after bounded retries; local script
deadlines remain independent of the connection. Cancellation revokes the generation
durably and a local hint usually releases the poll immediately; an independent
writer reconciles within5seconds. An offline script may run until its independent
recipe deadline. `stopped_at` confirms the worker's cleanup path, while observer
stop acknowledgement alone does not prove process shutdown.

Five recent sealed runs are retained. Repair resets baseline/history and revokes
the previous generation; sampling gaps remain visible. Interrupted collection
cannot authorize reporting an older pending run. Recovery may retain a result
already sealed for the current task, and otherwise requires fresh collection or
repair before reporting. Existing observation recipes without a worker return to
their observer for reinstall/launch without changing their original request;
native timers require no worker and keep their stored scheduling semantics.

## Jev

Exact predicates and native timers work without Jev. Semantic classification is
experimental and disabled by default. Configure `jevApiKey` (a secret setting)
or the server's `TYPESAFE_API_KEY`, select `jevModel`, then enable
`semanticEnabled` after evaluating your conditions. The default model pin is
`jev-1.14.0`; no live model benchmark has established this workload's accuracy.

The **whole serialized request** is limited to 20,000 UTF-8 bytes, including
criteria, history, evidence and timing. This is a conservative byte budget, not a
verified token count for Jev. Over-budget input goes to the observer for command
repair. Context reads provide bounded samples and explicit paging of retained
outputs. No Jev call sees silently truncated evidence.

Only usable, confident pending results (threshold 0.99) stay quiet. Everything
else goes to the observer. API/shape failures are never pending. Semantic changes
require a reviewed initial baseline. Confidence is not truth; missed matches on
the quiet path require labeled evaluation before broad use.

## Recovery and delivery

Collectors are bounded and cancellation invalidates their generation. The
supervisor permits four concurrent checks. Slow checks do not hold the ordinary
scheduling sweep; timing remains a best-effort target under host load/offline time.
Cancellation, terminal expiry and reporting preserve pending observer shutdown so
failed stop requests can be retried. A stop acknowledgement is not a human receipt.

An interrupted collection returns to review. An interrupted launch remains
uncertain and is not blindly repeated. A committed observer can authenticate its
assignment and continue. If it never runs again, inspection and cancellation remain
available; there is no claim of guaranteed automatic recovery of ambiguous spawn.

Findings are committed before delivery. `accepted` means BB acknowledged sending
or queuing; it does not mean the provider or person saw the message. Interrupted
or ambiguous sends are marked `uncertain` and not replayed. Identifiable BB queue rows are withdrawn on cancellation where possible;
already-dispatched messages cannot be recalled. This intentionally favors explicit uncertainty over
unbounded duplicates; it is not exactly-once or guaranteed at-least-once delivery.
Expiry has a hard cutoff: a candidate reviewed after expiry cannot publish.

## Verification scope

The test suite exercises the actual engine and SQLite store, cancellation races,
changes, quiet pending checks, timers, review/repair limits, exact classifier
routing, byte-budget enforcement, and SDK tool registration/authorization. A
separate process writes real state then exits without cleanup; a new engine
recovers it. This proves the plugin's persistence seam, not a live BB server
crash during its own queue commit.

`test/runner.test.ts` exercises real Bash capture, inherited cwd/environment,
nonzero diagnostics, output failures, cancellation and descendant cleanup. Its
SIGKILL regression proves the independent group watchdog without namespace skips.
`test/collector.test.ts` exercises actual mailbox/engine/classifier persistence,
quiet repeated exact checks, repair, stale/duplicate results, expiry, cancellation,
missing launch, recovery eligibility and native timers under collector load.
SDK tests verify reused environment/provider/permission mode and reject changed
assignments; these assertions do not prove every real provider's sandbox.

`test/worker.test.ts` launches the serialized product worker/runner through the
installed stock BB CLI identity and native/CLI compatibility transports against a loopback SDK fixture. It proves inherited
alternate cwd/HOME and synthetic authenticated CLI access without the server-only
fixture environment, long-poll behavior and revocation. After a plugin build, run
`SUBSCRIPTION_BUILT_PROOF=1 node --test --experimental-strip-types test/worker.test.ts`
from the plugin directory to exercise source emitted by the **built server entry**;
this covers minifier closure dependencies missed by source-only serialization.

On this reviewed host, `SUBSCRIPTION_REQUIRE_NATIVE=1 npm run test` passes52Node
tests (zero skips) and3React tests. Ordinary CI explicitly skips only the installed
stock native integration when that reviewed build is unavailable; portable HTTP
wire and CLI fallback tests still run. The same required flag with
`SUBSCRIPTION_BUILT_PROOF=1` proves actual native built serialization with zero CLI
discoveries; a separate `BB_SUBSCRIBE_TRANSPORT=cli` built proof verifies compatibility.
`test/mailbox.test.ts` covers native request context/framing, bounds, errors,
abort, custom wrappers including relative-path shadowing, unsupported settings
and fixed transport after an ambiguous effect. `test/replay.test.ts` covers lost
sealed-result receipt, delayed older sequence during newer work, conflicting
same-sequence IDs and withdrawal before submission. Notification tests include
pre-wait hints, heartbeat silence, abort/dispose cleanup, independent-writer
reconciliation and retained-task sequence upgrade.

The original accepted fixture measured roughly148MiB summed worker+CLI RSS;
that historical number is not incremental memory or a capacity claim. The memory
follow-on uses identical frozen0/1/3-observation harness phases with RSS, PSS,
private memory, complete-read coverage and separate fixture-server attribution.
No capacity claim follows from multiplying process RSS. Timers allocate no worker
or CLI. Live provider context, reload, UI and whole-repository proof belong to the
steward's evidence report. No live Jev accuracy benchmark or full BB service crash
is established by these fixtures.

### Recorded validation, 2026-10-31

- `npm ci` succeeded. Plugin typecheck and build succeeded.
- 32 plugin tests: 26 passed in the restricted test environment; the six
  namespace-dependent tests passed separately on the real execution host.
- Live install, create/inspect/cancel, plugin reload and public HTTPS observation
  succeeded. The live observation used one setup turn and one evidence-review
  turn; pending monitoring did not require an entry-agent turn.
- Repository typecheck/build succeeded. Repository tests retain unrelated failures
  in Agentation's icon receipt and two existing turn-result plugin icons. The
  packaging test's read-only npm-cache failure passed with a writable cache.
- The successful smoke finding was accepted into BB’s queue, then withdrawn
  through cancellation; its delivery state is `cancelled` and observer shutdown
  is no longer pending. Final plugin status is running.
- The workspace composition check reports preexisting gitlink drift across all
  three child repositories. No gitlinks were advanced or authored work discarded.
- No live Jev inference, accuracy benchmark or full BB service restart was run.


## Subscription management UI

The **Watch & reminder subscriptions** navigation page uses BB's `navPanel` surface (with native deep-link/back-forward routes). The **Watch & reminder subscriptions** thread panel uses `threadPanelAction`, flush layout. Both mount the same `SubscriptionSurface`, list, detail and diagnostics components. The thread panel scopes every read and cancellation to its owner thread; the page is a trusted-workspace view across owners, like Background Work. No personal state or new identity policy is introduced.

- Lists are paginated at 50 records with server-side active/history, state, project and literal subject/ID search. Owner titles resolve once per distinct owner per visible page, with bounded concurrency. There is no host thread scan. Project choices are capped at 100.
- Durable record changes emit coalesced realtime invalidations. Mounted views use TanStack Query, pause reads while hidden, retry failed reads at a bounded rate, refresh after reconnect, and retain last-good content. Healthy views have no polling timer or per-row clock. Times are absolute local timestamps.
- Detail includes at most five retained checks, bounded output previews and execution logs, declared coverage, recorded classifications, up to 100 findings and delivery receipts. The engine currently retains checks for the current recipe; this UI does not invent complete historical coverage, Jev confidence, or a proven first remote observation. `Accepted by BB` is not a claim of human delivery or reading.
- Observer IDs and collector/revision scripts are loaded only when Advanced diagnostics opens. No direct observer messaging control is provided. Output is rendered literally, without interpreting HTML or instructions.
- Cancellation is confirmed inline and binds the displayed owner and generation. A stale generation is rejected. Writes are never replayed automatically after a transport error. Already dispatched messages cannot be recalled.
- Native BB theme tokens and established shadcn-derived Button/Input primitives are used. Compact layouts reuse the same components and preserve labelled controls; terminal subscriptions do not show a future check.

Validation: focused SDK RPC tests cover paging, scope, stale cancellation and invalidation; mounted component tests cover shared surfaces, lazy diagnostics, read failure/reconnect recovery, uncertain writes and stale-response teardown. A Chromium SDK-slot harness exercises the actual components at 1440px and 390px, dark/light/custom palettes, cancel confirmation and idle RPC counts. This harness supplies sample data and host theme variables; it is not proof of a user's desktop chrome. Live plugin reload and read-only RPC probes separately verify registration and real persisted subscriptions.
