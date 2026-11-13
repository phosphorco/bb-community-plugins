# Message Rules

A standalone community plugin with an inbox-style rule editor, plain authored
Markdown tests, **Test selected** for one saved fixture, and **Test all** over all enabled saved tests.

**Delivery status:** the production factory binds the optional public
`@phosphorco/bb-message-admission@0.1.0-alpha.2` capability and registers its
Message Rules evaluator on compatible hosts. Missing/incompatible hosts retain
the editor and saved-test preview. Saving, migration and Test all never publish or enroll a policy. Installation without a prior exact explicit publication stays inactive. Native enforcement requires an explicit publication
for one testing project through the separate RPC contract below. Source and
injected adapter tests do not establish deployed native enforcement, provider
consumption, mixed-sender delivery or live JEV quality/cost.

The older isolated native same-sender grouping control and cross-sender HTTP409
are historical baseline observations, not proof of the new capability.

## Configure

Open **Message Rules** to see the shared global catalog immediately, independently of BB's current project. Group scopes own project restrictions. **+ Group** creates a disabled **Any project** group; add project/thread conditions as needed, save, and deliberately enable it. Project conditions offer case-insensitive partial name/ID completion backed by BB projects; pointer or arrow/Enter selection persists the actual ID. Loading, refresh, failure, empty-list and query-no-match states are distinct, and option refresh never replaces a raw draft. Raw values remain editable. Duplicate names are disambiguated by IDs; unavailable projects remain raw values, never silently replaced. Rule group assignment is searchable by name/ID.

Select a group or child rule to see only that group's tests. Compact group summaries distinguish enabled, passed, failed, errors, disabled, stale, draft and unknown results. **Test all**, below the groups, captures enabled fixtures across all groups and one complete saved catalog. Ownership organizes tests; every fixture evaluates every applicable group/rule. An expected rejection can pass. Historical results never become current merely because another group is selected. Saved pass/fail/unknown counts and frozen group denominators remain visible alongside stale or group/rule/test draft flags. Predicate controls share a text-scaled height. Equality uses a prominent `=` face with readable native menu and accessible selected meaning; underlying `equals`/`contains` values are unchanged.

**Test selected**, in a saved fixture's results, freezes only that enabled, nonmissing fixture against the current saved basis. Every applicable group still evaluates it. It uses the same durable run, budgets, deadline and cancellation as Test all. Through RPC, pass `selectedOccurrenceIds` (1..100 saved identities, deduplicated) to `startSuite`; omit it for Test all. Selection is immutable under a request ID, including after cancellation or an unknown outcome.

Use **JEV connection** for the global connection limits and a host/absolute test directory. Existing authored files remain in their original host directories. New tests use the selected group's existing directory when available, otherwise the configured default directory. Only direct `.md` children are discovered. Occurrence reconciliation is scoped to the scanned source, so identical relative names in several host directories retain separate identity, hashes, ownership and enable state. Missing/incomplete discovery retains saved occurrences and blocks a new run until recovery. Switches never rewrite Markdown. Deleted enabled files remain error tombstones; invalid and duplicate-ID files remain in the Test all denominator.

### Migration and compatibility

Storage schema4 adds one global catalog and an immutable `mr_legacy_catalog_backup` of each raw legacy row. Legacy project rows, original configurations, paths, bytes, hashes, enable state, runs/results and paid-attempt records remain in place. Previously project-local groups receive an exact project-ID guard unless already guarded; existing scopes, child predicates, criteria/advice and enable states are retained. Missing legacy group references migrate into disabled import groups. No imported group is broadened or newly enabled.

IDs stay unchanged unless colliding. A deterministic suffix resolves collisions, and the persisted `global-catalog-v1` receipt maps source project, kind and old ID to global ID. Names never determine identity. Legacy `/project/<id>/group|rule|test/<id>` panel links resolve through this map. Colliding legacy expected rule IDs are translated with the frozen source map without editing fixture bytes. New templates use `rule_catalog: global`; adding this field explicitly selects global expected-rule IDs, including cross-source references whose text would otherwise be a legacy alias. Original per-source rule order is preserved when assigning global order. Old source catalog writes are rejected with an explanation directing editing to the global catalog.

Legacy test ownership is recorded in `mr_test_owners`: a unique group referenced by `expected_rules`, otherwise the first legacy group by order/ID. A source without groups gets a disabled Imported tests group. If an empty recorded legacy default is deliberately deleted before later discovery, new files are placed in a visible disabled source-scoped import group. The UI shows this choice, original project, host and directory for every selected test. **Imported tests and compatibility** explains the policy. The searchable **Test group** field and **Move test** action change organization without changing source bytes or evaluation filters. Newly discovered files without an owner appear in a disabled Imported tests group until assigned. This ownership does not limit evaluation. Fixture `project_id`, when supplied, is authoritative; otherwise imported tests keep their source project ID. New files without a known source project have unavailable project identity until explicitly authored; the catalog ID never masquerades as a BB project.

A global run uses one shared call budget (minimum legacy limits on migration), one overall configured time limit, bounded responses and durable attempt reservations. With differing legacy models, the first source by ID supplies the model; original configurations remain preserved. Unknown legacy effects count against the global call limit and unquiesced legacy owners block global work. Plugin/process replacement never automatically replays paid attempts. New explicit runs retain saved bytes/revisions and the immutable denominator, cancellation and lost-ack reconciliation contracts. Start responses and read-only `snapshot` requests with `requestId` include an exact `acknowledgedRun` independently of the latest `run`. Cancellation responses and metadata-only reads with `runId` likewise acknowledge that exact target, so retry A can reconcile A after B completes or discovery becomes unavailable without replacing the current display or invoking new work. An incomplete/cancelled run retains pending fixtures as untested.

The public registry SDK is pinned to **0.6.52**, including a distinct registry
lock entry instead of accidentally resolving the workspace's Phosphor SDK
artifact. Build with the prepared canonical workspace compiler (`fork/build/bb/apps/cli/dist/index.js`), or set `BB_TOOLCHAIN_CLI` to the exact prepared compiler entry. CI uses its checksum-verified selected fork compiler through that same variable. A missing compiler fails the build; the registry nightly is not a fallback for generation-based artifacts. `@phosphorco/bb-identity@0.2.1` supplies invocation attribution;
catalog data is shared, rather than personal/view-as state.

## Agent authoring

The installed [message-rules skill](skills/message-rules/SKILL.md) documents the global editor and validated CLI workflow. Use `bb plugin rpc list message-rules --json` and `bb plugin rpc inspect message-rules saveRule --json` for current method descriptions and JSON schemas. Read `snapshot` with `{ "projectId": "message-rules-global", "discoverFiles": false }` through `bb plugin rpc call ... --input-file /absolute/request.json --json`. Despite its historical field name, RPC `projectId` is the catalog address, not an evaluation scope. Authorized writes use the current outer catalog revision, complete group/rule values, and exact file hashes/locations. Conflicts require rereading and reconciliation. Discoverability changes no permission or enforcement policy. `startSuite` is explicit potentially paid work; reconcile an uncertain start by reading `snapshot` with the original `requestId` and its exact `acknowledgedRun`.

## Enforcement status and recent native decisions

The always-visible enforcement banner reads the authoritative Message Rules
publication pointer. **Not enforcing** requires a confirmed pointer with no
enforcing publication. Loading, an unknown pointer, a failed read, or a persisted
publication without confirmed current-generation readiness shows unknown or
unavailable status. A ready enforcing banner names the actual frozen project IDs
(and known names), publication ID, configuration version and evaluator version.
This global authoring panel does not assert that BB's current project is enrolled.
Saving, rule switches, **Test selected**, **Test all** and JEV configuration never
enroll a project or update the frozen publication.

Open **Recent native decisions**, then **Read recent decisions**. **Refresh**
reads the newest page; **More** replaces it with older retained callbacks. There
is no history polling or history read on typing. Errors retain the last successful
page with a stale-page explanation. Expand a callback to inspect source and
destination IDs/names, declared user/machine/agent metadata, original input,
frozen publication and group scopes, native assessments, every cause and all
advice, operation ID, feedback and delivery. Local MR evaluation is separate from
the current native outcome. The banner's latest policy can differ from a
callback's frozen publication. Native acceptance, delivery and verified feedback
consumption are distinct states.

Coverage is **MR evaluator callbacks retained here**, not an exhaustive host audit.
Inputs before an MR callback, missing/deactivated plugins, other providers and
operational exemptions may be absent. Accepted preparations are not rejected
history. No table means no retained callbacks; a read failure is a separate error.
The reader does not initialize/fence the evaluator ledger, recheck operations,
evaluate, send feedback, publish or invoke JEV. Existing table rows are unchanged.

The same read-only path is discoverable through the existing CLI. Method
availability depends on the installed version; source and controlled tests do
not establish a loaded UI or live activation. Inspect it first:

```sh
bb plugin rpc inspect message-rules listRecentDecisions --json
bb plugin rpc call message-rules listRecentDecisions --input-file /absolute/recent-decisions.json --json
```

For the newest page, `/absolute/recent-decisions.json` contains:

```json
{"limit":10}
```

For More, use the returned `nextCursor` verbatim as `before` (example cursor):

```json
{"limit":10,"before":"123"}
```

Cursors are positive SQLite rowid strings, not assessment IDs, operation IDs or
timestamps. The reader uses `rowid < before ORDER BY rowid DESC LIMIT limit+1`,
with `limit` 1..25 (default 10), and at most four concurrent public native
`lookupOperation` calls, one per valid returned callback. There are no full scans.
To debug a known callback/operation from a page, take its `assessmentId`, retain
its `operation.namespace` and `operation.operationId`, and use the same command
with this exact indexed lookup input:

```json
{"limit":1,"assessmentId":"the-retained-assessment-id"}
```

**Read callback detail** performs that exact read in the UI. It uses the frozen
binding's operation key and checks native operation, original revision and request
fingerprint even when large presentation fields were omitted. Never substitute a
local allow/reject result for a missing, malformed, failed or unavailable native
record. Exact lookup requires `limit:1` and no `before`; no match returns an empty
page. For a known publication operation, the separate `lookupTestPublication`
RPC still reconciles its original `{testProjectId,scope:"test-project",requestId}`;
it does not run a new publication. Inspect that method before using it.

Responses are bounded to 512 KiB per page and at most 256 KiB per row (smaller on
multi-row pages). A native record that cannot fit is explicitly unavailable,
without a partial verdict or silently truncated causes/advice; exact callback
lookup provides the larger detail budget or an explicit size refusal. Raw original
JSON has a labeled 8192-character excerpt limit. Frozen journal JSON is bounded
to 1 MiB per selected row. Malformed/older bindings retain row identity and
phase/path diagnostics without invented native identity. Publication policy bytes
and connection configuration are excluded, including from malformed-JSON error
fragments; useful nonsecret original/source/feedback/delivery diagnostics remain.

## Author tests

```markdown
---
version: 1
id: progress-only-update
sender_title: "#execution-steward"
destination_title: "#outcome-owner"
expect: reject
expected_rules: [avoid-status-pings]
---

# Message
Still working on it. I'll send another update soon.

# Sender context
The owner requested a completed result or a blocker.

# Destination context
The owner is waiting for a decision-ready report.

# Expected advice
Send a blocker, a decision request, or a completed result.
```

Top-level recognized headings delimit sections; fenced and nested headings remain
literal message data. YAML keys/IDs and repeated sections are validated. Files
are limited to 256 KiB. `expect` is allow/reject/unknown, but an unresolved check
never becomes a passing assertion, even for expected unknown. `expected_rules`
is optional and, when present, is the exact rejecting-ID set. Unknown IDs fail.
Absent expected advice means no advice assertion; an empty section asserts none.
Separate several expected advice items with a line containing `---`.

Advice comparison normalizes CRLF and Unicode NFC and removes at most one final
newline; other whitespace, case and punctuation remain significant. The ordered
advice list must match exactly. Identical advice is presented once with all its
rule bindings. Expected rejection can pass.

Optional `expected_batch: [update-one, update-two]` and a `# Queued messages`
section containing a fenced YAML list of `{id, senderId, eligible, reason?}`
exercise the pure eligible-membership planner when a Queue batched rule applies. Optional `expected_route: proceed|steer|queue|queue-batched` asserts the resolved routing preference independently of acceptance. Each
original has a unique ID. This is intended membership, **not native delivery**.

## Rules and evaluation

Rules start disabled. Configure title/message predicates (all/any/not,
contains/equals, explicit case handling), then one action: Reject, Proceed, Steer, Queue or Queue batched. JEV is an optional configured check for any action; it is not a sixth action. Proceed preserves the requested mode and time; conflicting explicit route preferences stay unresolved. Queue batched targets the next open ordinary queued delivery; intervening scheduled messages retain their own time and remain separate. JEV supports independent Score and
Choice questions, explicit criteria, per-question message/history selection,
required coverage, metric reduction and literal configured sender advice.
Image examples are illustrative policy values, not hidden defaults.

The shared evaluator selects applicable rules locally, deduplicates selected
context into shared state and binds every named answer to the exact frozen
rule/criterion/revision/input hash. Questions name their selected references and
coverage; a shared state is not a confidentiality boundary. All mandatory
questions must complete. Unavailable context, malformed answers, timeouts and
incomplete partitions remain unresolved. Score/choice probabilities and
confidence are retained. Choice must name a highest-probability option (ties allowed); Score must agree with the weighted level mean within `0.02 × topLevel + 0.005` for independently rounded fields. Contradictions remain unknown. Known causes and advice from other checks remain visible; they do not turn incomplete evaluation into a final rejection. Independent remaining partitions still run within the original budget, without retrying failed work. These checks follow the provider [Choice](https://docs.typesafe.ai/primitives/choice#response-structure) and [Score](https://docs.typesafe.ai/primitives/score#response-structure) definitions; v1 reduction uses the configured metric, not an invented
confidence threshold. There is no separate service question-count cap.

Real HTTP transport uses `https://api.typesafe.ai/v1/systemone` with only this
explicit connection selection. The default is the Topics-owned shared JEV service through `@phosphorco/bb-jev`; its key remains in Topics settings and no Topics assessment policy or automatic scope is enabled by shared work. An optional dedicated MR key is used only when `dedicated` is selected in Settings → Plugins → Message Rules. The UI reports the selected owner and availability; missing/disabled/invalid connections never trigger a credential scan or another source. It has explicit
request/response, call and deadline bounds, no ambient credential fallback and
no implicit retry. Only actual configured credential values are masked in errors.
When supplied, a verified counter enforces model per-request and per-question token limits. Otherwise JEV checks context on the server: byte counts are engineering bounds, not exact token counts. Complete questions/evidence are retained and partitioned by wire bounds. Provider context rejection is unresolved and recorded as invoked potential spend, with no implicit retry. A configured explicit Test can run without a local tokenizer. No live inference quality/cost has been measured; deterministic injected verification is not that proof.

## Saved runs, drafts and recovery

Captured evaluator version `message-rules-v1.7` adds native placement assertions and advances saved-result staleness. The preceding v1.6 added five actions with separate JEV predicates, route-conflict detection and complete known-cause/advice collection. Legacy `jev` actions project to Reject with JEV checks; legacy `batch` projects to Queue batched. Authored scopes, enables and revisions are preserved. Frozen runs retain their original rule values/results. Earlier saved runs remain immutable historical evidence and appear
stale even with unchanged catalog/fixture inputs; they are never automatically
re-evaluated or replayed. Fixture format and storage schema are unchanged.

Test freezes exact enabled occurrence membership, source bytes/hashes, rules,
configuration and versions before acknowledgement. The absolute global deadline is checked before every partition permit as well as between fixtures. Invalid/missing enabled files
count as error results. Disabled files are excluded. The visible total belongs
to that captured run, even if files or switches change during execution. Current
saved inputs with another fingerprint mark the result stale; a visible draft is
separate from saved results. Returning to identical file bytes can restore the
same file fingerprint; rule saves still advance their revision.

Relevant drafts in the requesting browser must be saved/discarded first: edits to
an enabled test, an enabled rule or an unsaved rule-enable change gate Test.
Disabled tests/rules without enable changes do not. Another browser's private
drafts do not create a global lock; the server validates saved input identity.
Drafts survive panel selection/back/forward in this browser session, not a full
browser reload. Other clients can edit saved inputs and cause a conflict.

One active run owns each suite. A repeated request ID with the same saved basis
returns its recorded run; changed inputs conflict. Reservation and possible-effect
markers commit before transport initiation. Unknown invoked effects retain their
reservation, stop scheduling and are never automatically replayed. Cancellation
is persisted first; abort does not prove remote cancellation. After local workers
join, an explicit new Test creates a new run and retains prior unknown exposure
against the configured call limit. No fabricated dollar budget is displayed.

A fresh process transactionally fences interrupted owners. Runs with no acquired
invocation permit release their slot; old owners cannot acquire a permit or append
results afterward. Runs with any acquired invocation retain ownership unknown and
the slot until positive quiescence evidence exists. The production UI has no unsafe “assume stopped” button. This fail-closed
recovery can require operator investigation; no remote exactly-once claim is made.
Unsupported stored/captured versions stop without reinterpretation. Tests cover a
real suspended child process, not just database reopening.

File saves carry the loaded host, directory and location epoch, validate them
before entering and leaving the serialized write queue, and use the public
expected-SHA guard. A location change and return still invalidate an older editor.
On lost acknowledgement the adapter rereads exact bytes: identical intended bytes
confirm success; otherwise the draft is retained with conflict/unknown information.
Acknowledging submitted A preserves newer edit B and rebases its saved hash/revision.
The UI confirms a lost acknowledgement only against that exact project, target,
payload and location; it never automatically replays writes.
An arbitrary external editor can race the host's hash check and replacement.
This is not atomic filesystem CAS. Automatic read recovery clears only matching
read failures, including unchanged content; unrelated success never clears a
failed save or unknown operation.

## Verification and capability drivers

From the community repository run `npm ci`, `npm run test`, `npm run typecheck`
and `npm run build`. The leaf package also has focused `oracle:*` commands.
Missing substantive suites fail closed. `test/contracts/witnesses.test.ts`
calibrates known defective references; actual adapter suites provide distinct
implementation evidence. No `oracle:*` name alone establishes full runtime proof.

`test/capability/fixture` is an inert public-SDK native probe plugin, not the
production entry. It holds its own provider's dispatches and has no inference
transport. Install/build it only in task-owned isolated state. It is excluded
from the published file list. Live provider and JEV accounts are unnecessary.

Receipt signing/outbox and whole-group admission modules are separately tested
contracts/adapters. They are not wired as production enforcement, and an accepted
queue acknowledgement is not proof an agent consumed advice. Mixed groups wait
without collateral terminal rejection. Native explicit Send-now is a policy
exception accessible through the SDK; other plugins' holds/rejections still apply.
The optional capability requires a native host that implements the published protocol. This plugin does not patch, restart or deploy that host.

## Rule groups and preview rollout

Every rule belongs to a visible group. Edit the group Scope to select project/thread IDs or titles; enable the group independently of child switches. The group gate runs on available routing metadata before child evaluation, history capture or JEV. Outside-scope, disabled or unassigned rules perform no work and cause no effects. Missing scope metadata stays visibly unresolved and performs no work for that group. An empty All conditions predicate matches every project/thread, so prefer exact IDs for a small rollout. New groups default disabled with an empty All conditions predicate (Any project); add explicit scope before deliberately enabling a restricted rollout.

Group edits have their own revisions, conflict protection, draft barriers and frozen suite membership. They stale existing results. Child predicates remain independent. Schema v1 projects migrate with a disabled “Imported rules · scope required” group; earlier immutable runs are retained and never replayed. Schema v3 adds durable attempt context: fixture occurrence/source/basis and exact rule/criterion/revision/input/partition bindings are reserved with the wire request before invocation. Fixture front matter may supply `sender_id`, `destination_id` and `project_title` for scoped tests. Fixture `project_id` supplies explicit project identity; otherwise imported tests retain their source project identity. New global fixtures without it have unavailable project identity. The global catalog address is never used as a BB project.

On absent/incompatible hosts this remains **preview/observe**. There are no fallback dispatch hooks, text-prefix sends or plugin-owned queue mutation. A saved test rejection describes only that fixture. The compatible capability path registers an admission evaluator; initial active enrollment remains explicit and testing-project scoped. Installing does not prove native behavior or full delivery.

Build output uses the public format-2 manifest: authoritative assets and chunks are under `dist/.bb-artifacts/<generation>/`. The build verifies every declared SHA-256/length and matching app/server SDK/toolchain stamps. Exact copies also populate `dist/app.js`, `dist/app.css` and referenced root chunks because mutable-path runtimes inspect root app freshness. These are generated compatibility assets, not a separate source or deployment. A runtime loader can rebuild the app with its own toolchain; record each artifact’s actual builder stamp and verify its declared assets rather than rewriting stamps to claim identical builds. Never compare only a stale legacy root file to generation metadata.

Suite progress uses metadata-only snapshots. Explicit reads, reconnect and run completion discover files; concurrent discoveries share one promise and read at most eight files at once. Last good inputs and matching read errors survive progress updates until actual discovery succeeds.

## Native admission and explicit testing-project publication

`admission-rpc-contract.ts` exposes `testAdmissionState`, `publishTestPolicy`,
`deactivateTestPolicy` and `lookupTestPublication` through the same bb-identity
invocation binding as authoring. Inspect their installed public schemas before
an authorized call. These methods are separate from saved authoring/Test all.
Every request names `testProjectId` and literal `scope: "test-project"`.
Publication/deactivation also require the saved catalog `basis`, a stable
`requestId`, and `expectedActivePublication` read from native state (null for a
pristine host). Only that exact project can be enrolled; replacing/deactivating
a publication containing another project is rejected. Normal/global rollout is
outside this RPC contract. Native validation still owns actual project admission.

The plugin freezes exact canonical rules/groups/connection bytes for publication.
Native owns the active pointer and CAS. The banner reads that authoritative
publication ID, version and project scope; saved edits remain separate. An
unavailable read reports uncertainty and retains the last confirmed publication.
The next successful read automatically clears that read failure. No read or
reconnect automatically replays a publication. After an uncertain response,
`lookupTestPublication` with the original request ID reconciles the same native
operation. Repeating that publication request performs lookup, even if the saved
catalog has since changed; it cannot publish newly fetched mutable bytes.

The production callback consumes the **exact native-published snapshot**, typed
native `policyContext` and candidate-bound bounded `captureEvidence`. It never
reads the mutable catalog mid-evaluation. Cheap group scope runs first; matching
JEV rules share the planner/evidence, independent named questions and configured
budgets. Evidence tokens bind the exact original, operation, assessment, routing
metadata and history windows. The callback returns every known rejection cause
and advice; incomplete checks or route conflicts dominate the final verdict.
A known matching ANY criterion retains its cause/advice even when another
mandatory criterion is missing; the rule and final verdict remain unresolved.
An ALL rule does not invent a matching cause from an incomplete set.
Proceed returns preserve/preserve; Steer selects steer-if-active; Queue selects
defer/separate; Queue batched selects defer/join-next-ordinary. Native retains
requested schedule/execution intent and owns final placement/acceptance.

On an already-enrolled host, one activated background-service start may recover
that exact prior explicit publication. Registration/factory staging alone does
not recover it. Native pointer reads show persisted intent, while
`generationReady` requires a successful publication receipt bound to the current
registration. Before recovery, the adapter finds the original durable publish
input, verifies its single-project enrollment, immutable bytes/version/fingerprint
against the active native publication, and reconciles that operation to native
accepted publication. It rereads the pointer, then calls native publish once with
that **exact original successful operation and input**, including the original CAS
reference. Native successful-operation dedup rebinds current generation. This is
not a new enrollment, changed saved policy or a new operation. No saved catalog
read supplies recovery bytes.

Missing/unproved input, incompatible evaluator version, changed/newer pointer or
unknown lookup leaves generation readiness unconfirmed. A per-generation durable
metadata marker precedes the rebind call; a lost rebind response remains unknown
and is never blindly retried by service restart. Final pointer/receipt checks
fence replacement races. The one lifecycle owner waits for abort without a
poller/timer, emits a realtime state update after recovery, and cannot recover
before actual background activation. The banner distinguishes persisted policy
from confirmed current-generation readiness. Explicit fresh publication remains
the only way to select newly saved policy or a new testing-project scope.

`mr_admissions` and `mr_admission_attempts` own per-assessment invocation permits,
separate from saved suites. Exact duplicate active callbacks share one promise;
other admissions do not take the suite's single global lock. Cancellation,
plugin replacement, deadlines and restart fence late results. Possible paid
work stays recorded unknown and is never automatically replayed. An unexpected
duplicate callback cannot reuse another callback's evidence tokens as fresh
finality: it returns unresolved with the recorded diagnosis and requires native
assessment reconciliation, without another paid invocation. Native owns
accepted-revision semantic freezing and wake/retry behavior. The plugin does not
re-evaluate accepted originals on a timer. Its publication journal records exact
submitted bytes and response uncertainty, never a feature-owned active pointer.

Only an exact **native-derived** feedback obligation binding for Message Rules
and this recipient self-exempts that feedback original from Message Rules.
Ordinary neighbors and other policy providers remain evaluated. Raw input and
native event data stay opaque for preservation; policy text uses declared
`policyContext.messageText` and event `text`, with no content sniffing or sender
null/text-based exemptions.

Tests in `test/admission/native-factory.test.ts` exercise the production factory,
registry SDK public harness, capability binding and actual RPC handlers against
controlled public host ports. They demonstrate adapter behavior and fault
handling, not native transactions, live activation or provider execution. The
separate real native canary/registry artifact/inference/restart/advice-consumption
checks remain necessary evidence at integration.


### Saved native placement assertions

Existing `expected_batch` / `# Queued messages` assertions retain their legacy
intended-membership meaning. Historical observations are never reinterpreted as
native proof. New fixtures may add a **# Native placement** section containing
fenced JSON with two fields: `input` is the exact public protocol
`PreviewPlacementInputV1`, and `expect` contains required `status`, nullable
`targetGroupId`, ordered `orderedOriginalIds`, and optional exact `reasonCodes`.
See [native-placement-q-a-s-b.md](fixtures/native-placement-q-a-s-b.md) for a full
Q(A),scheduled S(T),B fixture with distinct sender originals. Fixture data is
synthetic simulation data, not a live accepted original or commit ticket.

The candidate's message and routing metadata must match `# Message` and the
fixture's project/sender/destination IDs and titles; use explicit front matter
where needed. The evaluated Message Rules route is applied to a copied candidate
before simulation: Proceed preserves intent, Steer changes only mode, Queue
selects queue/separate, and Queue batched selects queue/join-next-ordinary.
Schedule, execution choices, original/source identities, queued members and
witnesses remain exactly authored. The public submission fingerprint is computed
for that effective simulation candidate. Use `expected_route` as a separate
assertion when testing a particular policy action.

After resolved content admission, the saved-suite runner calls the bound public
`previewPlacement` only. The native implementation owns its selector; Message
Rules contains no copied selector or local fallback. Native `simulation:true`
results, reasons and the exact input hash are retained in the immutable saved
result's `nativePlacement` observation, visible in existing Observations. Status,
exact target, ordered originals and optional reason codes must match; mismatches
fail. A missing host/optional capability, unavailable response, cancellation or
unresolved content yields an unknown native assertion. Ordinary fixtures without
this section still run their content checks. No fixture simulation publishes,
enrolls, inserts queue items, captures live history or sends messages.

Controlled actual-factory/public-port tests cover Q(A),S(T),B, a closed generic
target, a promised target that closed, an explicit divider, incompatible choices,
and both unknown legacy candidate/target timing. Their scripted public-port
responses prove adapter plumbing and assertion behavior only. The separate real
native-selector proof is an integration responsibility; these tests do not prove
native transactions or delivery. Captured v1.6 intended-batch results stay
byte-identical and become stale under v1.7 without replay.

Shared transport retains the existing MR admission/suite paid-attempt UUID, partition/input binding and absolute deadline. Topics persists one HTTP operation before invocation and exposes bounded response/usage/status; lost acknowledgements get one lookup and no submit retry. MR keeps semantic decoding, native evaluation ledgers and policy combination. Transport receipts identify their actual connection source; missing or unreported token/cost fields remain unknown. Package/source checks do not prove loaded cross-plugin or real-provider behavior.
