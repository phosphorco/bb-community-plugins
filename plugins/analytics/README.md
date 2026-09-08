# Analytics

Analytics is a performance-first BB community plugin for understanding which
agent capabilities are slow, unreliable, or repeatedly attempted. It ships three
useful dashboards and a small code-authored bundle format that agents and people
can extend.

The first slice deliberately measures **tool reliability**, not whether a tool
or skill caused a better task outcome. Historic events do not consistently
identify a canonical tool version or prove that skill content was read.

## What ships

- **Tool reliability** — calls, failure rate, p95 duration, affected threads,
  failures by capability, third-or-later adjacent use, and a native-command
  view that separates attribution-eligible failures from help and composite
  command executions.
- **Capability performance** — invocation volume, p50/p95/p99 latency, and
  daily activity.
- **Turn efficiency** — average tool calls per fully observed tool-using turn,
  and p95-capped average turn elapsed time per tool call. Turn elapsed time is
  measured from the recorded `turn/started` to `turn/completed` lifecycle
  events; turns missing either boundary are excluded rather than estimated.
- A versioned bundle contract: one shared loader and policy, many DuckDB
  queries, and many metric/bar/line/table visualizations per query.
- Right-click chart actions that preserve the exact dashboard, query,
  parameters, snapshot coverage, and selected redacted result row as an
  `analytics-ref:v1` token or an add-to-chat mention.
- Exact keyboard-accessible plotted-data tables plus plotted-result CSV,
  complete bounded-result CSV, and SVG export.
- CLI and agent tools to save or remove authored bundles.

Bar and line visualizations use a modular [Apache ECharts](https://echarts.apache.org/)
SVG renderer. The bundle contract remains a deliberately smaller declarative
surface: authored JSON selects fields and chart kinds, while the plugin compiles
theme-aware, bounded ECharts options. The compiler also owns typed result
schema, generation-scoped datum identity, structural signatures, component
topology, plotted/export rows, and interaction metadata. Bundles cannot inject
arbitrary ECharts callbacks or HTML.

## Performance and privacy contract

Analytics extraction is pull-based and shared. No extraction work runs while
Analytics is unused. When a dashboard request needs data, one supervised
loader reads a bounded recent window through BB's public SDK; its identity and
freshness policy are shared by every query and visualization that uses it:

- 200 thread candidates, sorted to the 80 most recently updated;
- at most 500 recent tool-completion and turn-lifecycle events per thread;
- four concurrent event reads;
- a one-hour `maxAgeMs` default, bounded to 1 minute through 24 hours;
- stale requests single-flight one refresh, and built-ins serve the prior final
  snapshot while `staleWhileRefresh` is true.

Extraction never runs once per query or visualization. A dashboard with many
visualizations still resolves the shared loader snapshot once, then runs each
distinct query against that snapshot. If no final snapshot exists, the UI shows
a cold indexing state until the first bounded final snapshot is published.

Coverage is bounded by the configured candidate/thread/event limits above. A
final snapshot is not full BB history. A cold partial newest-thread prefix is
also not a statistical sample: it is intentionally biased toward recent
threads and must not be used to estimate full-history rates or distributions.

Only typed facts are stored in the plugin-owned SQLite database. Facts exclude
raw arguments, output, full command text, prompts, and free-text errors. Native
command executions retain only a bounded derived signature: the primary binary,
two safe argument tokens (flags and simple subcommands; all paths and arbitrary
values become `<redacted>`), whether it contains `--help`, and whether the
enclosing execution is a pipeline, joined command, or shell wrapper. Only a
parsed, simple, direct execution without `--help` is attribution-eligible.
That shape belongs to the enclosing execution: its exit status is not attributed
to a particular segment of a composite command. Errors are
reduced to a small class and an irreversible 16-character signature. Opening a
dashboard transfers the selected bounded fact window as NDJSON directly to a
dedicated DuckDB-Wasm worker; fact rows never enter React state.

The native-command investigation index defaults to observed-execution
frequency. It can re-group the displayed bounded result by binary, binary plus
the first safe argument, or full safe signature; slice by direct eligibility,
help, wrapper/composite context, or observed-but-unattributed outcomes; and
sort every outcome column. Its `Observed, not attributed` count is execution
context only: it never contributes to an attributed-failure numerator or rate.

DuckDB runs with one query thread in an isolated browser worker. Its engine and
worker assets load lazily only after Analytics opens, select the smaller
exception-handling build when the browser supports it, and are served with an
immutable one-year cache. Authored queries must be exactly one structurally
parsed `SELECT`/CTE tree, may read only `tool_execution_fact_v1` or declared
CTEs, bind `$range_days` through a prepared statement, are interrupted after
two seconds, and return at most 500 rows. Unsupported comments, qualified
relations, comma-joined outside relations, nested outside relations, and table
functions are denied. Bar and line rendering have separate density caps (24
and 120 marks) and preserve SQL result order; analytical ordering and top-N
selection stay in SQL. The React surface has no timers or polling; it updates
on explicit input or BB realtime invalidation. The diagnostics disclosure shows
engine startup, fact-transfer/materialization, and per-query timings separately.

The index status in the UI reports freshness, fact/thread coverage, loader
duration, and threads that reached the event cap.

## Install and develop

```bash
bb plugin install ./plugins/analytics --yes
bb plugin dev ./plugins/analytics
```

```bash
npm run typecheck --workspace @phosphorco/bb-plugin-analytics
npm run test --workspace @phosphorco/bb-plugin-analytics
npm run build --workspace @phosphorco/bb-plugin-analytics
```

## Author a bundle

Dashboard bundles are JSON code. Start with one of the constants in
[`builtin-bundles.ts`](builtin-bundles.ts), give it a new lowercase `id`, and
connect every visualization to a query by `queryId`. Queries can use the
runtime-provided `$range_days` integer parameter.

```json
{
  "version": 1,
  "id": "tool-volume",
  "title": "Tool volume",
  "description": "Calls by tool in the selected range.",
  "loader": {
    "id": "recent-capability-facts-v1",
    "label": "Bounded recent BB capability activity",
    "maxAgeMs": 3600000,
    "staleWhileRefresh": true
  },
  "queries": [{
    "id": "volume",
    "title": "Volume",
    "maxRows": 30,
    "sql": "SELECT capability_key, count(*)::DOUBLE AS calls FROM tool_execution_fact_v1 GROUP BY capability_key ORDER BY calls DESC"
  }],
  "visualizations": [
    { "id": "volume-chart", "queryId": "volume", "kind": "bar", "title": "Calls by capability", "x": "capability_key", "y": "calls", "format": "integer" },
    { "id": "volume-table", "queryId": "volume", "kind": "table", "title": "Call volume", "columns": [{ "field": "capability_key", "label": "Capability", "format": "text" }, { "field": "calls", "label": "Calls", "format": "integer" }] }
  ],
  "layout": [
    { "visualizationId": "volume-chart", "width": "half" },
    { "visualizationId": "volume-table", "width": "half" }
  ]
}
```

Install it from a workspace file:

```bash
bb analytics install ./tool-volume.json
bb analytics bundles
bb analytics remove tool-volume
```

Verify every built-in and installed bundle before opening a dashboard:

```bash
bb analytics verify
bb analytics verify tool-reliability
```

Verification compiles each query against an empty DuckDB table with the exact
typed fact contract used by Analytics. It catches binder errors, missing output
fields, and invalid visualization bindings without reading stored fact data.

Agents also receive `save_analytics_bundle`, `delete_analytics_bundle`, and
`read_analytics_reference` tools. References are immutable capsules over the
already-redacted analytical result and re-resolve at message-send/tool-call
time. They never include raw fact rows, tool arguments, output, prompts, paths,
or thread content. Datum capsules retain only the chart's dimension and measure;
direct event, thread, turn, and project identifier dimensions are refused.
Stored bundles are validated before they become visible; arbitrary JavaScript,
filesystem reads, network access, extensions, mutations, and multiple SQL
statements are not accepted. `maxAgeMs` defaults to one hour for omitted
backward-compatible v1 policy, and is accepted only from 1 minute through 24
hours. The loader policy applies to the shared extraction, never to individual
visualizations.

## Current boundary

This slice proves the bundle runtime, client-side DuckDB query plane, bounded
pull-based projection, ECharts lifecycle/compiler boundary, exact-value access,
export, and chart-to-query references. It does not yet provide a
full-history transactional fact outbox, immutable Parquet manifests, canonical
tool-version instrumentation, skill-read instrumentation, per-principal bundle
ownership, cross-filtering, or authorized thread drill-through. Those are the next durability
and product layers rather than assumptions hidden inside this prototype.
