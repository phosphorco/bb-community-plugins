# Source-history feasibility probe

Run from the workspace root:

```sh
node community-plugins/plugins/analytics/test/architecture/probes/source/probe.mjs
```

This bounded probe is source-only. It reads named public SDK, server-contract,
and current Analytics source files; it does not open operational SQLite, call a
live SDK, create a thread, or retain thread/event contents or identifiers. Its
JSON output carries file SHA-256 values and source revisions so a later run can
detect drift.

## Observed source boundary (captured 2026-09-08)

The source materialization is at fork `c77975fbb3dd642684a4afee074e37d0c559cb4e`
with upstream `5205d98a74ed5a22469e521cf1f86b00b8232827`; the community plugin
repository is `7a28e61f1816499cf6b9c6faca4a1f7ab4662e18`; and the public identity
package repository is `1bce7bbb7a84a18971578679aaca58fecfbaa991`. Relevant current
file hashes are emitted by the probe. These trees are dirty, so file hashes—not
only revisions—are required evidence.

Source proves that public thread listing accepts `offset`, `archived`, and
`includeHidden`; with `archived` omitted and `includeHidden: true`, current list
filters non-deleted threads but does not filter archive state. Public event
listing exposes `afterSeq`, `beforeSeq`, and order. Changed messages name
`events-appended`, `history-rewritten`, and `thread-deleted`. Current Analytics
still uses a 200-candidate, 80-selected-thread, 500-event-per-thread recency
prefix.

`updatedAt` cannot serve as the retained-history invalidation contract. A
concrete daemon `item/completed` path converts the daemon envelope to a stored
event, appends it in the daemon event transaction, and publishes
`events-appended`; that transaction has no thread `updatedAt` write, and the
subsequent event-effect switch has no `item/completed` branch. This proves one
reachable source path without a companion timestamp mutation. It does not
claim that every append caller omits the mutation: the global append/mutation/
delete/rewind timestamp invariant remains unestablished. The present Analytics
shortcut that skips a thread when its list `updatedAt` is unchanged must be an
optimization with a correctness gap, not source-backed incremental
reconciliation.

The public server's direct thread `get` path resolves through `requirePublicThread`.
Current source returns HTTP `404` with `thread_not_found` for a deleted thread
or a thread whose project is deleted. Public SDK transport converts a non-2xx
response into `BbHttpError`, carrying `status` and machine-readable `code`; the
plugin wrapper only registers a successful `get`, so source currently preserves
the rejected transport error. A feature can conservatively recognize the exact
structural `BbHttpError` / `404` / `thread_not_found` case. It must not turn an
arbitrary rejection, generic 404, 401/403, timeout, abort, or omission into a
deletion; a deleted project and a later admission/visibility change remain
reconciliation races.

## Feasible disclosed outcome

Use demand-triggered, budgeted repeated enumeration and retain a union of
previously observed membership. Page the non-deleted, hidden-inclusive list;
never turn a missing page row or a generic read failure into deletion. Advance
ordinary event reads with `afterSeq`; meter SDK calls and response bytes as well
as event rows. On `history-rewritten`, reread the thread from the beginning
within a declared budget and replace its projected facts only atomically after
success. Preserve prior facts and label coverage degraded on failure. An
explicit deletion notification may trigger confirmation only through the exact
source-supported structural `404` / `thread_not_found` transport case.

After churn quiesces, repeated completed sweeps can converge to the current
bounded scope. A completed sweep cannot itself prove churn was absent, so each
published generation needs `asOf`, page/thread/event/call/byte budgets, scope,
reconciliation count, and `reconciled-observed-as-of` / partial / degraded
coverage. This is eventual convergence, not a point-in-time historical
snapshot or a final-complete claim.

The probe also runs a deterministic, in-memory paginated source and reconciler
(not a live SDK test). It establishes a baseline, catches an append using
`afterSeq`, then introduces offset-page churn, an omitted retained member, a
generic direct-read failure, an exact synthetic `404/thread_not_found`, and a
history rewrite. After the fixture quiesces, the retained-union/full-reread
strategy must equal the expected retained synthetic event set. The same fixture
is run through deliberately broken omission-delete and delta-only strategies;
both must mismatch. Results expose only synthetic-set digests and call counts,
never BB data. This exercises the stated algorithm; it is not proof of deployed
SDK behavior or production convergence.

## Unsupported guarantees and costs

The list API is offset-based with an array response: it has no stable snapshot
token, next cursor, total, or as-of watermark. Event pages similarly lack an
immutable high-watermark. Concurrent insertions, ordering changes, archive/
hidden changes, deletion, and history rewrites can make one sweep duplicate or
miss rows. A source `updatedAt` field is an optimization hint only: one concrete
append path disproves a universal append invariant, while complete mutation/
delete/rewind behavior remains unproven.

Strict point-in-time completeness, replayable exact delete deltas, and efficient
incremental rewind repair need additional public contract evidence (and likely a
snapshot/cursor/tombstone design). They are not necessary for the explicitly
partial eventual-reconciliation policy, whose cost is bounded O(list pages plus
event pages) per sweep and O(all retained events in a rewritten thread).

The public `@phosphorco/bb-identity` binding is available for request/background
admission but does not add thread-history snapshot or deletion semantics. It
must not be used to invent a separate private access path.

## Plugin-owned SQLite to query-child handoff

`node-sqlite-handoff.mjs` is a separate, bounded mechanics probe:

```sh
node community-plugins/plugins/analytics/test/architecture/probes/source/node-sqlite-handoff.mjs
```

It creates and removes one small generated SQLite fixture in a temporary
directory. It never opens `bb.storage`, Analytics' real database, BB's
operational database, a network connection, or Wasm. Its parent owns the scratch
directory and removes it even after a killed child; its child has a 10-second
deadline, 2-second post-`SIGKILL` settlement grace, an 8 KiB stdout cap, and a
4 KiB stderr cap. Output contains only generation/count/type summaries, source
hashes, and outcome classes.

On the current Node 22 host, the probe requires the public `node:sqlite`
`DatabaseSync` feature and reports its experimental warning diagnostically. The
fixture writes a WAL database at generation 7 with two synthetic typed fact
rows. A `DatabaseSync(path, { readOnly: true })` reader begins a transaction
and reads state before facts. A separate writer commits generation 8 and a
third row while that reader remains open; the reader continues to observe 7 / 2
until it commits, then observes 8 / 3. A synthetic `INSERT` through the reader
must fail. This is a WAL snapshot and read-only negative control, not a timing,
Wasm, query-execution, or workload claim.

The probe also fingerprints the public `bb.storage.database()` declaration,
the current host implementation, Analytics store/server sources, and installed
better-sqlite3 type/runtime files. The SDK declares an own-plugin WAL database;
the host currently constructs `<dataDir>/plugins/<id>/data.db`. The returned
better-sqlite3 handle exposes `.name`, but a scratch relative-name control shows
that it retains the input representation. A later handoff must therefore use
only the SDK-provided name after validating it is an ordinary filesystem path
and resolving it; it must reject `:memory:`, URI-like names, and any caller
supplied path. It must not reconstruct or access another plugin's, or BB's,
database.

The viable shape is a dedicated child that opens only the validated Analytics
database with `readOnly: true`, executes fixed `BEGIN`, index-state and typed
fact reads, transfers the rows to its query engine, then commits/closes the
SQLite snapshot before query execution. SQLite reads are never authored SQL;
schema/columns remain static and source-owned. Bound child lifetime, transfer
bytes/rows, feature-gating and cleanup remain required. This removes the
main-thread NDJSON serialization and fact-payload IPC hop, not all IPC or the
separate SQL-admission/resource controls.
