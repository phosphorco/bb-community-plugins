# @phosphorco/bb-thread-metrics

Package0.2.3 adds negotiated conditional recent rows while retaining bounded per-ID availability, the existing recent snapshot and scoring-configv2. Existing wirev1 summaries, family closure, heat ranks and optional
on-demand breakdowns for independent BB plugins. See [CONTRACT.md](CONTRACT.md)
for ownership, wire semantics and proof limits.

```ts
import { familyClosure, dollarPercentiles, heat } from '@phosphorco/bb-thread-metrics';
import { createThreadMetricsDiscovery, createThreadMetricsClient } from '@phosphorco/bb-thread-metrics/bb';

// Retain one coordinator per mounted demand resource, including across refresh.
const discovery = createThreadMetricsDiscovery(sdk);
const pass = await discovery.discover({ signal });
for (const owner of pass.rows) {
  if (owner.state !== 'ready') continue;
  const client = createThreadMetricsClient(sdk, owner.pluginId);
  const summary = await client.read({ threadIds: ['thr_example'], scope: 'family' });
}
```

Trigger discovery on mount, refresh, reconnect or plugin lifecycle. `busy` means
previous actual SDK reads are still outstanding; retain good data and retry only
on a later consumer trigger. Creating another coordinator to bypass busy defeats
the bound. No polling or automatic retry is supplied.

`bun run test` builds public JS/declarations before testing emitted entries.
`bun run typecheck` checks source; `tsc -p tsconfig.public-tests.json --noEmit`
checks emitted declaration compatibility with server and browser SDKs. The
`/testing` entry's `runSupplierConformance` accepts the adopter's real registration
factory and representative read/detail cases. It returns explicit source
conformance checks, never live host acceptance.


## Recent snapshot (wirev1, package0.2)

Owners may advertise `capabilities.recentSnapshotV1:true` with a matching
`recentSnapshot(input)` handler. `createThreadMetricsClient(...).recentSnapshot({ifRevision?})`
returns the immutable precomputed object or an unchanged revision. Absence of this
optional capability leaves the0.1 read/detail contract intact. Old consumers may
ignore it. The adapter does not add refresh timers, caches or materialization.

The full response holds own/family raw estimated-dollar windows and provider
contributions, separately named weighted scores, raw dollar ranks and score ranks,
activity/materialization/rank times, coverage/cap/pending flags and the published
scoring configuration. Zero is explicit supplier evidence; omission/unavailable is
not zero. Config weights affect heat scores, never retained dollars. Defaults are
weight1 and current p90 percentile gates. Raw/scored populations remain distinct.

Bounds:72h recent activity,1000 rows,4MiB canonical JSON and8KiB/row,32 provider
entries per projection/config. Bounds include unknown additive fields before
schema stripping; the SDK has already parsed transport JSON. Providers enforce
materializer work/storage and publication bounds independently. Clients must not
turn row omission into an eager per-ID read storm. The planned coordinator uses
one held snapshot/mount+30s conditional cadence; the package schedules nothing.

Current source tests are package/adapter proof only. Registry release, ledger
materialization, live byte/time measurement, all consumer adoptions and native
host/freshness proof remain separate gates.


## Per-ID availability (package0.2.2)

The optional full-snapshot `availability` field carries supplier-authored own/family reasons. Its financial `asOf` is always null; `projectionAsOf` refers only to the same ID in `snapshot.rows`, and `observedAt` dates status evidence. Preserve any separately supplied dollars and their actual timestamp. Missing reasons do not imply zero, a source gap or a per-ID backlog. Unknown codes retain their bounded plain-language detail. This source version is not a publication or adopter-runtime claim.

## Conditional recent rows (package0.2.3)

Optional `recentRowsV1` negotiates a
separate `threadMetricsRecentRowsV1` method. It retains full v1 compatibility,
sends current metadata without identical rows only against an exact admitted
baseline, and recovers with full reads when that baseline is uncertain. See the
contract for bounds and lineage/error recovery. Consumers must adopt the exact
published version explicitly; a source checkout or package build does not prove
registry identity, installed adoption or runtime behavior.
