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
Saving does not activate live enforcement. Discovery adds metadata, not authority
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

After a lost start response, read `snapshot` with the same `requestId` and
`discoverFiles:false`: `acknowledgedRun` identifies that exact run independently
of latest `run`. For uncertain cancellation, read with the target `runId` and
inspect that exact `acknowledgedRun`, even after a newer run exists. Do not generate a new request or replay paid unknown effects.
After an uncertain file write, reread the same occurrence/location and compare
exact intended bytes/hash; keep the draft if unresolved. Never replay a write
because an unrelated read succeeded. Location changes invalidate old editors.
External editors can race the host's hash check/replacement; this is not atomic
filesystem CAS.

Current mode is preview/observe editor/tests only: no production dispatch hooks,
automatic observer, queue mutation or consumed sender advice. Full original
all-eligible-sender delivery and safe separation remain unproved. Native grouping
HTTP409 establishes one route's limit only. Never imply a saved test sent messages,
that injected tests prove live quality/cost, or that acknowledgement proves agent
consumption. Real JEV uses only this plugin's configured credential, with bounded
calls/time/wire size; context fit is provider-checked without verified counts.
No ambient credential fallback, automatic paid replay or automatic rule changes.
