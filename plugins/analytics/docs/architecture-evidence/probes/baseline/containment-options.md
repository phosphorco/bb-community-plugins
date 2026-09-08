# Backend DuckDB containment options (read-only host inventory)

Observed 2026-09-08 on the current BB host. This is an inventory, not a
containment proof: no namespace, cgroup, service, child engine, network, or
capability canary was created or run.

## Source identity and method

The checked `community-plugins` revision is
`7a28e61f1816499cf6b9c6faca4a1f7ab4662e18`. Relevant dirty-tree source
fingerprints are:

| Path | SHA-256 |
| --- | --- |
| `plugins/analytics/package.json` | `4ef6f394c96994e1a0ef9e48e10ecca5301cca44ac592b4fafacd8157d408b30` |
| `plugins/analytics/server.ts` | `46385306b359314295cf8d594ee38fc3603527728bf316f3070211607c6e6fba` |
| `plugins/analytics/browser-engine.ts` | `94ab5c0b9e7d856be4ca384a8eebcd4bd0bb1ff80fb471e735ce935277f8a5d7` |
| `plugins/analytics/types/bb-plugin-sdk.d.ts` | `fa7015f7bd1da3fb6e32597af2bc11e4cdab4588ed6bcff1ebc3dac67d23a75c` |

Only `--help`, `--version`, package/type metadata, local manual pages, and
source search were read. The inspected commands were `node --help`,
`prlimit --help`, `unshare --help`, and `systemd-run --help`; local references
were `getrlimit(2)`, `unshare(1)`, `systemd.resource-control(5)`, and
`systemd.kill(5)`.

## Observed host options

| Facility | Read-only observation | What it could provide | What remains unproven or absent |
| --- | --- | --- | --- |
| Node 22.21.1 permission model | `--permission`, `--allow-fs-read`, `--allow-fs-write`, `--allow-addons`, and `--allow-child-process` appear in `node --help`. | A child launched with a deliberately small Node permission allowlist can deny ordinary Node filesystem APIs outside an explicit read allowlist. | No documented network-deny flag appeared. It is not an OS sandbox, and an engine that is a native addon requires `--allow-addons`; the addon/native allocations need a process resource contract too. The host must own the child invocation flags. |
| `prlimit` (util-linux 2.39.3) | Available at `/usr/bin/prlimit`; help exposes `--as`, `--cpu`, `--nofile`, and `--nproc`. | `RLIMIT_AS` is a hard virtual-address-space limit inherited across `execve`; local `getrlimit(2)` says `brk`, `mmap`, and `mremap` fail with `ENOMEM` over the bound. It therefore covers native allocation address space as well as V8 mappings and can support an explicit **process-memory** contract only if measured virtual headroom fits the accepted cap. `RLIMIT_CPU`, file descriptors, and process count are additional limits. | Local `getrlimit(2)` states `RLIMIT_RSS` only had effect on Linux 2.4.x. The initial Node-API evidence below rules out the proposed 768 MiB AS cap; a later fixed-25k 1.5 GiB AS fit/recovery witness is recorded below. `RLIMIT_AS` is not a current RSS/cgroup limit and may surface as allocation failure rather than a tidy engine error; the supervisor still needs a deadline, exit handling, and fresh-worker recovery. Linux-specific and not portable. |
| cgroup v2 / systemd | `/sys/fs/cgroup` is `cgroup2fs`; controllers include `cpu`, `memory`, and `pids`. The current process belongs to `.../app.slice/bb.service`. `systemd-run` 255 is installed and exposes `--user`, `--scope`, `--wait`, `--collect`, and arbitrary `--property`. Local `systemd.resource-control(5)` documents `MemoryHigh=`, `MemoryMax=`, and `TasksMax=`; `MemoryMax=` is an absolute unit memory limit with in-unit OOM handling. | An **operator-provisioned** transient unit or child scope could apply a cgroup memory ceiling and process-count bound. `systemd.kill(5)` documents `KillMode=control-group` plus timeout-to-`SIGKILL` semantics. | The cgroup mount is `dr-xr-xr-x root root`; this plugin cannot create/delegate a child cgroup directly. User-manager availability, DBus authorization, effective controller delegation, and usable `systemd-run --user` properties were deliberately not tested. |
| `unshare` (util-linux 2.39.3) | Available at `/usr/bin/unshare`; help offers mount, network, PID, user, and cgroup namespaces and `--kill-child`. Local `unshare(1)` documents that a network namespace has independent network stacks/routes and that `--kill-child` with PID namespace can kill the process tree. | With explicitly authorized setup, it could help create a no-network process tree and isolate a restricted filesystem view. | Unprivileged user-namespace policy, required mount/bind setup, and actual network isolation were not tested. It is Linux-only and direct use from a plugin would be an operational capability change. Do not select it from this inventory. |
| Bubblewrap / cgroup helper CLIs | `bwrap`, `cgcreate`, and `cgexec` were not found. | None on this host without a separately authorized dependency/provisioning change. | No portable user-space filesystem/network sandbox is presently observed. |

`plugins/analytics/package.json` currently has DuckDB-Wasm only; no native
DuckDB package is declared. Its public SDK declaration exposes
`threads.spawn(...)`, which creates a BB agent thread, not an operating-system
child process. No SDK-specific child-process supervisor, cgroup API, namespace
API, or native-memory policy was found in the inspected declarations. That is
not a prerequisite gap: the production `machine-monitor/monitor.ts` community
plugin imports `execFile` from `node:child_process`, and its package uses the
ordinary `bb plugin build .` path. This is evidence that Node subprocess code
is ordinary shipped community-plugin code; it does not establish which service
policy, permission flags, or operating-system privileges a future Analytics
worker receives.

## Practical options by threat model

### 1. Authored-SQL containment, not compromised native code

For the declared threat of an untrusted authored query, a separate Node worker
with a bounded IPC protocol can be sufficient without making a cgroup
supervisor a prerequisite, provided all of these independent controls are
implemented and measured. The current Node-API `RLIMIT_AS` observation means a
tight AS-based memory contract is not presently one of those controls:

```text
complete SQL parse/tree validation
  + locked DuckDB external-access/extension configuration
  + curated materialized relation only
  + fixed query wall deadline, queue, rows, result bytes, and IPC payloads
  + process worker with a measured feasible memory envelope, CPU/FD/process limits
  + exit/crash recovery that discards the engine and starts a fresh worker
```

`RLIMIT_AS` is a candidate hard process-memory contract, not an RSS promise.
The newly supplied isolated Node-API fixed-25k observation records
`/proc/self/status` at ready and after setup:

| Phase | VmSize | VmRSS |
| --- | ---: | ---: |
| ready | 1,322,908 kB | 92,296 kB |
| after fixed 25k setup | 1,399,196 kB | 96,128 kB |

The proposed formula, `2 × observed VmSize + 128 MiB`, yields
`2,999,771,136` bytes (about 2.79 GiB), already above the proposed 768 MiB
cap. No AS-limited child was run. Thus `RLIMIT_AS` is currently impractical as
the bounded-cap process-memory contract for this Node-API fixture: setting a
ceiling near 768 MiB would fail before useful work, while accepting roughly
3 GiB would not supply the intended tight bound. This is neither an RSS result
nor intermediate-work, filesystem, network, cgroup, delegation, or portability
containment evidence.

**Superseding update (2026-09-08).** The preceding paragraph preserves the
initial 768 MiB feasibility calculation and the fact that *that* cap was never
attempted. A later isolated fixed-25k Node-API witness did run under observed
soft=hard `RLIMIT_AS=1,610,612,736` bytes (1.5 GiB) and `RLIMIT_CPU=5`, then a
fresh child under the same limits recovered successfully. It supersedes only
the earlier “no AS-limited child was run” status. It does not make 768 MiB
viable, prove an RSS bound, establish an intermediate-work limit, or qualify
native packaging/portability. See the runtime feasibility report referenced by
the plan ledger and the packaging finding in
[`packaging.md`](packaging.md).
The worker receives only validated SQL, typed bound parameters, a trusted
snapshot reference, and fixed result limits; it does not receive a shell or
arbitrary executable path. Node permission flags may narrow ordinary Node
filesystem operations, but a native addon requires `--allow-addons` and should
not be treated as a Node-permission security boundary.

### 2. Arbitrary compromised-native-code containment

If native addon compromise itself is in scope, the first option is insufficient:
complete SQL validation, DuckDB flags, Node permissions, and `RLIMIT_AS` do not
confine arbitrary native filesystem or socket syscalls. A stronger Linux option
is an operator-owned supervisor/scope that launches one query worker per
bounded engine instance:

```text
BB Analytics server
  -> narrow IPC request/result protocol, bounded input/output
  -> operator-provisioned Linux service/scope
       -> cgroup v2: MemoryHigh + MemoryMax + TasksMax
       -> tree kill: KillMode=control-group, timeout then SIGKILL
       -> process: Node permission allowlist plus a fixed worker entrypoint
            -> native DuckDB addon, if packaging accepts it
```

Here, a cgroup `MemoryHigh`/`MemoryMax`/`TasksMax` policy is stronger resource
isolation than `RLIMIT_AS`, and `KillMode=control-group` provides a process-tree
recovery primitive. It is an optional operator expansion, not a conclusion that
the Analytics plugin must create cgroups. Filesystem and network isolation still
require an OS policy: a narrowly mounted/staged worker/addon view and an
operator-reviewed network policy (for example an authorized managed namespace
or firewall rule). The observed host cannot yet prove either one.

On timeout, protocol violation, memory pressure/oom exit, or worker crash, the
supervisor must stop the whole worker control group, discard in-memory engine
and partial result state, record a bounded redacted failure, and start a fresh
worker only under a bounded retry/backoff policy. A next-query-success test is
still required; a bare `child.kill(pid)` does not prove that descendants or
native work have stopped.

## Remaining feasibility decisions

1. **Choose and document the threat model.** The authored-SQL lane needs the
   parser/engine/process controls above. An arbitrary-native-code threat adds
   operating-system filesystem/network sandboxing and may justify an
   operator-managed cgroup scope.
2. **Bound the process-memory contract.** The fixed-25k Node-API child has
   1,399,196 kB VmSize after setup, making the proposed 768 MiB `RLIMIT_AS`
   contract impractical. A later 1.5 GiB AS/5-second CPU fixed-fixture run and
   same-limit fresh-child recovery passed, but this is a narrow virtual-address
   envelope, not a general RSS/intermediate-work result or an owner SLA. A
   cgroup RSS/`MemoryMax` policy is stronger but currently an optional unproven
   expansion.
3. **Filesystem/network isolation remains unproven when it is required.**
   Bubblewrap is absent; `unshare` is only a candidate and has no permission or
   bind-mount/network proof. Node permission flags do not replace this layer.
4. **Native packaging is disqualified under current plugin policy.** The
   packaging probe records the builder/runtime native-addon prohibition and
   managed optional-dependency omission in [`packaging.md`](packaging.md).
   The 1.5 GiB fixture/recovery evidence does not override that policy boundary.
5. **Portability is unresolved.** `prlimit`, cgroup v2, systemd properties, and
   `unshare` are Linux-specific. A backend contract needs a separately measured
   fallback or an explicit unsupported-platform admission rule.
6. **Engine policy is not containment.** DuckDB extension/configuration flags,
   SQL validation, row caps, and deadlines remain necessary query-policy
   controls. They do not enforce filesystem/network isolation, RSS bounds, or
   process-tree recovery.

Accordingly, native DuckDB is packaging-disqualified under the current plugin
policy, while DuckDB-Wasm remains unselected pending its separate bootstrap,
asset-path, parser, and measured-envelope evidence. The initial 768 MiB
`RLIMIT_AS` worker contract is infeasible for the observed Node-API virtual
reservation; the later fixed 1.5 GiB fit/recovery witness is narrower and does
not change that conclusion. Additional operator/OS requirements remain scoped
only to the stronger compromised-native-code threat model.

## DuckDB-Wasm backend addendum (read-only, 2026-09-08)

This addendum inspects the pinned installed `@duckdb/duckdb-wasm`
`1.33.1-dev57.0` package only; it does not instantiate an engine, download an
asset, start a worker, or run SQL. Its package manifest hash is
`ac5e825ed8e1496e0ac39c8dbaf15dda7c743d5658531fabdc3d3f2821c0ed52`.
The Node EH worker bundle and source map are
`632b3d1f318bfb33aee886a2c583f83090bd2c743b1c2709024ef46b37cbd02e` and
`34c8a42f95ebc61658ab502a5cffab258c70f32d9279329870f7953caf1593fc`.

### Four distinct bounds

| Control | What inspected source supports | What it does not establish |
| --- | --- | --- |
| Wasm linear-memory maximum | Embedded `src/bindings/duckdb-eh.js` (hash `1b2b75fcb94f6ad085a952321f943d8c304c10ce1857e16a8b764a57df5d5c17`) uses `Module.wasmMemory` when supplied; otherwise it creates `WebAssembly.Memory` with 16 MiB initial memory (256 pages) and a 65,536-page maximum (4 GiB). | This is an internal generated-module option, not public `AsyncDuckDB`/Node API, and no smaller cap was instantiated or workload-tested. |
| DuckDB memory setting | A query child can make an accepted SQL-level `memory_limit` setting part of its own startup/query policy after engine startup. | This is a database allocation policy, not a cap on Wasm linear memory, JavaScript/Arrow/result allocations, startup, or a non-cooperating loop. The pinned public `DuckDBConfig` declaration has no memory-limit field. |
| Protocol/result cap | A plugin-owned child can reject overlarge request payloads and stop serializing at a bounded row/byte result envelope. | It cannot retroactively reclaim allocations already made inside the engine or Arrow conversion. |
| Parent deadline + kill/recovery | Ordinary Node child-process use, already demonstrated by `machine-monitor`, can provide each query child a wall deadline, bounded incremental stdout/stderr/IPC capture, process-group kill, and fresh-next-child recovery. | This is recovery containment, not a measured resident-memory ceiling or substitute for SQL admission. |

The least-complex defensible arrangement is layered: complete SQL admission
before dispatch; a fresh plugin-owned Node query child for bounded work; an
engine `memory_limit` only as a second-level database policy; request/result
byte caps at the child protocol; and parent kill/recovery on deadline, failure,
or protocol overrun. A smaller Wasm linear-memory maximum is an additional
control only after a supported public construction path and a measured safe
floor are established. No 768 MiB or other process/linear-memory SLA follows
from this inspection.

### Public API boundary for smaller `wasmMemory`

Public `AsyncDuckDB.instantiate` accepts `(mainModuleURL, pthreadWorkerURL?,
progress?)`, with no module-overrides or memory argument. The public Node
factory returns `DuckDBNodeBindings`, whose `instantiateImpl(moduleOverrides)`
and `instantiateWasm(...)` are declared `protected`. The concrete EH binding
invokes generated `DuckDBWasm({... instantiateWasm, locateFile})`, but that
factory is an internal source-map module rather than an exported package
subpath. A consumer can subclass a public protected seam in TypeScript, but
cannot supply `wasmMemory` through a supported public factory without
copying/vendoring or deep-importing generated glue. This is a concrete
public-API gap, not evidence that a custom cap is impossible.

### Packaging an owned query child

Wasm is a normal JavaScript dependency here, not a `.node` addon: the package
publishes `dist/duckdb-node.cjs`, EH/MVP worker scripts, and `.wasm` assets in
its `files` list. That avoids the native-addon policy which disqualified the
node-api route. But BB `buildPluginServer` bundles one declared server entry
into `dist/server.js` and emits only that file, map, and metadata (current
source hash `2dab4cddb19ea2cbe532ec8eaccfbc8634e90170ba36a95996e7d246caed47c1`);
it has no general copy rule for a plugin-owned query-child entry.

The plausible default packaging route is consequently an explicitly published
plugin asset, for example `query-worker.cjs` in the plugin package `files` list,
spawned with `process.execPath` by the bundled server—not an external
runtime/service. The managed-install source intentionally retains `node_modules`
for runtime assets; a git install retains its managed root too. An npm package
must ship that worker asset and declare `@duckdb/duckdb-wasm` in `dependencies`.
The worker can use `require.resolve` against the package's exported
Node/worker/Wasm paths from that retained dependency tree. This is a plausible
ordinary Node/package layout, not an SDK gap. An actual source-path and
`dist/server.js` layout test remains pending before it is called portable.

No backend runtime is selected by this addendum. The signed-extension/bootstrap
question, exact asset-path handling, SQL parser completeness, measured Wasm
floor, and child timeout/recovery witnesses remain separate evidence.
