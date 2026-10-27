# @phosphorco/bb-usage-algebra

Version 0.1.0. Pure usage arithmetic with Zod as the only runtime dependency.
No SDK, threads, storage, React, timers, I/O or background work. Import
`@phosphorco/bb-usage-algebra/vector` for `UsageVector`, `UsageVectorSchema`,
`zeroUsageVector`, `addUsageVectors` without importing pricing data.

```ts
import { canonicalize, price, DEFAULT_RATE_TABLE } from '@phosphorco/bb-usage-algebra';
const usage = canonicalize('codex', {
  inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100,
});
const estimate = usage.vector && price(DEFAULT_RATE_TABLE, 'codex', 'gpt-6.1-sol', usage.vector);
```

Store disjoint vectors keyed by provider/model, with observation and coverage
metadata. Compute dollars when reading, using the selected operator-owned rate
table version. Changing rates intentionally re-rates historical vectors. This
package does not allocate subscription charges or reconstruct missing invoices.
See [CONTRACT.md](CONTRACT.md) for normalization, reset and approximation rules.

Build: `npm run build`; typecheck: `npm run typecheck`; tests: `npm test`.
Tests consume emitted JS, typecheck emitted declarations, and inspect npm pack.
The parent workspace supplies local tools; no dependency installation is needed
when its existing Bun, TypeScript and Zod dependencies are installed.
