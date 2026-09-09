# Analytics execution contract

> Policy update — 2026-09-09: the approved [Identities and multiplayer ADR](../../../../docs/adrs/2026-09-identities-and-multiplayer.md)
> governs this trusted shared deployment. Use verified people when available,
> applicable carried attribution next, and a stable machine actor otherwise;
> missing or failed person verification must not block ordinary operations.
> Never relabel fallback as a verified person or redirect pending personal-state
> writes to another owner. Independent access checks and data validation remain.
> Earlier rejection requirements below are superseded; versioned API descriptions
> and test receipts remain historical evidence, not proof of ADR implementation.


execution-contract.ts defines the additive v2 boundary for the Analytics
server, isolated worker, reference service, and their tests. It is not a
client RPC contract and does not change current consumers.

## Authority and admission

The only client-shaped execution input is ExecutionLocator: bundle ID, query
ID, explicit UTC [startInclusiveMs, endExclusiveMs) range, and typed bound
values. It cannot provide SQL, source scope, snapshot metadata, cacheability,
database paths, rows, or coverage.

At the authorized resolver boundary, HostAdmissionGate establishes BB's
current shared, high-trust, equal-information workspace scope. It deliberately
does not create feature-local tenants or per-person data isolation. Where host
identity is configured, the resolver uses the public bb-identity integration
seam; configured identity unavailability or mismatch returns explicit
identity-unavailable or identity-mismatch denial, never a default-user
fallback. Storage repositories remain storage-only.

The resolver creates an ExecutionSnapshot with a frozen endpoint and
host-derived source scope, then resolves an immutable bundle/query definition.
Its ResolvedExecution contains the admitted SQL, AST policy and result
contract revisions, typed values, cacheability, and snapshot. The worker sees
only that resolved input plus a trusted internal source handoff; it never
receives a database path from RPC data.

Before ResolvedExecution exists, ordinary host code calls the locked child with
queryAdmissionRequestSchema: exact SQL, typed parameters, and cacheability.
The child-private scheduler wire may add its own token and limit fields; those
are not this host API. Its QueryAdmissionOutcome is either an existing typed error or an admitted
queryAdmissionAttestationSchema containing astPolicyRevision, astNodeCount,
sqlSha256, parameterDeclarationDigest, and cacheability. The resolver copies
those five attestations into admittedQuerySchema and checks them with
assertAdmittedQueryAttestation before construction.

The child reparses exact SQL on every execution; counts and revisions are never
trusted from an author or fabricated by a caller. sqlSha256Input returns exact
UTF-8 SQL source for trusted host SHA-256 calculation.
parameterDeclarationDigestInput returns canonical name/logicalType declarations,
sorted with strict lexical comparison rather than locale-dependent collation;
the host hashes that string. The shared contract deliberately supplies hash
inputs, not Node-only crypto.

The selected Wasm positional-array bridge does not execute authored named-marker
SQL directly. Inside the locked child, it derives executable positional SQL only
from the admitted AST parameter identifiers/map through trusted
`json_deserialize_sql`, binds values separately, and reparses it for full-tree
equivalence; validated `query_location` offsets alone may differ. The original
SQL and its five-field admission attestation remain immutable and are checked
before this bridge. The derived transform/helper hashes are part of policy
identity, not a changed authored query or attestation. Native JSON numeric
lexeme handling is an internally feature-gated capability, not a portable
contract guarantee.

TrustedSourceHandoff also carries a required positive factProjectionVersion:
the persisted analytics_index_state.fact_projection_version read with the
generation and facts in the trusted source snapshot. It is an integer database
truth for worker comparison. It is deliberately distinct from
projectionRevision, the host-owned code/semantic revision hash carried in
coverage metadata.

## Coverage is not result truncation

SourceCoverage reports a retained projection rather than a claim of complete
source history. It carries candidate/selected/loaded/capped thread counts,
retained facts, source page/event/byte counts, fixed page bounds, safe failures,
coverage mode, explicit incomplete reasons, and an independently incremented
coverageRevision. That revision changes for metadata-only coverage changes even
when fact generation does not.

Population metadata also records the candidate-thread limit, page/event caps,
maximum event bytes, safe failure count, and last safe failure time. These make
the retained population and extraction budget inspectable without exposing raw
source payloads.

Backfill moves newest to oldest. completeRange is the interval that was fully
reconciled; complete-retained-projection is valid only when that range equals
the declared retained interval and no incomplete reason remains.
earliestVerifiedRetainedInclusiveMs is the precise earliest point of that
verified retained interval. A requested range that starts earlier is explicitly
incomplete with range-precedes-earliest-verified-retained; a 90-day picker
never implies complete 90-day source history. Snapshot validation ties coverage
as-of timestamps, retention ordering, and the frozen range together.

Result truncation is entirely separate: canonical result rows, datumKeys,
resultExtent, and resultTruncated report bounded query output only.

## Typed data, cache identity, and records

Canonical columns preserve engine logical distinctions (integer, decimal,
float64, date_utc, and timestamps) even when values use JSON-safe
representations. Decimal text has a strict decimal grammar; finite DuckDB
DOUBLE values remain JSON-number float64 values rather than being relabeled as
decimal. Zod
validates value/type pairs, exact versus lower-bound row counts, matching row
schema, unique datum keys, and exact UTF-8 wire bytes. TextEncoder, not Node
Buffer, keeps this shared schema safe to import from browser-adjacent code.

Physical reuse has one explicit pure input:

    source scope + projection generation/revision + frozen endpoint
    + normalized SQL + AST-policy revision + result-contract revision
    + sorted typed parameters + max rows

canonicalPhysicalCacheKeyInput() serializes that complete identity. A
repository may hash it, but may not omit fields. Bundle/query lineage revisions
remain in each execution record, so physical sharing cannot erase the authored
bundle that caused it. Volatile admitted SQL is volatile-uncacheable, has no
physical key, and cannot be accidentally reused by snapshot identity.

StoredExecutionRecord retains the complete snapshot, immutable bundle/query,
and an array of exact discriminated figure contexts. Each figure carries its
own plotted N-of-M/reduction descriptor, so a table and a reduced chart cannot
share ambiguous plotting metadata. The record validates full query equality
(SQL, values, maximum rows, AST/result policy), every figure field and total
against the canonical result, duplicated lineage/snapshot consistency, creation,
and bounded expiry. Cache eviction is separate from authoritative-record expiry;
a record remains available for reference creation after an in-memory cache entry
disappears. References persist separately with their own bounded retention and
immutable captured context.

The only v2 reference-create input is:

    { executionId, visualizationId, targetDatumKey? }

The backend derives the row, parameters, source scope/snapshot, range, schema,
loader label, formats, table labels, visualization/sibling linkage, and
truncation context from the stored record. The analytics-ref:v2 token suffix
must match its referenceId.

prepareExecutionReference() is the pure future-service seam. Given fresh
host admission, a retained-record lookup outcome, the narrow locator, controlled
time, and an issued ID, it rejects missing/expired records, execution/scope
mismatch, unknown visualizations, and missing datum keys. It derives the
selected row and all capsule context from the stored record. The reference resolver uses current host attribution, including machine fallback;
missing verified-person evidence alone must not block lookup or resolution.
Record, scope, and independent access validation remain required;
storage and RPC effects remain outside this contract node.

Datum keys are deterministic but opaque. They contain the validated immutable
execution-ID suffix plus the bounded canonical row ordinal; no lossy row hash
is used. A physically reused result is therefore rebound to a new execution's
datum keys without rerunning SQL; equal labels, repeated equal rows, and hash
collisions cannot collide.

Existing stored v1 capsules are decoded through
decodeLegacyStoredReferenceCapsule() as legacy-client-lineage with
retroverified false, retaining the entire validated historical capsule payload.
Its decoder honors v1's broader generic identifiers, Unicode strings, and
finite values; it does not fabricate execution verification, relabel the
capsule as v2, or silently replace it with a current bundle.

## Runtime and resource envelope

The selected route is the unmodified pinned @duckdb/duckdb-wasm
1.33.1-dev57.0 in a plugin-owned Node child. Its fixed trusted bootstrap has
external=true only for non-authorable LOAD json, with
unsigned/community/autoinstall/autoload disabled. It sets the database
memory_limit before external=false and lock_configuration=true, then admits
authored SQL through the complete AST policy with bound values only. The
generated Wasm 4 GiB linear-memory maximum, database policy, and process RSS
are different concepts; this contract makes no hard-RSS or OS-sandbox claim.

The provisional executable envelope includes 16 KiB SQL, 4,096 AST nodes, 500
rows, 64 columns, 32,000 cells, 4 MiB canonical result/cache bytes, 24 cache
entries, 32 queued jobs, and 4 MiB aggregate queued resolved-descriptor bytes,
2-second query deadline, 15-second startup deadline,
5-second materialization deadline, 256 MiB database-memory policy, bounded
chunks/rows, a 5-minute idle worker/cache TTL, and bounded record/reference
retention. A successfully captured reference receives its own reference TTL
after the execution record is confirmed current, so it may outlive that record;
an already expired record cannot create a new reference. These values must be measured in the selected worker before
production acceptance. The queued-byte budget is the canonical UTF-8 encoding
of queued resolved metadata, SQL, and bound values only; it excludes source
facts and does not claim a JS-heap or RSS bound. Queue admission rejects either
budget before retaining/enqueueing a descriptor or materializing source handoff
facts.

ExecutionWorkerOutcome has bounded typed errors, and the coordinator gives each
subscriber its own cancellation: leaving one subscriber never cancels a shared
job while another remains. Parent kill/recovery is a separate required
acceptance witness.

Preferred handoff is a feature-gated Node 22 node:sqlite read-only transaction
over only the resolved bb.storage.database().name file: validate
non-memory/non-URI path, read trusted bounded rows under BEGIN, load the
worker, then COMMIT and close before authored SQL. The independent WAL and
runtime proofs are retained as durable evidence under the Analytics architecture
probes and referenced by plans/analytics.ledger.jsonl; this plugin
documentation intentionally contains no operator-specific absolute
thread-storage path. If unavailable, use generation-checked, backpressured
bounded page streaming, final generation validation, and bounded retry. Never
hold a shared SQLite transaction across async work or substitute a whole
main-thread NDJSON/IPC dataset copy.

One-hour freshness is shared and demand-only. Backfill is bounded/resumable;
list omission or source error never deletes facts without confirmed deletion.
