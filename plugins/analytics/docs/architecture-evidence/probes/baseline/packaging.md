# Backend native-worker packaging feasibility

Status: **unsupported by current BB plugin policy**. This is a read-only source and artifact inventory, not a runtime failure claim. No addon, worker, SQL query, plugin install, reload, or registration was executed.

## Exact evidence

The replayable [packaging probe](../../../../../test/architecture/probes/baseline/packaging/probe.mjs) reads the current `community-plugins` and materialized BB Git revisions at invocation and records the exact source hashes. It also fails if its required source/package metadata or policy/install assertions are unavailable, rather than reporting an unsupported result from incomplete evidence. Set `ANALYTICS_NODE_API_ROOT` to inspect another existing scratch dependency root; the previous `/tmp/analytics-node-api-4wcSSS` location is only the default.

`build-plugin-server.ts` builds a single `dist/server.js` plus source map and metadata. It bundles ordinary server imports and leaves only the SDK aliases and `better-sqlite3` external. Its contract comment says native dependencies are unsupported in plugins regardless.

The managed install path in `managed-plugin-artifacts.ts` invokes `npm install --ignore-scripts --omit=dev --omit=optional` for git plugins, then deliberately retains `node_modules` because runtime assets may be needed. The runtime loader labels an `ERR_DLOPEN_FAILED` or `.node` load as “native dependencies are not supported in BB plugins.” This is an explicit product boundary, not merely an uncertain bundler outcome.

The supplied scratch dependency tree at `/tmp/analytics-node-api-4wcSSS` is `@duckdb/node-api` `1.5.5-r.4`. It contains:

- `@duckdb/node-bindings` `1.5.5-r.4`, whose Linux x64 binding is an `optionalDependency`;
- `@duckdb/node-bindings-linux-x64/duckdb.node` (its current hash is captured by the probe);
- a CommonJS binding dispatcher that dynamically selects the platform package.

Thus the managed `--omit=optional` path removes the normal platform binding selected by the package. Declaring a platform binding as a non-optional direct dependency might alter that npm outcome for one target, but it would remain outside BB’s native-addon support policy and is not a portable/public contract.

## Worker asset and lifecycle implications

The plugin builder has no generic copy step for an independently spawned worker entry: it only emits the declared server artifact, map, and metadata. A worker file therefore needs an explicit shipped-location contract independent of the server bundle (for example, an already-published dependency or a separately packaged asset). For npm publication, `files` must include that file; for git source installs it remains in the managed root. Neither solves the native-binding policy or optional-binding omission.

Normal Node subprocess APIs are usable code in a community plugin: `machine-monitor/monitor.ts` imports `execFile` from `node:child_process` (the current source hash is captured by the probe). This establishes ordinary Node subprocess use, not a BB-provided process supervisor. The public SDK declares `bb.onDispose()` as the reload/disable/shutdown cleanup point; no public native-worker lifecycle API was found.

## Minimal future contract, if policy changes

A supported design would need all of these before a packaging probe could be promoted to a real worker:

1. A BB-supported native-addon policy and ABI/platform matrix.
2. Managed install behavior that deliberately retains and verifies the matching native platform binding instead of omitting it as optional.
3. A declared, packaged worker-entry location that remains valid from `dist/server.js` for git, npm, path, and builtin layouts.
4. A bounded Node child-process protocol with timeout/output limits and `bb.onDispose()` cleanup; a separate supervisor API is not presently public.

## Probe limits

The supplied scratch directory has a dependency tree but no `package.json` or BB plugin manifest. The task's ban applied to source manifests and shared `node_modules`, not a disposable scratch manifest; therefore this absence is **not** a product defect or a hard build blocker. The probe did not create one because the explicit native-support policy and managed-install assertions already establish the unsupported result, so an unsupported-native build would add no decision-relevant evidence. It intentionally performs no install, build, addon import, worker launch, SQL, plugin registration, or reload.

## Disposable Wasm owned-child fixture (2026-09-08)

The replayable [owned-child probe](../../../../../test/architecture/probes/baseline/packaging/wasm-owned-child-probe.mjs) establishes the narrower non-native packaging path. It creates a `mkdtemp` minimal plugin—not an Analytics copy or deployment—with `files: ["dist/", "query-worker.cjs"]`, a `server.mjs`, and an explicit `query-worker.cjs`. It uses the real source `buildPluginServer` through Bun and creates the scratch `dist/server.js`, source map, and metadata. No service, plugin registration, reload, real data, download, or `npm install` occurs.

The fixture uses a controlled symlink from its own `node_modules/@duckdb/duckdb-wasm` to the existing pinned package root. This is deliberate dependency-fixture evidence, **not** a clean-install or publication proof. The child rejects every resolved DuckDB package/Wasm/worker path unless its real path begins under that controlled root; the observed paths were the expected package exports under `community-plugins/node_modules/@duckdb/duckdb-wasm`. It does not consult a home/global module directory.

Both the source server and its actual `dist/server.js` bundle located the published `query-worker.cjs`, spawned it under a bounded detached process group, and observed child close. Inside that child, the exported Node blocking target resolved the unmodified MVP Wasm and package worker assets, instantiated the bindings, opened with `maximumThreads: 1` and `allowUnsignedExtensions: false`, then set `enable_external_access=false`, `autoinstall_known_extensions=false`, and `autoload_known_extensions=false` before the only data query, `SELECT 1 AS value`. Each returned `1`. This is not a signed-extension/bootstrap proof and it executes no `LOAD`, URL, file, extension, or Analytics-fact operation.

`npm pack --dry-run --json --ignore-scripts` ran with a fixture-only npm cache and listed both `query-worker.cjs` and `dist/server.js`. This demonstrates the proposed `files` path is pack-list visible; it neither publishes a package nor validates installation from that tarball.

The harness bounds build/invocation at 20 seconds, caps outer stdout/stderr at 16 KiB/4 KiB, and uses detached POSIX process groups with `SIGKILL` plus a 250 ms close grace on deadline or cap. The generated server applies a 15-second owned-child deadline and 8 KiB/4 KiB captures with the same group-kill/close-observation behavior. The fixture directory, cache, symlink, manifests, and artifacts are removed in `finally`.
