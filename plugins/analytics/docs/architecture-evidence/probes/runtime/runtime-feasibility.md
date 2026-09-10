# Runtime feasibility probe — preliminary, bounded evidence

Status: **no runtime selected**. This report distinguishes historical
observations made before scratch containment was corrected from the subsequent
approved scratch-contained batch and static source inspection.

## Scope and source identity

- Workspace revision: `6f81549c1621ecf2a7334acf602ecde7449d9d25`
- `community-plugins` revision: `7a28e61f1816499cf6b9c6faca4a1f7ab4662e18`
- Engine fixture: exactly 25,000 generated, non-sensitive fact rows; aggregate
  outputs only; one child engine at a time.
- Installed Wasm package: `@duckdb/duckdb-wasm` `1.33.1-dev57.0`, already in
  Analytics production `dependencies`.
- Native package was absent from the shared community dependency graph. A
  disposable `/tmp/analytics-native-duckdb-KHAczr` probe sandbox installed
  `duckdb` `1.4.4` with declared dependencies `@mapbox/node-pre-gyp` `^2.0.0`,
  `node-addon-api` `^7.0.0`, and `node-gyp` `^9.4.1`. This is not community
  package-install evidence and did not modify any shared manifest or
  `node_modules` tree.

Relevant dirty-source fingerprints at measurement time:

| Path | SHA-256 |
| --- | --- |
| `plugins/analytics/package.json` | `4ef6f394c96994e1a0ef9e48e10ecca5301cca44ac592b4fafacd8157d408b30` |
| `plugins/analytics/browser-engine.ts` | `94ab5c0b9e7d856be4ca384a8eebcd4bd0bb1ff80fb471e735ce935277f8a5d7` |
| `plugins/analytics/analytics-verifier.ts` | `5bc1fe371334dd8e21f244319517716ad04fea6c4b23ac8734524127bbac0540` |
| `plugins/analytics/sql-policy.ts` | `10ecf53e1e02ed4db148add0e57f1e1642eb86be10e8606ad895948ca3fe226e` |
| `plugins/analytics/builtin-bundles.ts` | `041f5ce4fbd0dd2edba12baaefd080367ea1fc83b88fc17b35f69d87a88fae5f` |

## Pre-containment measurements

These values are diagnostic measurements, not performance budgets. Cold and
warm are independent process starts, so the inner seven prepared-query samples
are the only same-engine warm samples.

| Engine | Startup ms | Materialize 25k ms | Prepared-query median ms | RSS at final measurement | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| DuckDB-Wasm `1.33.1-dev57.0` | 522.2–533.3 | 27.2–27.9 | 1.94–2.65 | 292–298 MiB | prepared query and CTE/window control observed |
| Native `duckdb` `1.4.4` | 0.26–0.30 | 13.9–13.9 | 1.95–1.98 | 106–123 MiB | prepared query and CTE/window control observed |

The recorded RSS is a single end-of-measurement sample, **not peak RSS**.
Neither engine has a verified hard memory cap. Both accepted
`SET memory_limit = '16MB'`; that is an engine setting, not an OS process or
cgroup limit and cannot contain JavaScript/Wasm allocations or all intermediate
work by itself.

Each dedicated child was externally killed after a deadline and a fresh child
then completed the small query control. This only demonstrates process kill and
fresh-process recovery; it does not demonstrate cooperative cancellation, prove
that the killed query had begun executing, or make a process a filesystem or
network sandbox. The corrected harness now records a separate startup guard and
only arms the query deadline after a query-dispatch handshake.

## Approved scratch-contained batch

The corrected batch used a fresh scratch working directory for every child and
an explicit child-only `PATH`, `LANG`, HOME/XDG/temp and extension-directory
environment. It set `maximumThreads: 1` for Wasm and `threads=1` for native;
it disabled extension auto-install/auto-load and external access before the
fixed SQL. It made no URL, `LOAD`, `INSTALL`, extension, catalog, or file
capability call.

| Engine | usable-ready startup ms | Materialize 25k ms | prepared warm median ms | final RSS sample | Fixed parser-tree control |
| --- | ---: | ---: | ---: | ---: | --- |
| DuckDB-Wasm `1.33.1-dev57.0` | 527.9–542.8 | 20.5–21.2 | 2.00–2.51 | 296–307 MiB | **unsupported**: `json_serialize_sql` absent with auto-load/install disabled |
| Native `duckdb` `1.4.4` sandbox | 9.08–10.21 | 3.77–3.91 | 1.24–1.26 | 93.5–93.8 MiB | **observed**: parsed JSON had `error=false`, one statement, and an object `node` |

For native, usable-ready startup includes completion of a fixed `SELECT 1`;
it is not merely `Database` constructor time. Both engines observed the fixed
prepared and CTE/window queries, accepted the 16 MiB engine memory setting,
and recovered through a fresh process after a child received `SIGKILL` 1.5
seconds after a query-dispatch handshake. The last item remains process-boundary
recovery evidence only: it neither proves cooperative engine cancellation nor
confirms query progress after dispatch.

The Wasm serializer absence is an explicit unsupported result under the safe
configuration, rather than a defect reproduction. Enabling the suggested
`INSTALL`/`LOAD` route was intentionally not attempted. The native result only
establishes one serialized `SELECT 1` shape; it is not complete public-grammar
validation or authorization to execute arbitrary serialized SQL.

## Address-space feasibility follow-on

The current `@duckdb/node-api` `1.5.5-r.4` scratch child additionally observed
`VmSize`/`VmRSS` from its own `/proc/self/status`, with no address-space limit:

| Stage | VmSize | VmRSS |
| --- | ---: | ---: |
| ready | 1,322,908 KiB | 92,296 KiB |
| after fixed 25k setup | 1,399,196 KiB | 96,128 KiB |

The child reported unlimited CPU and address-space limits in
`/proc/self/limits`, exited `0`, and validated `json_serialize_sql('SELECT 1')`
as `error=false`, exactly one statement, with `node.type = SELECT_NODE`.

The approved candidate rule was twice the post-setup virtual size plus 128 MiB:
`2,999,771,136` bytes (about 2.79 GiB). It exceeds the 768 MiB safety cap, so
no `prlimit --as` child was run. This is evidence that a practical bounded
RLIMIT_AS envelope was not established at that cap because of baseline virtual
reservations. It is neither an RSS claim nor a test of intermediate query
memory, and it does not justify raising the cap or running an allocation-limit
control.

Node `v22.21.1` exposes `--jitless`, `--max-old-space-size`, and
`--max-semi-space-size`. A second fixed native-only child used exactly
`--jitless --max-old-space-size=64 --max-semi-space-size=4`; it completed the
same 25k fixture and `SELECT_NODE` parser controls with startup 10.66 ms,
setup 4.55 ms, and prepared-query median 1.92 ms (baseline 10.72/5.09/1.95
ms). Its ready/post-setup VmSize/VmRSS were 804,724/84,424 KiB and
881,400/88,264 KiB. This materially lowers virtual reservation, but the same
candidate rule remains 1,939,324,928 bytes (about 1.81 GiB), still above 768
MiB. The only stderr was Node warning that jitless disables `--expose_wasm`,
which does not affect this native binding. No address-space-limited child ran.

A later approved fixed-fixture check set both soft and hard `RLIMIT_AS` to
1,610,612,736 bytes (1.5 GiB) and both CPU limits to 5 seconds, while retaining
the jitless 64/4 MiB V8 flags. It passed with effective child limits reported
as `1610612736` address-space bytes and `5` CPU seconds; ready/setup
VmSize/VmRSS were 798,572/84,480 KiB and 875,252/88,312 KiB. Bound parameters,
the fixed `SELECT_NODE` serialization, and CTE/window controls passed; the
child exited 0 with no signal. A fresh same-limit child also exited 0 with the
same reported limits and fixed controls. This establishes only that the named
fixed workload fits that particular total-address-space envelope. It is not an
RSS target, general intermediate-memory proof, or a product constraint.

## Parser-only compatibility control

The current node API supports passing SQL text as bound data to
`json_serialize_sql(CAST(? AS VARCHAR))`; serializer input was never executed
as SQL. The bounded run covered all 11 SQL strings from the current
`builtin-bundles.ts` (identified by SHA-256 in returned evidence) plus five
fixed constants for nested catalog, `range`, comma-join, CTE, and named-parameter
shapes. All 16 inputs produced exactly one non-error statement with
`node.type = SELECT_NODE`.

The report records structural paths and node families only—no supplied SQL,
full AST, rows, or query results. It positively found a `BASE_TABLE` with
`schema_name = information_schema` and `table_name = tables` beneath the nested
shape; a `TABLE_FUNCTION` whose nested function name is `range`; and the
`VALUE_PARAMETER` identifier `range_days`. This establishes JSON-tree
traversability for these current shapes, not a complete grammar, a validator,
or a security acceptance decision.

## Incident: extension and network capability control

The pre-containment negative control attempted:

```sql
LOAD httpfs
SELECT count(*) AS n FROM read_csv_auto('https://invalid.invalid/runtime-probe.csv')
```

Wasm accepted `LOAD httpfs`; the URL control returned an HTTP GET error with an
HTTP 404 for `invalid.invalid`. That is evidence that the engine entered an
HTTP path, not evidence of a safe denial. A read-only `stat` on the exact
suspected operator-state path found a 25,044,926-byte regular file at
`/home/ubuntu/.duckdb/extensions/v1.4.4/linux_amd64/httpfs.duckdb_extension`,
modified `2026-09-08 09:28:03.285414588 -0400`. The timing aligns with the
probe but does not prove that probe caused creation. It is operator-owned state
and was neither inspected for contents nor changed or removed.

No URL, `LOAD`, `INSTALL`, extension, catalog, or file capability test remains
in the corrected rerunnable batch. A future public SQL lane must reject these
paths from a complete parse tree before engine execution; this observation is
not a claim that configuration or a child process creates a sandbox.

## Parser/tree and containment findings

The legacy native binding and Wasm blocking public JavaScript surfaces expose
query/prepare APIs but not a direct JavaScript AST method. Static inspection
does **not** establish parser absence: both the Wasm artifact and the installed
native `1.4.4` source contain `json_serialize_sql` and
`json_deserialize_sql`; the native source registers them as JSON scalar
functions. In the contained batch, native serialized and structurally validated
the fixed `SELECT 1`; Wasm could not expose that function without the disabled
JSON extension autoload/install path. Their exact emitted-tree compatibility,
version stability, and complete traversal still require public-grammar and
adversarial tests.

The modern native candidate is `@duckdb/node-api` `1.5.5-r.4`, which declares
`@duckdb/node-bindings` `1.5.5-r.4`. It was installed only into the disposable
scratch sandbox and exercised by the fixed probes above; it remains **not** a
community-plugin packaging proof. The current managed package-install policy
omits optional dependencies, while the platform binding is optional, and the
plugin loader currently rejects native dependencies (separate baseline packaging
evidence).

Realistic hard filesystem/network/memory containment therefore remains
**unsupported** for both candidates in a community-plugin-only deployment.
Scratch `cwd`, HOME/XDG/temp/extension paths, disabled auto-install/auto-load,
and `enable_external_access=false` are hygiene and defense in depth. They are
not a substitute for host-level policy such as an appropriately delegated
service account, filesystem namespace/mount policy, egress policy, and cgroup
memory enforcement.

## Corrected rerun contract

`test/architecture/probes/runtime/probe.mjs` runs each child with a fresh
scratch `cwd` and only an explicit `PATH`, `LANG`, scratch HOME/XDG/temp, and
scratch extension directory. It bounds captured stdout/stderr, cleans scratch
once, has a distinct startup timeout, and requires a query-dispatch handshake
before the hard deadline. The next approved batch is restricted to fixed finite
synthetic aggregate, prepared, CTE/window, and deadline queries. It performs no
URLs, extensions, installs, catalog calls, or file canaries.

The current probe artifact hashes are:

| Artifact | SHA-256 |
| --- | --- |
| `test/architecture/probes/runtime/probe.mjs` | `b96a1d282e3b2727153a2af06bcfa75758c8a5c1e74fd2f52b661efcf2780ecb` |
| `test/architecture/probes/runtime/engine-child.cjs` | `50636db2b4c96297aedd41cd6c3e0868bbd6069bf2cc7fda30b7e3cb0c449749` |

Future approved reruns only:

```sh
node community-plugins/plugins/analytics/test/architecture/probes/runtime/probe.mjs
ANALYTICS_NATIVE_DUCKDB_ROOT=/tmp/analytics-native-duckdb-KHAczr \
  node community-plugins/plugins/analytics/test/architecture/probes/runtime/probe.mjs
```

The native command requires an independently prepared disposable sandbox; its
absence must be reported as unsupported, never as native success.

Scratch-only current-node-api setup (never run in the shared plugin tree):

```sh
scratch=$(mktemp -d /tmp/analytics-node-api-XXXXXX)
mkdir -p "$scratch/npm-cache"
env HOME="$scratch/home" XDG_CACHE_HOME="$scratch/xdg-cache" npm_config_cache="$scratch/npm-cache" \
  /home/ubuntu/.local/share/mise/installs/node/22.21.1/bin/npm install --prefix "$scratch" --no-save @duckdb/node-api@1.5.5-r.4
ANALYTICS_NODE_API_ROOT="$scratch" ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY=node-api-as1536 \
  node test/architecture/probes/runtime/probe.mjs
```

`runProbe()` emits exact workspace/plugin revisions plus SHA-256 identities for
the relevant analytics sources, including `builtin-bundles.ts`; narrow modes
emit their controls and source identity instead of relying on prose alone.

## Wasm JSON-extension bootstrap route — source-only investigation

This is a **potential trusted-bootstrap mechanism**, not an approved execution
route or an assertion that it satisfies the authored-SQL boundary. The official
[DuckDB-Wasm extension documentation](https://duckdb.org/docs/current/clients/wasm/extensions)
states that a Wasm extension is a dynamically loaded Wasm file with a
`duckdb_signature` custom section; `LOAD` fetches, verifies, and loads it with
Emscripten's `dlopen`. It also documents the supported mirror setting:

```sql
SET custom_extension_repository = 'https://trusted-plugin-origin.example/assets/duckdb-extensions';
LOAD json;
```

For a named Wasm extension, the documented repository layout is:

```text
<repository>/duckdb-wasm/<duckdb_version_hash>/<duckdb_platform>/json.duckdb_extension.wasm
```

The custom endpoint must be CORS-readable in a browser. The official deployment
guide explicitly permits mirroring signed extensions for an internal or
air-gapped deployment; copying a core-signed binary does not invalidate its
signature. Core/community/unsigned are distinct signature policies, and the
default requires a core or community signature; `allow_unsigned_extensions`
must remain false. Binary compatibility is tied to the exact DuckDB version and
platform, per the [extension distribution documentation](https://duckdb.org/docs/current/extensions/extension_distribution).

The smallest documented route is therefore a plugin-owned, same-origin (or
CORS-enabled) static mirror containing one official, core-signed JSON Wasm
extension for the exact instantiated engine hash/platform, with an independently
recorded asset hash and provenance. It must use trusted bootstrap SQL before
any authored statement. The documented sequencing to evaluate in a future
controlled test is: configure the pinned custom repository; explicitly
`LOAD json`; then disable autoinstall and autoload, disable community
extensions, set `enable_external_access = false`, and set
`lock_configuration = true` before the authored-SQL connection is exposed.
DuckDB permits turning external access off on a running database but not turning
it back on; configuration locking prevents subsequent setting changes (apart
from the documented always-allowed schema/search-path settings).

The installed `@duckdb/duckdb-wasm` `1.33.1-dev57.0` package contains its three
main engine modules and workers but no JSON extension asset. Its public TypeScript
surface includes `allowUnsignedExtensions`, `registerFileURL`, and
`registerFileBuffer`, but not a typed custom-extension-repository field. Those
file-registration calls are documented for query data ingestion, not extension
loading. Static inspection of the package's generated worker finds an internal
`runtime.whereToLoad` URL callback before the extension fetch. It is absent from
the public TypeScript surface, so it is not a supported substitute for the
documented repository configuration. The Node worker branch also contains a
`~/.duckdb/extensions` cache path; any future Node-only bootstrap proof must
retain the already-established scratch-only HOME/XDG isolation and must account
for that cache. A bundled DuckDB `1.4.4` source snapshot compiled with
`WASM_LOADABLE_EXTENSIONS` likewise builds a `*.duckdb_extension.wasm` URL and
uses synchronous XHR into Emscripten's filesystem before `dlopen`; it is not
source-identical to this dev Wasm package and cannot prove current behavior.

Accordingly, the following remain **unestablished** without a separately
approved, no-network controlled proof: the exact version hash/platform expected
by this installed package; availability and provenance of a matching signed JSON
asset; whether the package's public runtime can set the repository without an
authored-SQL escape; and whether a registered local buffer can replace the
documented URL fetch. Nothing in this investigation treats a missing npm asset,
an absent JS-specific extension API, or this possible bootstrap route as a
runtime selection. Even after that route is proven, DuckDB settings are
defense-in-depth rather than OS/network sandbox proof; the official security
guidance calls for OS/container sandboxing when SQL is untrusted.

### Exact-build acquisition control

The approved metadata-only Wasm child subsequently observed package
`1.33.1-dev57.0`, DuckDB library `v1.5.4`, source ID `08e34c447b`, and platform
`wasm_eh` in 702 ms. An earlier bounded (10 seconds, 16 MiB maximum, identity
encoding) request used the **source ID** in the documented path:

```text
https://extensions.duckdb.org/duckdb-wasm/08e34c447b/wasm_eh/json.duckdb_extension.wasm
```

The official endpoint returned HTTP 404. It did not try a version alias, a
different platform, a latest artifact, another repository, or an
unsigned/community artifact. No loopback server was started, no asset was
retained, and no `LOAD`, `INSTALL`, or authored/capability SQL was executed.

That URL was **not established as the exact build's URL**. The DuckDB v1.5.4
[extension helper source](https://raw.githubusercontent.com/duckdb/duckdb/v1.5.4/src/main/extension/extension_install.cpp)
gives `DUCKDB_WASM_VERSION` priority over both the release-library-version and
development-source-ID fallbacks; it then substitutes that result into the
extension URL template. The DuckDB-Wasm
[build script](https://raw.githubusercontent.com/duckdb/duckdb-wasm/main/scripts/wasm_build_lib.sh)
always passes that CMake definition, using the build environment's
`DUCKDB_WASM_VERSION` or `unknown` when absent. Static inspection of this
pinned `duckdb-eh.wasm` (SHA-256
`3abdec74989dcc54d2f2ea5621f611f3c45db1e7dff2f408476014d82beb2029`) found
the observed source ID, library version, and platform but no authoritative
embedded value for that compile-time definition. The npm package has no
`gitHead` or build-manifest mapping it to that environment value.

Therefore the 404 is retained as an incident/provenance datum only; it is not
an unsupported exact-build result and does not rule out a signed offline JSON
route. A further test must first establish the compiled directory name from an
authoritative package-build record or an explicitly approved, contained runtime
error/control path. Until then, no proposed artifact URL exists and no further
remote URL, loopback server, `LOAD`, or artifact download is permitted.

An independent exploratory `HEAD` request to the release-directory candidate
`https://extensions.duckdb.org/duckdb-wasm/v1.5.4/wasm_eh/json.duckdb_extension.wasm`
also returned HTTP 404. It is an incident datum only: the Wasm compile-time
directory override was still unresolved, so neither candidate is a proven
mapping.

### Contained runtime directory-mapping controls

The approved metadata-only child ran the fixed engine query
`SELECT extension_name, install_path FROM duckdb_extensions() WHERE
extension_name = 'json'` after setting `autoinstall_known_extensions = false`,
`autoload_known_extensions = false`, and `enable_external_access = false`. It
completed in 692.5 ms with one `json` row, but its `install_path` was the empty
string. This is an observed metadata control, not a version-directory result;
it disclosed no path and did not execute an extension, load a URL, or touch
non-scratch filesystem state.

The DuckDB v1.5.4
[extension load source](https://raw.githubusercontent.com/duckdb/duckdb/v1.5.4/src/main/extension/extension_load.cpp)
shows that the generated callback's first string is the extension filename and
its second string is the final URL. Accordingly, a scratch-only diagnostic
cloned the pinned `dist/duckdb-node-blocking.cjs` and, only after asserting two
exact generated-callback occurrences, changed the two calls from
`whereToLoad($0)` to `whereToLoad($0, $1)`. The original loader SHA-256 was
`3316baf528f80bf2564577d81ea107afc1031fa55f27c2e845ee04b47602ffbb`; the
scratch clone SHA-256 was
`b271b7dda2fd67f9267baf845dfde575d31c664b16336eef55b873c7fdb7fda8`; the
original was rehashed unchanged after the child exited.

The first child attempt stopped before `LOAD` because its settings predicate
incorrectly expected strings rather than the observed Boolean values. The
second retained the exact required values (`false`, `false`, `false`, `true`)
for autoinstall, autoload, community extensions, and temporary external access,
but `LOAD json` returned without invoking the patched callback: zero hook calls,
no sentinel error, and no resolved URL. This is a **failure of the
deny-before-I/O mapping instrument**, not evidence of a mapped directory, no
network I/O, or no extension execution. No additional attempt is authorized.
The clone and its callback are diagnostic-only, not a production design or
evidence that the unmodified package supports a two-argument hook.

The former automatic source-ID bootstrap fetch path is disabled fail-closed in
the probe entrypoint. It returns `unsupported` until an authoritative resolved
directory and explicitly approved exact artifact URL are available.

### Approved unmodified trusted JSON bootstrap

One subsequent unmodified pinned-Wasm child was explicitly approved to use the
engine's default official core JSON bootstrap. It ran with one child and a
20-second startup/load deadline, no custom repository, server, fallback
package, or arbitrary SQL. Before the fixed `LOAD json`, the child verified
`autoinstall_known_extensions = false`, `autoload_known_extensions = false`,
`allow_community_extensions = false`, and `allow_unsigned_extensions = false`;
external access was temporarily `true` only for that trusted core load.

`duckdb_extensions()` reported JSON as `installed = false`, `loaded = false`,
and an empty `install_path` before the load. `LOAD json` returned zero rows
without an error. The child then disabled external access, set
`lock_configuration = true`, and verified both settings plus the preceding
false settings. Afterward, JSON was `installed = false`, `loaded = true`, still
with an empty `install_path`. Under those locked settings, only the bound data
input `SELECT 1` was supplied to
`json_serialize_sql(CAST(? AS VARCHAR))`; it returned `error = false` with one
`SELECT_NODE` statement tree.

This is positive feasibility evidence for the installed engine's trusted JSON
bootstrap and fixed parser entrypoint. It does **not** establish that no network
activity occurred, identify the underlying linked/no-op/loader implementation,
or qualify the engine as a filesystem/network sandbox. The earlier safe
no-autoload/no-install batch's unavailable serializer result remains distinct:
the JSON function was unavailable until this approved bootstrap path loaded it.

### Expanded bound-data parser compatibility control

The first expanded child kept external access `false` before `LOAD json`; that
load rejected on the external-access condition, so the approved single fallback
used temporary external access `true` only for the fixed core load. The fallback
then re-applied `enable_external_access = false` and `lock_configuration =
true`, preserving the false autoinstall/autoload/community/unsigned settings.
The complete JSON metadata row changed from `loaded = false`, `installed =
false`, `install_mode = NOT_INSTALLED` to `loaded = true`, `installed = false`,
`extension_version = v1.5.4`, `install_mode = REPOSITORY`, with empty
`installed_from` and `install_path` fields. These metadata fields establish
engine state only; they do not trace I/O or classify the loader implementation.

After lockdown, all 11 actual `builtin-bundles.ts` SQL strings plus the five
fixed nested-catalog, `range`, comma-join, CTE, and named-parameter cases were
passed only as bound `VARCHAR` data to `json_serialize_sql`. Every input
returned one non-error `SELECT_NODE`; nested catalog, range, comma-join-both,
and named-parameter traversal assertions were observed. An initial harness
mistakenly expected an invented `CTE_NODE`; its resulting shape failure is
preserved as a harness observation, not a parser failure. The approved
corrected child instead traversed `$.node.cte_map.map[0]`: it recorded a
declaration named `x`, a nested `SELECT_NODE` query, and the matching
`BASE_TABLE` relation `x`. Thus all 16 bound-data inputs and the specified CTE
structural assertion are observed. This remains parser-structure feasibility
evidence only; it is neither a validator nor an acceptance/security proof.
