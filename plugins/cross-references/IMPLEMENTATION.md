# Cross References: first exact-reference slice

This is the normative implementation contract for v1. It turns the broader
model in ARCHITECTURE.md into one proving spine:

> An operator selects a BB thread on the deployment-local Machine Monitor
> page. The attachment is usable immediately from Machine Monitor, is
> projected durably into Cross References, and appears as a Machine Monitor
> backlink on that thread after eventual delivery. Removing the attachment
> removes the backlink after the removal projection is durably accepted.

This document is the executable contract for the first exact-reference slice.
The exact canonical model, SQLite projection/index, RPCs, realtime
invalidation, Machine Monitor source ownership, and frontend thread surface
described here are implemented in the two owned packages.

## Scope and non-goals

The first slice includes:

- one installation-local Cross References SQLite database;
- exact canonical identity for BB projects, BB threads, and the Machine Monitor
  page;
- a bounded applyProjection, getProjection, and exact listBacklinks RPC
  contract;
- Machine Monitor-owned local attachments, complete-set replacement, and a
  coalescing durable outbox;
- a bounded thread picker backed by BB thread search/get; and
- a compact, per-thread Cross References header action with native BB thread
  navigation.

It does not include:

- defineCrossLinks, public URL-template parsing/formatting, or a provider
  registry;
- a contained-match RPC, containment UI, rollups, graph traversal, or a
  promise that resource_keys is queryable by consumers;
- GitHub, Sticky Notes, Thread Links ingestion, federation, or private
  per-principal authorization;
- a universal resource browser, generic component registry, DOM injection, or
  plugin-to-plugin React injection; or
- automatic cleanup based only on thread.deleted, producer disablement, or an
  unavailable Cross References runtime.

The first-slice public read contract is exact-only. Normalized key rows may be
written for a later contained read model, but no implementation or test may
advertise containment as a v1 capability. The public authoring APIs and
containment work listed above remain vision, not implied promises.

## Contract decisions

### Installation and identity

The scope is one BB deployment, represented by the Cross References plugin's
own database. Do not add hostname, filesystem path, URL origin, actor identity,
or a guessed installation ID to resource identity. bb.storage.database() is
already the per-plugin database at <dataDir>/plugins/<id>/data.db, with WAL
and a reused handle for one plugin load
([backend-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/backend-contract.ts#L119-L136)).
The database is therefore the installation boundary in v1.

Identity is exactly (provider, canonical keys). Presentation, URL, producer,
constructor name, discovery time, and source plugin do not participate. The
v1 BB conventions are:

~~~text
project:         { provider: "bb", keys: { project: projectId } }
thread:          { provider: "bb", keys: { project: projectId, thread: threadId } }
machine monitor: { provider: "bb", keys: { page: "machine-monitor", plugin: "machine-monitor" } }
~~~

The wire types are intentionally small:

~~~ts
type Resource = {
  provider: string;
  keys: Record<string, string>;
  presentation: { label: string; detail?: string; url?: string };
};
type ResourceIdentity = Pick<Resource, "provider" | "keys">;
type Presentation = Resource["presentation"];
~~~

The Thread DTO's projectId and id fields are mapped to the public key names
project and thread; the values are preserved byte-for-byte after validation.
The DTO requires both fields
([thread.ts](../../../fork/build/bb/packages/domain/src/thread.ts#L373-L390)).
The Machine Monitor identity uses the plugin and navigation identifiers that
its app actually registers (id and path are both machine-monitor)
([app.tsx](../machine-monitor/app.tsx#L280-L288)). Hostname, platform, title,
and route presentation changes do not change this identity.

Cross References applies this additional bounded-ID policy because the core
Thread and Project schemas intentionally permit generic strings
([project.ts](../../../fork/build/bb/packages/domain/src/project.ts#L9-L17),
[thread.ts](../../../fork/build/bb/packages/domain/src/thread.ts#L373-L380)).
Accepted project/thread IDs match ^[A-Za-z0-9_-]{1,128}$ and are not
case-folded or trimmed. Current generated thread IDs are the narrower
thr_ plus ten-character alphabet documented by
[raw-thread-id.ts](../../../fork/build/bb/packages/domain/src/raw-thread-id.ts#L3-L16);
that helper must not be used to broaden or reject otherwise safe legacy DTO
IDs. Provider and key names match ^[a-z][a-z0-9._-]{0,63}$.

### Canonicalization and limits

All limits below are UTF-8 byte limits. Validation happens before persistence,
indexing, hashing, or an RPC transaction. Reject over-limit input; never
truncate it.

| Value | v1 rule |
| --- | --- |
| Provider/key names | lower-case ASCII, 1–64 bytes, the pattern above |
| Keys per resource | 1–32 |
| Key values | NFC-normalized, nonblank, no NUL or Unicode control character, at most 512 bytes |
| Combined key/value material | at most 8,192 bytes |
| Canonical identity JSON | at most 16 KiB |
| Presentation label/detail/url | 256 / 1,024 / 2,048 bytes |
| Presentation JSON | at most 4 KiB |
| Producer plugin ID | lower-case ASCII matching the provider/key-name pattern, at most 64 bytes |
| Targets in one projection | 0–256, ordered |
| Complete projection payload JSON | at most 256 KiB |
| Mutation ID | fresh UUID string, ASCII and at most 128 bytes |

An accepted value is NFC-normalized only; whitespace at its edges is retained.
“Nonblank” means its whitespace-trimmed form is nonempty. Optional presentation
members are omitted, not emitted as null or undefined. Supported URL
presentation is either a same-origin BB route beginning with / or an
http:// or https:// URL. The Machine Monitor source uses the exact route
/plugins/machine-monitor/machine-monitor; a thread target is navigated with
useBbNavigate().toThread(threadId), not with an unvalidated URL.

canonicalIdentityJson is compact JSON with this fixed shape and ordering:

~~~json
{"provider":"bb","keys":{"project":"proj_23456789ab","thread":"thr_23456789ab"}}
~~~

The keys object is sorted by ASCII key name. JSON escaping is standard JSON;
the resulting string is measured and hashed as UTF-8. Identity digest means
lower-case SHA-256 hex of this exact string. Presentation is serialized in the
fixed order {label, detail?, url?}.

The projection payload digest is lower-case SHA-256 hex over the UTF-8 compact
JSON of this fixed object, with target array order preserved:

~~~text
{ protocolVersion: 1, producerPluginId, source, tombstone, targets }
~~~

Each resource in that object has {provider, keys, presentation}; each
presentation has {label, detail?, url?}; key objects are sorted. The digest
includes presentation snapshots and target position, but excludes mutationId,
revision, and expectedRevision. Thus a retry and a CAS rebase can reuse a
payload tuple while presentation changes remain detectable. An active empty
target array is valid. A tombstone must have an empty target array. Duplicate
target identities in one payload are invalid, even if their presentations
differ.

### RPC surfaces

Cross References registers the typed methods below with bb.rpc.register. The
host validates RPC input and output and serves methods under
/api/v1/plugins/<id>/rpc/<method>
([backend-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/backend-contract.ts#L211-L223)).
These are private deployment protocol methods, not a promise of a general
public provider API.

applyProjection input is:

~~~ts
{
  protocolVersion: 1;
  producerPluginId: string; // claimed attribution, not authentication
  mutationId: string;
  source: Resource;
  revision: number;          // positive safe integer
  expectedRevision: number;  // nonnegative safe integer
  payloadDigest: string;     // lower-case SHA-256 hex
  tombstone: boolean;
  targets: Resource[];
}
~~~

The response is always a typed success result for a valid command:

~~~ts
{
  outcome: "applied" | "duplicate" | "equal" | "stale" | "conflict" | "cas-mismatch";
  currentRevision: number;
  currentDigest: string | null;
}
~~~

Missing projection state has revision 0 and digest null. Before opening a
transaction, the receiver validates all bounds, canonical forms, digest,
tombstone rule, and duplicate identities. It then applies this matrix to the
unique (producerPluginId, sourceResourceId) row:

| Incoming command | Receiver result and durable effect |
| --- | --- |
| revision < currentRevision | stale; no change |
| equal revision, same mutation and digest | duplicate; no change |
| equal revision, same digest, different mutation | equal; no change |
| equal revision, different digest | conflict; no change |
| greater revision, wrong expectedRevision | cas-mismatch; no change, return current tuple |
| greater revision, matching expectedRevision | applied; replace projection and all occurrences atomically |

An applied projection upserts all resource identities, deletes the old
occurrences, inserts the complete new ordered target set, and commits the
projection row. A tombstone and an active empty set both leave zero occurrence
rows, but only the tombstone has tombstone = 1. The receiver never infers
authorization from producerPluginId: the current dispatcher forwards ambient
actor context, not a caller-plugin identity
([routes/plugins.ts](../../../fork/build/bb/apps/server/src/routes/plugins.ts#L624-L695)).

getProjection takes { producerPluginId, source: ResourceIdentity } and returns
either projection: null or the complete stored projection, including
source/target presentation snapshots, revision, mutation ID, digest, and
tombstone. Machine Monitor uses it during startup reconciliation and recovery.

Its output is:

~~~ts
{
  projection: null | {
    producerPluginId: string;
    source: Resource;
    revision: number;
    mutationId: string;
    payloadDigest: string;
    tombstone: boolean;
    targets: Resource[];
  };
}
~~~

listBacklinks takes { target: ResourceIdentity, pageSize?: number, cursor?: string }.
pageSize defaults to 25 and is restricted to 1–100. It resolves the target
by the exact unique identity and returns an empty page when absent. Each row
contains the source resource/presentation, claimed producer ID, projection
revision, target presentation snapshot, and target position. Rows from two
producers remain separate occurrences even when their source and target
identities agree.

Its output is { rows: BacklinkRow[], nextCursor: string | null }, where each
BacklinkRow has { source: Resource, producerPluginId: string, revision: number,
targetPresentation: Presentation, position: number }. The occurrence ID is
cursor-internal and is not a resource identity.

The cursor is base64url without padding over compact JSON
{v:1,targetDigest,upperId,afterId}. The first page captures
upperId = COALESCE(MAX(reference_occurrences.id), 0) and uses afterId = 0.
Later pages require the target digest to match the requested identity, filter
id > afterId AND id <= upperId, return rows ordered by occurrence ID, and
encode the last returned ID only when an extra row exists. The occurrence ID
is never reused. A cursor is invalid, not silently repurposed, when its version,
digest, bounds, or encoding is wrong. This is bounded pagination over
eventually changing data, not a cross-request SQLite snapshot.

### Ownership and deduplication

Machine Monitor owns its source attachments and their presentation snapshots.
Cross References owns only the shared projection/index. The Cross References
database never reaches into Machine Monitor's private database. Machine Monitor
already obtains its own database and runs ordered migrations during plugin load
([machine-monitor/server.ts](../machine-monitor/server.ts#L19-L56)); its current
sampling service is supervised and abort-aware
([machine-monitor/server.ts](../machine-monitor/server.ts#L153-L189)).

Cross References deduplicates resources only by
UNIQUE(provider, canonical_keys_json). It does not deduplicate on presentation,
URL, producer, or discovery time. It deduplicates occurrences only within one
current producer projection, by exact target identity; a repeated target in
one incoming ordered list is rejected. Different producers asserting the same
source/target retain different occurrence rows. Display grouping is query/UI
derived, initially by exact source and target IDs, and retains each contributing
occurrence and producer. There is no display_groups table.

### Local-first Machine Monitor contract

Machine Monitor adds one source-owned operation,
replaceAttachments({ expectedSourceRevision, targets }). Add/remove are
read-modify-write conveniences, not separate wire mutations. The picker gets
the selected thread through bounded bb.sdk.threads.search and validates it
with bb.sdk.threads.get; search has a two-non-whitespace-character minimum
([threads.ts](../../../fork/build/bb/packages/sdk/src/areas/threads.ts#L76-L110),
[base.ts](../../../fork/build/bb/apps/server/src/routes/threads/base.ts#L319-L337)).
It must not use the uncapped sidebar cache exposed by the app contract
([app-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/app-contract.ts#L1923-L1933)).

The local source database has these additional logical tables:

~~~text
machine_monitor_reference_links
  target_provider, target_canonical_keys_json, target_presentation_json,
  position, created_at, updated_at,
  PRIMARY KEY (target_provider, target_canonical_keys_json),
  UNIQUE (position)

machine_monitor_reference_state
  singleton CHECK (singleton = 1), desired_revision, desired_payload_digest,
  last_acked_revision, last_acked_mutation_id, last_error, updated_at

machine_monitor_reference_outbox
  singleton CHECK (singleton = 1), slot CHECK (slot IN ('pending','in_flight')),
  revision, mutation_id, expected_remote_revision, payload_json,
  payload_digest, attempts, next_attempt_at, lease_until, last_error,
  updated_at, PRIMARY KEY (singleton, slot)
~~~

An attachment replacement validates and canonicalizes the complete target list
before one local SQLite transaction. That transaction checks the expected
local revision, replaces the links, allocates the next safe integer revision,
stores the desired digest, and replaces only the pending outbox slot. An
identical normalized set is a no-op. An active empty set is a real revision;
it is not deletion. A pending slot may be coalesced, but an in_flight tuple
is immutable. Local commit and outbox commit are atomic; the Cross References
RPC and realtime publish happen after commit.

### Delivery state machine and rollback safety

The durable sender has at most two rows: the newest coalesced pending command
and, when a request is outstanding, its immutable in_flight command. Every
command is identified by the tuple
(revision, mutationId, payloadDigest, payloadJson). Retries of that tuple
reuse its mutation ID and digest.

1. A due pending row is claimed in a short transaction by setting its lease and
   changing its slot to in_flight.
2. The sender calls Cross References with no SQLite transaction open. The
   backend call uses bb.sdk.plugins.callRpc({ pluginId, method, input,
   outputSchema }), which performs the plugin route call and output parsing
   ([plugins.ts](../../../fork/build/bb/packages/sdk/src/areas/plugins.ts#L135-L139),
   [plugins.ts](../../../fork/build/bb/packages/sdk/src/areas/plugins.ts#L378-L385)).
3. A response may mutate local outbox state only if the in_flight row still
   matches all four tuple fields. A late response can never clear or replace a
   newer pending command.
4. applied, duplicate, or equal clears the matching in_flight row and advances
   the local acknowledged/floor revision to the receiver's current revision.
   If a newer local desired tuple exists, it remains pending.
5. A stale or CAS response compares the receiver digest. Equal digest means
   the desired payload is already present and can be acknowledged. A differing
   digest rebases the newest local desired payload to
   max(localDesiredRevision, receiverRevision) + 1, creates a fresh mutation
   ID, and queues that complete state.
6. Transport errors, timeouts, 5xx, 503, and handler_error retain the exact
   tuple and retry with 1s, 2s, 4s, ..., capped at 60s. Invalid input,
   same-revision conflict, authentication failure, and incompatible
   unknown_method are retained as diagnosable blocked states and must not
   spin. A later explicit mutation or reconciliation may create a fresh
   revision.
7. On reload or service restart, an expired in-flight lease is recovered and
   retried with the same tuple. The background service observes its abort
   signal. BB supervises crashed services with capped backoff; the optional
   Cross References outage must never be reported through
   bb.status.needsConfiguration, whose semantics stop restarts until reload
   ([backend-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/backend-contract.ts#L240-L254)).

On startup and after recovery, getProjection reconciles the local desired
state. If the receiver is ahead with a different digest, the local complete
state is rebased. If the receiver is behind, the local tuple is requeued with
the receiver's current revision as expectedRevision. A source database
rollback is therefore repaired from current local links, not by replaying an
old acknowledgement. Receiver rollback is repaired by resending the current
complete local state. No operation adopts remote targets or presentation over
Machine Monitor's local truth.

### SQLite invariants and migrations

Immediately after bb.storage.database() returns, the Cross References server
executes PRAGMA foreign_keys = ON and verifies that it returns 1, before
migration or handler registration. The host guarantees the per-plugin database,
WAL, and busy timeout but not this pragma
([backend-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/backend-contract.ts#L119-L136)).
The migration array is append-only: statement index is migration ID and each
unapplied statement batch runs in one transaction. Never reorder or edit a
shipped statement; a failed migration must leave the prior schema/data intact.

The v1 logical schema is:

~~~sql
cross_reference_meta(
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  scope_kind TEXT NOT NULL CHECK (scope_kind = 'installation-local'),
  model_version INTEGER NOT NULL CHECK (model_version = 1)
)

resources(
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  canonical_keys_json TEXT NOT NULL,
  key_count INTEGER NOT NULL CHECK (key_count BETWEEN 1 AND 32),
  created_at INTEGER NOT NULL,
  UNIQUE (provider, canonical_keys_json),
  UNIQUE (id, provider)
)

resource_keys(
  resource_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (resource_id, key),
  FOREIGN KEY (resource_id, provider) REFERENCES resources(id, provider)
    ON DELETE CASCADE
)

source_projections(
  id INTEGER PRIMARY KEY,
  producer_plugin_id TEXT NOT NULL,
  source_resource_id INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  mutation_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  source_presentation_json TEXT NOT NULL,
  tombstone INTEGER NOT NULL CHECK (tombstone IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (producer_plugin_id, source_resource_id),
  FOREIGN KEY (source_resource_id) REFERENCES resources(id) ON DELETE RESTRICT
)

reference_occurrences(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  projection_id INTEGER NOT NULL,
  target_resource_id INTEGER NOT NULL,
  target_presentation_json TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 255),
  created_at INTEGER NOT NULL,
  UNIQUE (projection_id, target_resource_id),
  UNIQUE (projection_id, position),
  FOREIGN KEY (projection_id) REFERENCES source_projections(id)
    ON DELETE CASCADE,
  FOREIGN KEY (target_resource_id) REFERENCES resources(id) ON DELETE RESTRICT
)

resource_keys_match_idx(provider, key, value, resource_id)
reference_occurrences_target_idx(target_resource_id, id)
~~~

The application boundary enforces UTF-8 byte limits and canonical JSON because
SQLite CHECK expressions cannot enforce those protocol properties. Explicit
INSERT ... ON CONFLICT DO UPDATE and transactional occurrence delete/insert
are required; do not use INSERT OR REPLACE for parent rows because its delete
and cascade behavior is unsafe for this model. Resource rows are append-only in
v1. resource_keys is maintained only as future-ready storage and is not a
contained-query contract.

### Realtime and degraded behavior

After a committed projection change, Cross References publishes one bounded
cross-references-changed signal. Its payload contains protocol version,
affected exact identity digests, and the affected producer/source revision;
it contains no unbounded rows or private host details. The SDK's realtime
publisher broadcasts ephemeral signals to every connected client and persists
nothing
([backend-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/backend-contract.ts#L226-L234)).

The thread-header action uses its own useRpc() client, listens with
useRealtime("cross-references-changed", ...), and refetches the exact target
when the signal matches. It treats a signal only as an invalidation hint. It
also refetches on a later transition to connected from
useRealtimeConnectionState() because a signal may have been missed
([app-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/app-contract.ts#L1900-L1912)).
Duplicate/older signals coalesce with an in-flight request; unrelated identity
signals are ignored. There is no foreground polling. While reconnecting, the
last page may be shown with a stale marker; an unavailable state is bounded
and recoverable.

Machine Monitor's local attachment operation succeeds when Cross References is
missing, disabled, stopped, incompatible, or temporarily failing. Its local
links remain visible and its outbox reports pending/degraded/blocked detail.
The sender classifies the SDK's BbHttpError.status and .code rather than
parsing presentation text; the SDK exposes those fields and a 75-second
request timeout
([response.ts](../../../fork/build/bb/packages/sdk/src/response.ts#L73-L108)).
An unknown plugin is optional/missing-index, a stopped plugin is unavailable,
transport/5xx/handler failure is transient, unknown_method is incompatible,
and malformed/conflicting/auth failures are blocked. All expected delivery
failures are caught inside the service. No absence path calls
needsConfiguration.

The last accepted projection remains potentially stale when Machine Monitor is
disabled. Only a delivered active empty projection or explicit tombstone
removes live occurrences. The first slice does not turn BB's observe-only
thread.deleted event into automatic cleanup; a later durable source mutation
or administrative policy must decide what deletion means.

## Dependency-ordered execution strategy

### Workflow 1: contract

Depends on the documentation in this file and changes only Cross References
contract/storage files plus tests. Freeze canonicalization, digest, RPC
outcomes, schema constraints, exact cursor encoding, and the claimed-producer
wording. Add the Cross References migrations, canonical/resource modules,
rpc-contract.ts, and server handlers. Do not add Machine Monitor code or
public containment/definition exports.

Its exit gate is the canonicalization, digest, FK/unique/index, projection CAS
matrix, exact query, and cursor test set in the acceptance gates below, plus
the Cross References package test/typecheck/build commands.

### Workflow 2: proving spine

Depends on Workflow 1's frozen RPC contract and schema. The Machine Monitor
worker owns its attachment tables, replaceAttachments, coalescing outbox,
delivery service, local status, and picker integration. The Cross References
worker owns its thread-header app contribution and exact backlink query client.
The worker must use bb.sdk.plugins.callRpc on the backend and
useRpc/useRealtime in the frontend. The native Machine Monitor source link
uses the host experimental_UrlLink; current route handling recognizes
same-origin app routes, while toPluginPanel itself is explicitly limited to
the current plugin
([app-contract.ts](../../../fork/build/bb/packages/plugin-sdk/src/app-contract.ts#L1840-L1871),
[ExperimentalUrlLink.tsx](../../../fork/build/bb/apps/app/src/components/plugin/ExperimentalUrlLink.tsx#L32-L91)).

The proving spine covers local-first operation with Cross References absent,
durable active-empty removal, reload convergence, two-client invalidation, and
the per-thread header action. Its implementation edits only the Machine Monitor
files needed for attachment/delivery and the Cross References app/contract
files named by the task; it does not touch Sticky Notes or unrelated plugins.

### Workflow 3: adversarial closeout

Depends on both previous workflows and tests the real BB staging runtime. It
owns race/reload/rollback tests, stale acknowledgements, lease recovery,
backoff/error classification, SQLite failure atomicity, target cursor bounds,
missed realtime signals, plugin stop/reload, responsive/keyboard/a11y checks,
and the absent-plugin path. It may add tests and narrowly correct the owned
files, but it must not widen v1 into containment or new providers.

The workflow ends only after the community repository checks and
./bin/check --role staging pass against the exercised composition. No
workspace gitlink or child commit is advanced in this task.

## Scoped ownership

| Area | Owned paths | Boundary |
| --- | --- | --- |
| Cross References contract/store | plugins/cross-references/{canonical.ts,model.ts,rpc-contract.ts,store.ts,server.ts} and adjacent tests | Canonical identity, validation, migrations, CAS, exact query, cursor, digest, invalidation. No Machine Monitor local truth. |
| Machine Monitor source adapter | plugins/machine-monitor/{attachment-contract.ts,attachment-delivery.ts,attachments.tsx,monitor.ts,server.ts,store.ts,app.tsx,app.css} and adjacent tests | Local links, complete-set mutation, outbox, delivery, picker, monitoring, and degraded status. No direct Cross References DB access. |
| Cross References thread surface | plugins/cross-references/{app.tsx,app.css} and adjacent tests | Per-thread header action, exact read, signal/refetch, native navigation. No DOM injection or source mutation. |
| Adversarial closeout | plugins/cross-references/test/, plugins/machine-monitor/test/, and staging harness tests | Failure interleavings and real host behavior only; no unrelated plugin changes. |
| Publication metadata | plugins/{cross-references,machine-monitor}/package.json and README.md, {README.md,.bb/plugins.json,.github/workflows/} | Keep the two proving-spine packages installable and independently releasable; do not add generated dist/ output to source control. |

This documentation phase has edited only the last row's Cross References
documentation/metadata. Sticky Notes and all other dirty workspace changes are
outside this ownership table and must remain untouched.

## Executable acceptance gates

Run from /home/ubuntu/bb/community-plugins unless noted. The community
repository requires npm run test, npm run typecheck, and npm run build
([AGENTS.md](../../AGENTS.md)). For this backend phase, the focused
package gates are:

~~~sh
node -e 'const p=require("./plugins/cross-references/package.json"); if (!p.files.includes("IMPLEMENTATION.md")) process.exit(1); JSON.parse(require("fs").readFileSync("./plugins/cross-references/package.json","utf8"));'
test -s plugins/cross-references/ARCHITECTURE.md
test -s plugins/cross-references/IMPLEMENTATION.md
npm run test --workspace @phosphorco/bb-plugin-cross-references
npm run typecheck --workspace @phosphorco/bb-plugin-cross-references
npm run build --workspace @phosphorco/bb-plugin-cross-references
~~~

The implementation workflow is not ready to close until these behavioral gates
also pass:

1. Canonicalization rejects malformed/over-limit/control input, normalizes
   NFC, sorts keys byte-identically, preserves safe IDs, and keeps presentation
   changes on one resource row.
2. The three BB forms are exact-distinct where required: project versus thread,
   and Machine Monitor identity versus any changed presentation. Duplicate
   target identities in one projection are rejected.
3. An in-memory database proves foreign_keys = 1; orphan rows fail,
   projection deletion cascades to occurrences, resource deletion is
   restricted, and all stated unique/index constraints exist.
4. The CAS matrix returns duplicate/equal/stale/conflict/cas-mismatch exactly;
   applies complete replacements atomically; distinguishes active empty from
   tombstone; and never resurrects from stale delivery.
5. Exact backlink pages enforce 1–100 bounds, absent-target emptiness,
   target-bound cursors, upperId, ordered nonrepeating pages, and no reused
   occurrence IDs.
6. Local attachment is visible before delivery, survives an absent/stopped
   Cross References plugin, coalesces pending edits, retains immutable
   in-flight tuples, retries ambiguous outcomes with the same mutation/digest,
   and ignores stale acknowledgements.
7. Rebase tests cover receiver-ahead/behind, source rollback, equal/different
   digests, lease recovery, and bounded 1/2/4-second backoff through 60 seconds.
8. Two clients refetch only matching identities after committed signals and
   refetch after a missed-signal reconnect. No foreground polling exists.
9. The header action receives the SDK's per-thread/per-pane props, stays within
   compact header bounds, uses toThread, opens the exact Machine Monitor route
   through the host URL-link component, and remains crash-isolated and
   keyboard/screen-reader usable.
10. From /home/ubuntu/bb, run git diff --check and
    ./bin/check --role staging; inspect git status and confirm no unrelated
    dirty change was altered and no generated dist/ is committed.

The exact RPC, storage, and query tests in gates 1–5 establish the backend
contract phase. The proving-spine workflow must still not claim that the full
first slice is implemented until the source adapter, frontend, and staging
gates in 6–10 are exercised.
