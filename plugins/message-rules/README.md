# Message Rules

A standalone community plugin with an inbox-style rule editor, plain authored
Markdown tests, and one explicit **Test all** action over all enabled saved tests.

**Delivery status:** the editor, file adapter, shared evaluator and suite service
are implemented. Full original all-eligible-sender delivery, safe mixed-original
separation and automatic consumed sender advice remain capability obligations.
The production entry does **not register dispatch hooks** while those obligations
are unproved. Saving a rule does not currently enforce it on normal BB messages.
The isolated native same-sender grouping control succeeds; extending the group to
a different known sender returns HTTP 409. That establishes the native grouping
route's limitation, not exhaustion of every public-plugin alternative.

## Configure

Open **Message Rules** to see the shared global catalog immediately, independently of BB's current project. Group scopes own project restrictions. **+ Group** creates a disabled **Any project** group; add project/thread conditions as needed, save, and deliberately enable it. Project conditions offer case-insensitive partial name/ID completion backed by BB projects; pointer or arrow/Enter selection persists the actual ID. Loading, refresh, failure, empty-list and query-no-match states are distinct, and option refresh never replaces a raw draft. Raw values remain editable. Duplicate names are disambiguated by IDs; unavailable projects remain raw values, never silently replaced. Rule group assignment is searchable by name/ID.

Select a group or child rule to see only that group's tests. Compact group summaries distinguish enabled, passed, failed, errors, disabled, stale, draft and unknown results. **Test all**, below the groups, captures enabled fixtures across all groups and one complete saved catalog. Ownership organizes tests; every fixture evaluates every applicable group/rule. An expected rejection can pass. Historical results never become current merely because another group is selected. Saved pass/fail/unknown counts and frozen group denominators remain visible alongside stale or group/rule/test draft flags. Predicate controls share a text-scaled height. Equality uses a prominent `=` face with readable native menu and accessible selected meaning; underlying `equals`/`contains` values are unchanged.

Use **JEV connection** for the global connection limits and a host/absolute test directory. Existing authored files remain in their original host directories. New tests use the selected group's existing directory when available, otherwise the configured default directory. Only direct `.md` children are discovered. Occurrence reconciliation is scoped to the scanned source, so identical relative names in several host directories retain separate identity, hashes, ownership and enable state. Missing/incomplete discovery retains saved occurrences and blocks a new run until recovery. Switches never rewrite Markdown. Deleted enabled files remain error tombstones; invalid and duplicate-ID files remain in the denominator.

### Migration and compatibility

Storage schema4 adds one global catalog and an immutable `mr_legacy_catalog_backup` of each raw legacy row. Legacy project rows, original configurations, paths, bytes, hashes, enable state, runs/results and paid-attempt records remain in place. Previously project-local groups receive an exact project-ID guard unless already guarded; existing scopes, child predicates, criteria/advice and enable states are retained. Missing legacy group references migrate into disabled import groups. No imported group is broadened or newly enabled.

IDs stay unchanged unless colliding. A deterministic suffix resolves collisions, and the persisted `global-catalog-v1` receipt maps source project, kind and old ID to global ID. Names never determine identity. Legacy `/project/<id>/group|rule|test/<id>` panel links resolve through this map. Colliding legacy expected rule IDs are translated with the frozen source map without editing fixture bytes. New templates use `rule_catalog: global`; adding this field explicitly selects global expected-rule IDs, including cross-source references whose text would otherwise be a legacy alias. Original per-source rule order is preserved when assigning global order. Old source catalog writes are rejected with an explanation directing editing to the global catalog.

Legacy test ownership is recorded in `mr_test_owners`: a unique group referenced by `expected_rules`, otherwise the first legacy group by order/ID. A source without groups gets a disabled Imported tests group. If an empty recorded legacy default is deliberately deleted before later discovery, new files are placed in a visible disabled source-scoped import group. The UI shows this choice, original project, host and directory for every selected test. **Imported tests and compatibility** explains the policy. The searchable **Test group** field and **Move test** action change organization without changing source bytes or evaluation filters. Newly discovered files without an owner appear in a disabled Imported tests group until assigned. This ownership does not limit evaluation. Fixture `project_id`, when supplied, is authoritative; otherwise imported tests keep their source project ID. New files without a known source project have unavailable project identity until explicitly authored; the catalog ID never masquerades as a BB project.

A global run uses one shared call budget (minimum legacy limits on migration), one overall configured time limit, bounded responses and durable attempt reservations. With differing legacy models, the first source by ID supplies the model; original configurations remain preserved. Unknown legacy effects count against the global call limit and unquiesced legacy owners block global work. Plugin/process replacement never automatically replays paid attempts. New explicit runs retain saved bytes/revisions and the immutable denominator, cancellation and lost-ack reconciliation contracts. Start responses and read-only `snapshot` requests with `requestId` include an exact `acknowledgedRun` independently of the latest `run`. Cancellation responses and metadata-only reads with `runId` likewise acknowledge that exact target, so retry A can reconcile A after B completes or discovery becomes unavailable without replacing the current display or invoking new work. An incomplete/cancelled run retains pending fixtures as untested.

The public registry SDK is pinned to **0.6.52**, including a distinct registry
lock entry instead of accidentally resolving the workspace's Phosphor SDK
artifact. The build CLI is exactly `bb-app@0.46.2-nightly.39036585709.1`, whose
SDK is 0.6.52. `@phosphorco/bb-identity@0.2.1` supplies invocation attribution;
catalog data is shared, rather than personal/view-as state.

## Agent authoring

The installed [message-rules skill](skills/message-rules/SKILL.md) documents the global editor and validated CLI workflow. Use `bb plugin rpc list message-rules --json` and `bb plugin rpc inspect message-rules saveRule --json` for current method descriptions and JSON schemas. Read `snapshot` with `{ "projectId": "message-rules-global", "discoverFiles": false }` through `bb plugin rpc call ... --input-file /absolute/request.json --json`. Despite its historical field name, RPC `projectId` is the catalog address, not an evaluation scope. Authorized writes use the current outer catalog revision, complete group/rule values, and exact file hashes/locations. Conflicts require rereading and reconciliation. Discoverability changes no permission or enforcement policy. `startSuite` is explicit potentially paid work; reconcile an uncertain start by reading `snapshot` with the original `requestId` and its exact `acknowledgedRun`.

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
exercise the pure eligible-membership planner when a batch rule applies. Each
original has a unique ID. This is intended membership, **not native delivery**.

## Rules and evaluation

Rules start disabled. Configure title/message predicates (all/any/not,
contains/equals, explicit case handling), then a deterministic reject action,
JEV questions, or intended batch membership. JEV supports independent Score and
Choice questions, explicit criteria, per-question message/history selection,
required coverage, metric reduction and literal configured sender advice.
Image examples are illustrative policy values, not hidden defaults.

The shared evaluator selects applicable rules locally, deduplicates selected
context into shared state and binds every named answer to the exact frozen
rule/criterion/revision/input hash. Questions name their selected references and
coverage; a shared state is not a confidentiality boundary. All mandatory
questions must complete. Unavailable context, malformed answers, timeouts and
incomplete partitions remain unresolved. Score/choice probabilities and
confidence are retained. Choice must name a highest-probability option (ties allowed); Score must agree with the weighted level mean within `0.02 × topLevel + 0.005` for independently rounded fields. Contradictions remain unknown with no final advice. These checks follow the provider [Choice](https://docs.typesafe.ai/primitives/choice#response-structure) and [Score](https://docs.typesafe.ai/primitives/score#response-structure) definitions; v1 reduction uses the configured metric, not an invented
confidence threshold. There is no separate service question-count cap.

Real HTTP transport uses `https://api.typesafe.ai/v1/systemone` with only this
plugin's configured API key (Settings → Plugins → Message Rules). It has explicit
request/response, call and deadline bounds, no ambient credential fallback and
no implicit retry. Only actual configured credential values are masked in errors.
When supplied, a verified counter enforces model per-request and per-question token limits. Otherwise JEV checks context on the server: byte counts are engineering bounds, not exact token counts. Complete questions/evidence are retained and partitioned by wire bounds. Provider context rejection is unresolved and recorded as invoked potential spend, with no implicit retry. A configured explicit Test can run without a local tokenizer. No live inference quality/cost has been measured; deterministic injected verification is not that proof.

## Saved runs, drafts and recovery

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
No fork or service changes are needed. Plugin installation/reload and source publication require their own explicit operator authorization.

## Rule groups and preview rollout

Every rule belongs to a visible group. Edit the group Scope to select project/thread IDs or titles; enable the group independently of child switches. The group gate runs on available routing metadata before child evaluation, history capture or JEV. Outside-scope, disabled or unassigned rules perform no work and cause no effects. Missing scope metadata stays visibly unresolved and performs no work for that group. An empty All conditions predicate matches every project/thread, so prefer exact IDs for a small rollout. New groups default disabled with an empty All conditions predicate (Any project); add explicit scope before deliberately enabling a restricted rollout.

Group edits have their own revisions, conflict protection, draft barriers and frozen suite membership. They stale existing results. Child predicates remain independent. Schema v1 projects migrate with a disabled “Imported rules · scope required” group; earlier immutable runs are retained and never replayed. Schema v3 adds durable attempt context: fixture occurrence/source/basis and exact rule/criterion/revision/input/partition bindings are reserved with the wire request before invocation. Fixture front matter may supply `sender_id`, `destination_id` and `project_title` for scoped tests. Fixture `project_id` supplies explicit project identity; otherwise imported tests retain their source project identity. New global fixtures without it have unavailable project identity. The global catalog address is never used as a BB project.

This slice is explicitly **preview/observe**: editor/testbench only, with no automatic live observer, native dispatch hooks, queue mutation, rejection or sender advice effects. A test rejection describes the fixture result. Active plugin-only install/reload and the first small scope are owner-coordinated; installing does not prove behavioral compatibility or full delivery.

Build output uses the public format-2 manifest: authoritative assets and chunks are under `dist/.bb-artifacts/<generation>/`. The build verifies every declared SHA-256/length and matching app/server SDK/toolchain stamps. Exact copies also populate `dist/app.js`, `dist/app.css` and referenced root chunks because mutable-path runtimes inspect root app freshness. These are generated compatibility assets, not a separate source or deployment. A runtime loader can rebuild the app with its own toolchain; record each artifact’s actual builder stamp and verify its declared assets rather than rewriting stamps to claim identical builds. Never compare only a stale legacy root file to generation metadata.

Suite progress uses metadata-only snapshots. Explicit reads, reconnect and run completion discover files; concurrent discoveries share one promise and read at most eight files at once. Last good inputs and matching read errors survive progress updates until actual discovery succeeds.
