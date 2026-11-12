---
name: message-rules
description: Author and inspect the global Message Rules catalog, optional group scopes, Markdown fixtures and saved Test all results through the editor or validated public RPC.
---

Open `/plugins/message-rules/rules`. There is one shared global catalog, with
no project picker. Group scopes select optional project/thread restrictions.
New groups and rules start disabled; deliberately scope, save and enable them.
Project-name/ID completion stores stable IDs. Test ownership organizes the list;
every enabled fixture evaluates all applicable groups, including other owners.

## Agent authoring through public RPC

Inspect the installed contract before authoring:

```sh
bb plugin rpc list message-rules --json
bb plugin rpc inspect message-rules saveRule --json
```

Read saved state without scanning fixture directories:

```sh
bb plugin rpc call message-rules snapshot --input-file /absolute/snapshot.json --json
```

The input file contains:

```json
{"projectId":"message-rules-global","discoverFiles":false}
```

`projectId` addresses the catalog here; it is **not** a fixture's BB project or
an evaluation filter. The result's `project.revision` is the catalog revision.
For an authorized edit, write a JSON request file and call the inspected method
with `--input-file`. `saveGroup` takes `{projectId, revision, group}` and
`saveRule` takes `{projectId, revision, rule}`. Supply the complete inspected
value/schema; edit a snapshot value rather than dropping its existing fields.
Use the returned catalog revision for the next write. Rule/group `revision`
fields are separate from the outer catalog revision. On conflict, reread and
reconcile authored intent; never overwrite another edit or silently enable it.
Use actions `reject`, `proceed`, `steer`, `queue`, `queue-batched` and a separate `check: always|jev`. JEV questions and reduction determine whether the selected action applies. Proceed preserves requested delivery intent; conflicting explicit route preferences remain unresolved. Legacy action names are supported for immutable history and migrated authored projections. Saving does not activate live enforcement. Discovery adds metadata, not authority
to change rules; perform only edits the user commissioned.

For fixtures use version-1 Markdown documented in the plugin README. Read with
`discoverFiles:true` when file discovery is needed. Existing `saveFile` requests
carry the occurrence's `occurrenceId`, path, hash and exact `location` (hostId,
root, revision); new tests need a saved `groupId`, null hash and the selected
location. A null hash means create-only, not overwrite. Preserve imported files,
source project identity and ownership. `assignTest` changes organization only.
Use `project_id` in fixture front matter for explicit BB project context and
`rule_catalog: global` for global expected-rule IDs; the catalog ID is never a
BB project. Do not rewrite fixtures/configuration to make results green.

## Explicit tests and uncertain operations

Save/discard relevant browser drafts before **Test all**. This freezes every
enabled fixture and the complete saved catalog. Expected rejection can pass;
errors/unknown/stale are distinct from assertion failure. The explicit
`startSuite` RPC requires the saved `basis`, a unique `requestId`, and truthful
`hasRelevantDrafts`. It may incur configured paid JEV work; do not run it merely
for screenshots or without authorization. CLI cannot inspect another browser's
private drafts. Use metadata-only reads to inspect progress.

**Test selected** uses the same `startSuite` operation with
`selectedOccurrenceIds: ["saved-occurrence-id"]`. Supply 1..100 identities;
duplicates are removed. Every selected fixture must still be saved, enabled,
nonmissing and valid under the exact saved basis. The frozen denominator
contains only those fixtures; all applicable group scopes still apply. Omit
the field for Test all. Selection is part of the immutable request: changing
it under the same `requestId` is a conflict, never a retry or scope expansion.

After a lost start response, read `snapshot` with the same `requestId` and
`discoverFiles:false`: `acknowledgedRun` identifies that exact run independently
of latest `run`. For uncertain cancellation, read with the target `runId` and
inspect that exact `acknowledgedRun`, even after a newer run exists. Do not generate a new request or replay paid unknown effects.
After an uncertain file write, reread the same occurrence/location and compare
exact intended bytes/hash; keep the draft if unresolved. Never replay a write
because an unrelated read succeeded. Location changes invalidate old editors.
External editors can race the host's hash check/replacement; this is not atomic
filesystem CAS.

Absent/incompatible native hosts retain the editor and saved tests; enforcement
status is unavailable until the authoritative pointer is known. There is no fallback
production dispatch hook or plugin-owned queue mutation. A capable host registers
the optional native evaluator; saving/migration/Test all never activates it.
Initial activation is only through explicit testing-project RPCs:
`testAdmissionState`, `publishTestPolicy`, `deactivateTestPolicy`,
`lookupTestPublication`. Inspect their current installed schemas. Each names an
explicit `testProjectId` and literal `scope: "test-project"`; publication and
deactivation also carry current saved `basis`, stable `requestId` and the native
`expectedActivePublication` CAS reference. Do not enroll a project without an
actual request. No global/normal activation is provided here.

Read active state from native, not from a saved rule or remembered pointer.
After an uncertain publication/deactivation, lookup the same request ID; do not
generate a new request or replay the write. Repeating the same publication
request reconciles the original native operation without reading new policy
bytes into that operation. Saved edits remain distinct from active policy;
accepted revisions retain their native frozen semantic result on wakes.

Never imply a saved test sent messages, that controlled public-port tests prove
native transactions/live quality/cost, or that acknowledgement proves agent
consumption. Shared JEV uses Topics' owner-local configured connection through
the public bb-jev RPC contract. The dedicated Message Rules key is used only
when explicitly selected in settings. Both retain bounded calls/time/wire size;
context fit is provider-checked without verified counts. No ambient credential
fallback, automatic paid replay or automatic rule changes.


## Native placement fixture assertions

Legacy `expected_batch` remains an intended-membership assertion. For a native
simulation, add `# Native placement` with fenced JSON `{ "input": <public
PreviewPlacementInputV1>, "expect": { "status": "join|singleton|separate|conflict",
"targetGroupId": <string|null>, "orderedOriginalIds": [...], "reasonCodes": [...] } }`.
Use one actual enum value; `reasonCodes` is optional and exact when present.
The shipped `fixtures/native-placement-q-a-s-b.md` is a complete example. Match
candidate message/routing IDs/titles to fixture front matter and # Message.
Test all applies the evaluated route to a copy, preserves schedule/execution and
queue originals, computes the public request fingerprint, then calls only native
`previewPlacement`. Missing capability or an unresolved/cancelled simulation makes
that new assertion unknown; ordinary content fixtures remain usable. Results are
nonmutating simulations, never live acceptance/grouping/delivery evidence. Do not
replace them with locally calculated eligibility or reinterpret old frozen runs.


## Reload readiness

`activeKnown` confirms the persisted native publication pointer; it does not
confirm current-generation enforcement. Read `generationReady` separately. One
activated background service may rebind only a prior explicit, acknowledged,
exact still-active publication using its original stored operation/input. It
reconciles native operation evidence first and never uses changed saved rules or
creates/widens enrollment. Missing proof, a newer pointer, an old evaluator
version or uncertain rebind leaves readiness unavailable. No poller or blind
retry is provided. Repeating a user publication request remains read-only
reconciliation; it does not itself rebind a generation. A deliberately new
publication request requires the original user-authorized scope and current CAS.


## Read-only native decision inspection

The enforcement banner always distinguishes confirmed **Not enforcing** from
loading/unknown/unavailable status. A persisted publication alone does not prove
current-generation readiness. Ready enforcement names the frozen publication,
configuration/evaluator version and actual enrolled project IDs/names. The
shared global authoring panel never asserts current-project enrollment. Saving,
switches, Test selected/all and JEV configuration do not enroll anything.

Open **Recent native decisions** and click **Read recent decisions**. Expand a
callback for all native assessments/causes/advice, source/destination IDs and
names, declared actor metadata, operation ID, frozen publication/scope/version,
feedback and delivery. Local evaluation is diagnostic, never native finality.
**Refresh** reads the newest page; **More** replaces it with older callbacks.
Read failures retain the previous page with an explicit stale-page explanation.
There is no polling or read on typing. Source/tests do not prove the installed
UI has been activated; inspect installed methods first:

```sh
bb plugin rpc inspect message-rules listRecentDecisions --json
bb plugin rpc call message-rules listRecentDecisions --input-file /absolute/recent-decisions.json --json
```

The newest-page file is exactly `{"limit":10}`. For More, use
`{"limit":10,"before":"123"}`, replacing `123` with the returned `nextCursor`
verbatim. Cursors are positive rowid strings, not assessment-ID sort keys.
`limit` is 1..25 (default 10); SELECT reads at most 26 rows using rowid keyset,
and public native lookups use at most four concurrent calls. No full scans.

For a known operation shown in a page, retain its exact `operation` key and use
its callback's `assessmentId` with the same CLI command and exact indexed input:
`{"limit":1,"assessmentId":"the-retained-assessment-id"}`. Do not include
`before`. The UI's **Read callback detail** uses this path. Native operation,
request fingerprint and original revision must match the frozen binding even
when large display fields were omitted. No match is an empty page. Missing or
failed native lookup is unknown, never local success. For a known publication
operation, inspect `lookupTestPublication` and reconcile its original
`{testProjectId,scope:"test-project",requestId}` without a new publication ID.

Coverage is **MR evaluator callbacks retained here**, not an exhaustive host
audit: inputs before the callback, missing/deactivated plugins, other providers
and operational exemptions may be absent. Accepted preparations are not rejected
history. No ledger table is an explicit no-retained-callbacks result; read
failure is distinct. Reads never initialize/fence the ledger, evaluate, recheck,
submit feedback, publish, enroll or invoke paid JEV. They work after reload
before the next callback.

The 512 KiB page budget and maximum 256 KiB row budget preserve complete bounded
native records or report explicit unavailable/size refusal, never partial causes
or advice presented as complete. Multi-row pages have smaller row budgets;
exact callback detail has the larger budget. Raw original JSON excerpts are
labeled when truncated (8192 characters). Frozen JSON parsing is bounded to
1 MiB per selected row. Older/malformed bindings retain useful identity and
phase/path diagnostics without invented native identities or raw policy parse
fragments. Full frozen policy/connection bytes are excluded; the current policy
in the banner may differ from a callback's frozen publication. Delivery and
feedback consumption require their own actual recorded states.
