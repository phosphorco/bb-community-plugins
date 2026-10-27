# @phosphorco/bb-thread-metrics

Version 0.1.0: bounded dollar summaries, family closure, heat ranks and optional
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
