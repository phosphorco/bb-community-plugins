# Enforced analytics execution envelope

Production execution is fail-closed until a launcher can prove a snapshot-only,
pre-execution operating-system isolation boundary. The historical DB-path
SQLite/Wasm runtime and semantic bundle verifier are retained solely under
`test/probes/`; production `query-runtime/index.mjs` and
`analytics-verifier.ts` do not import or expose them. This is a source/import
boundary test, not evidence that a published or emitted artifact excludes test
files; package composition remains an integration/release responsibility.

`execution-service.ts` is the integration seam for ordinary Analytics query
execution. It accepts a collector-owned `analytics-snapshot-v1` DTO only. The
DTO contains curated facts, scope, generation, bounded size/count, digest and
coverage; it must not contain a database path, SDK, host RPC, URL, callback or
other ambient authority.

Before it leases or reads a snapshot, the service calls a deployment-owned
isolation gate. A missing/failed gate returns `isolation-unavailable`; there is
no fallback to a Node heap flag, a cooperative timeout, a read-only operational
database, or an unrestricted child process. The worker receives only the
immutable snapshot and the resolver-created execution descriptor.

`query-runtime/isolation-policy.mjs` validates a Linux Bubblewrap/cgroup-v2
envelope, including reviewed CPU, memory, pids and I/O values, but **does not
launch a production child**. Node's ordinary spawn-then-attach sequence has a
pre-cgroup execution race and cannot prove IPC survives the namespace change,
so this adapter fails closed even when files appear configured. A qualified
platform launcher must create cgroup/namespace before exec, expose only the
worker runtime artifact and fixed read-only snapshot mount, deny network, and
return observed child/exit evidence. Until then it is unavailable, not a
deployment fallback.

The service uses one process-wide scheduler per platform key. Its active,
queued-count and queued-byte budgets are not multiplied by runtimes/features.
Round-robin runtime lanes prevent a busy runtime from continually jumping the
queue. Physical cache/in-flight keys are supplied by the resolver and must
include trusted source scope, snapshot generation and digest, frozen range,
query/policy versions, typed parameters and result cap. Values with a changed
scope or generation never share results.

That singleton is deliberately only an **in-process** admission boundary. It
does not coordinate multiple plugin processes, reloads, or machines. A normal
deployment must bind every execution process to one deployment-owned cgroup
budget (or use a single service) before claiming an aggregate machine-wide
limit. A process restart loses the in-memory cache/queue and must not be
presented as cache continuity.

Subscriber cancellation is passed to the worker but cannot free the global
slot or release the snapshot lease until worker execution actually settles.
Production child exit/recovery confirmation therefore remains an integration
requirement, not an observer event or kill request.

The unit tests use fakes solely to prove contract handling (rejection of absent
controls, queue accounting, cancellation ownership). They are not OS-isolation
qualification. Qualification must run the real deployment launcher on hardware
and retain evidence of pre-exec namespace/cgroup placement, membership and
subtree termination behavior.

Integration requirements:

- Use `createExecutionService`, not the legacy probe-only `createQueryRuntime`.
- Adapt the collector's `readSnapshot` / retain / release lifecycle to
  `AnalyticsSnapshotProvider`.
- Map resolver-created `ResolvedExecution` to the service's `Resolved` generic
  and compute the complete physical identity key in the parent-owned contract.
- Construct `IsolationGate` only from `createLinuxIsolatedLauncher` (or an
  equivalent reviewed platform adapter); no test launcher may be wired in a
  production entrypoint.
- Do not expose this source until the parent verifies source, launcher and RPC
  composition. Analytics remains disabled on the current host.
