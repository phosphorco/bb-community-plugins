# Lazy frontend artifact contract

Status: required integration contract; the current single-file plugin artifact
format does not yet satisfy it.

An ordinary BB boot may obtain only the declarative navigation metadata needed
to reserve a stable plugin route and sidebar position. It must not request a
feature's executable entry, DuckDB worker/WASM, ECharts, Mermaid, or a feature
renderer until that feature surface is opened.

## Artifact format v2

The plugin builder must emit a versioned manifest containing the entry and each
code-split chunk. Every entry includes a normalized relative path, byte length,
content hash, and allowlisted content type. The aggregate generation hash covers
the manifest bytes and every listed artifact byte in a deterministic order.

The server resolves a request by `(plugin ID, generation hash, manifest path)`:

- reject unknown paths, empty segments, encoded traversal, non-regular files,
  symlinks, and paths outside the generation root;
- serve only paths declared by that generation's manifest, with the declared
  content type and immutable cache policy;
- retain a bounded number of immutable generations so an already-loaded entry
  can still request its own chunks during a concurrent reload;
- return a typed expired-generation response after retention, so the host can
  recover by obtaining current metadata rather than silently mixing files from
  two generations.

The runtime must reject artifact format v2 until it supports this manifest. A
legacy v1 plugin remains on the explicit compatibility path; it is not evidence
that new declarative Analytics definitions may add executable ordinary-boot
requests.

## Surface boundaries

- `plan-graph`: Mermaid is requested only for a legacy diagram without a
  structured graph. Its fallback preserves the graph region and status message.
- `machine-monitor`: fleet controls, exact retained events, selection, and
  navigation remain in the entry. The ECharts timeline module is requested only
  for the chart surface, and the full timeline only after its disclosure opens.
- `analytics`: the registered app entry is metadata/navigation-only. The
  Analytics surface itself is requested only after its stable route opens; the
  browser DuckDB kernel starts only when that surface selects browser execution.
  The ECharts renderer starts only for a chart card; exact table values stay
  available while it loads or fails.

Each lazy boundary has a reserved layout region, a named `role=status` loading
state, and an explicit reload recovery action. Lazy loading may not hide native
focus, navigation, error, freshness, or exact-value behavior.

## Required evidence

Offline tests must establish manifest validation, aggregate hash changes,
generation-pinned old-chunk loads, bounded expiry recovery, old-runtime
rejection, and that a v2 metadata-only catalog read does not fetch an entry or
chunk. Browser cold-boot measurements remain a separate, coordinated acceptance
gate: an offline build or unit test is not live cold-boot performance evidence.
