# Analytics

Analytics is a performance-first BB community plugin for understanding which
agent capabilities are slow, unreliable, or repeatedly attempted. It ships two
useful dashboards and a small code-authored bundle format that agents and people
can extend.

The first slice deliberately measures **tool reliability**, not whether a tool
or skill caused a better task outcome. Historic events do not consistently
identify a canonical tool version or prove that skill content was read.

## What ships

- **Tool reliability** — calls, failure rate, p95 duration, affected threads,
  failures by capability, and third-or-later adjacent use.
- **Capability performance** — invocation volume, p50/p95/p99 latency, and
  daily activity.
- A versioned bundle contract: one shared loader and policy, many DuckDB
  queries, and many metric/bar/line/table visualizations per query.
- CLI and agent tools to save or remove authored bundles.

Bar and line visualizations use a modular [Apache ECharts](https://echarts.apache.org/)
SVG renderer. The bundle contract remains a deliberately smaller declarative
surface: authored JSON selects fields and chart kinds, while the plugin compiles
theme-aware, bounded ECharts options. Bundles cannot inject arbitrary ECharts
callbacks or HTML.

## Performance and privacy contract

Analytics extraction is pull-based and shared. No extraction work runs while
Analytics is unused. When a dashboard request needs data, one supervised
loader reads a bounded recent window through BB's public SDK; its identity and
freshness policy are shared by every query and visualization that uses it:

- 200 thread candidates, sorted to the 80 most recently updated;
- at most 500 completed events per thread;
- four concurrent event reads;
- a one-hour `maxAgeMs` default, bounded to 1 minute through 24 hours;
- stale requests single-flight one refresh, and built-ins serve the prior final
  snapshot while `staleWhileRefresh` is true.

Extraction never runs once per query or visualization. A dashboard with many
visualizations still resolves the shared loader snapshot once, then runs each
distinct query against that snapshot. If no final snapshot exists, the first
pull may show a clearly marked partial newest-thread prefix while extraction
continues.

Coverage is bounded by the configured candidate/thread/event limits above. A
final snapshot is not full BB history. A cold partial newest-thread prefix is
also not a statistical sample: it is intentionally biased toward recent
threads and must not be used to estimate full-history rates or distributions.

Only typed facts are stored in the plugin-owned SQLite database. Facts exclude
arguments, output, commands, paths, prompts, and free-text errors. Errors are
reduced to a small class and an irreversible 16-character signature. Opening a
dashboard transfers the selected bounded fact window as NDJSON directly to a
dedicated DuckDB-Wasm worker; fact rows never enter React state.

DuckDB runs with one query thread in an isolated browser worker. Its engine and
worker assets load lazily only after Analytics opens, select the smaller
exception-handling build when the browser supports it, and are served with an
immutable one-year cache. Authored queries must be exactly one `SELECT`, may
read only `tool_execution_fact_v1`, are interrupted after two seconds, and
return at most 500 rows. The React surface has no timers or polling; it updates
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

Agents also receive `save_analytics_bundle` and `delete_analytics_bundle` tools.
Stored bundles are validated before they become visible; arbitrary JavaScript,
filesystem reads, network access, extensions, mutations, and multiple SQL
statements are not accepted. `maxAgeMs` defaults to one hour for omitted
backward-compatible v1 policy, and is accepted only from 1 minute through 24
hours. The loader policy applies to the shared extraction, never to individual
visualizations.

## Current boundary

This slice proves the bundle runtime, client-side DuckDB query plane, bounded
pull-based projection, and adaptive visualization surface. It does not yet provide a
full-history transactional fact outbox, immutable Parquet manifests, canonical
tool-version instrumentation, skill-read instrumentation, per-principal bundle
ownership, or authorized thread drill-through. Those are the next durability
and product layers rather than assumptions hidden inside this prototype.
