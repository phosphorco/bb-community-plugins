# Thread Filters, package 0.1.0 / wire v1

Independent plugins contribute discrete thread filters. Consumers discover and render them without plugin-specific code. A filter evaluates a bounded consumer-supplied thread census; it never widens that census, starts scoring, writes, or treats missing evidence as a negative fact.

| Supplier owns | Contract owns | Consumer owns |
|---|---|---|
| Attribute meaning, choice identity, storage, source access, personal lens, matching and coverage | Wire schemas, fixed RPC names, bounds, version negotiation, owner-bound client, registration and conformance helper | Discovery, choices UI, selected conditions, AND composition, loaded census, requests and honest result notices |

`threadFiltersDescribe(null)` advertises `{protocol:'bb.thread-filters', versions:[1], dimensions:[{id,label,multiple,description}]}`. Decode the tolerant envelope before v1 details. Identities are `(listed plugin ID, dimension ID)`, never an advertised namespace. Installing another conforming supplier requires no consumer code changes.

`threadFiltersChoicesV1({dimensionId,viewerKey,query,cursor,limit})` returns `{choices:[{id,label}],nextCursor,revision}`. Choice IDs are opaque, stable within the dimension, and interpreted only by their owner. Cursors bind query/viewer/revision; a supplier rejects stale cursors. Consumer resets accumulated pages when revision changes. Query text searches all source choices. Stored selections retain labels when choices disappear and are never silently cleared.

`threadFiltersMatchV1({viewerKey,selection:{dimensionId,values,mode:'any'|'all'},threads:[{id,projectId,parentThreadId}]})` returns `{rows:[{threadId,matches:boolean|null}],revision,coverage:'complete'|'partial'|'unknown',message,refreshAt}`. Exactly one row per requested thread; no duplicates/unrequested rows. Null means unresolved. `complete` forbids null rows. `partial` can include known positives and negatives but requires the consumer to disclose coverage. Absence of topic evidence is unresolved. Invalid/deleted choices fail the read rather than becoming an empty selection.

The consumer intersects conditions (AND); within one condition `any` means OR and `all` means AND. No general expression language, storage or background scan is introduced. Native machine and existing native filters remain consumer-owned and intersect with contributed results.

Viewer identity is attribution and an explicit personal-data lens, not authorization. Suppliers return data suitable for this trusted shared deployment; credentials/source access stay supplier-owned. Personal results and all caches are fenced by actual actor session plus viewed subject. Read handlers do not need to impersonate the viewed person.

Published per-call bounds: 16 dimensions, 100 choices, 16 selected values, 200 requested threads, 64 KiB input, 256 KiB response, 16 KiB describe. Dimension IDs use `[a-z][a-z0-9-]{0,63}`; opaque choice IDs are at most 4096 UTF-16 units. Labels are at most 512, help text 1000. Inputs are recursively strict; outputs tolerate additive fields at every evolving object. Changing closed enum meaning requires a new wire version. Raw output size is checked before DTO stripping; JSON is already parsed in the transport, so this is not a pre-allocation bound.

The owner-bound client settles locally within 5 seconds and bounds its serialized queue to 32 calls and retains one raw-call admission slot until the underlying SDK call settles. Abort fences results and asks for cancellation; it does not prove remote work stopped. No automatic retry after timeout. Suppliers must independently bound their own work. Refresh/new generation starts a new request only through the same retained client. Remote errors propagate; discovery ignores only verified `404 unknown_method` and isolates other supplier failures.

Consumer discovery calls `plugins.list` once per pass, probes running plugins with concurrency four, and admits at most 256 plugins per pass, disclosing truncation. Triggers: filter open, explicit refresh, focus/reconnect or plugin lifecycle. No healthy polling. Consumers keep unavailable selected filters active and suppress unverified rows rather than displaying the full census. Batch revisions must agree or the whole condition is retried by explicit refresh. `refreshAt` requests one collection-level deadline, paused while hidden, for cases such as snooze expiry.

Entries: root (Zod only), `/bb` (injected SDK, type-only SDK dependency), `/testing` (source conformance). No React dependency. Source conformance, host fake tests, package pack tests and live composition proof are separate evidence levels.
