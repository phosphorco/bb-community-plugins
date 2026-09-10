# Analytics baseline probe

Run from the workspace root:

```sh
node community-plugins/plugins/analytics/test/architecture/probes/baseline/probe.mjs
```

`runProbe()` is also exported for the parent aggregate. It emits only bounded,
JSON-serializable, redacted evidence with a `status` of `observed`,
`unsupported`, or `failure`. Its `summary` lists every observed, unsupported,
and failed subprobe; any unsupported subprobe makes the aggregate status
`unsupported` rather than hiding partial coverage behind `observed`.

Every child process has a 1.5-second deadline, bounded incremental stdout
(16 KiB) and stderr (4 KiB) capture, forced termination, kill grace, and
one settlement/cleanup path. The probe begins by asserting timeout,
output-cap, nonzero-exit, and direct-CLI failure-exit controls. A failed report
prints JSON and exits nonzero.

The probe records a SHA-256 for each relevant current source file plus the
`community-plugins` commit. Timing provenance includes `store.ts`,
`analytics-model.ts`, `command-signature.ts`, and `formatting.ts` in addition
to the direct stage modules. A changed hash invalidates that current-source
observation.

It has three bounded checks:

- Exact copies of the current reviewed `sql-policy.ts` and `browser-engine.ts`
  are preserved under `fixtures/historical/` only while their SHA-256 values
  match the recorded review hashes. The probe replays those immutable historical
  SQL and queue witnesses and separately observes current source behavior. A
  current fix is reported as `fixed-or-changed`; import, child, fixture-hash,
  and assertion-control failures remain failures.
- A synthetic two-row canonical result compiles through the current ECharts
  compiler, while a missing-binding negative control and a three-built-in
  inventory capture baseline fixture compatibility. No browser is mounted.
- A fixed-seed, fixed-clock synthetic fixture measures 30 samples of current
  fact projection, in-memory disposable SQLite publication, NDJSON
  serialization, and compiler work for 1, 10, and 30 views sharing one
  canonical result. The fixture has exactly 25,000 facts; source fetch,
  DuckDB, browser rendering, and TTFUR are deliberately omitted.

The probe does not start DuckDB, fetch facts, request refresh, read persisted
analytics data, mount UI, or reload services. It does run the documented
synthetic stage timings only; those are not TTFUR, real cancellation completion,
browser rendering performance, or resource-limit evidence.
