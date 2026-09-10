# Analytics feasibility evidence

These are bounded discovery instruments for `feasibility-instruments` and
`feasibility-evidence` in `/home/ubuntu/bb/plans/analytics.plan.pkl`. They do not
implement the proposed backend or qualify a runtime for delivery.

Run from the workspace root after the existing community dependencies are
installed. The aggregate does **not** install dependencies or refresh Analytics.
Prepare the pinned disposable Node API package using the scratch-only setup in
[the runtime report](runtime/runtime-feasibility.md). Set
`ANALYTICS_NODE_API_ROOT` to that scratch prefix. A missing or wrong-version
candidate fails the aggregate evidence check; it is not a successful comparison.
The legacy `duckdb@1.4.4` scratch prefix is optional and can be supplied through
`ANALYTICS_NATIVE_DUCKDB_ROOT` for historical comparison.

```sh
ANALYTICS_NODE_API_ROOT=/absolute/path/to/disposable/node-api-prefix \
  node community-plugins/plugins/analytics/test/architecture/probes/run.mjs \
  --bounded --assert-evidence
```

The JSON report contains individual observations and limitations, synthetic
stage distributions, process envelopes, source and instrument fingerprints,
host metadata and failed assertions. Keep the report with its source revision.
All stages run sequentially. The aggregate gives stages bounded process groups,
a four-minute total execution budget and bounded output; a timeout, missing
dependency or malformed result is a failure, never a defect witness.

The source and packaging instruments inspect this workspace's current BB
materialization and package sources; they are not portable standalone SDK tests.
The AS fit instrument requires Linux `/proc` and `prlimit`. Unsupported source,
platform and runtime capabilities must remain explicit. Consult:

- [Source history](source/README.md): source anchors plus a synthetic reconciler,
  not a point-in-time consistency or live transport proof.
- [Baseline](baseline/README.md): immutable historical defect fixtures, current
  behavior and synthetic projection/publication/serialization/compilation timings.
- [Runtime](runtime/runtime-feasibility.md): fixed-query comparison, parser
  structure, process termination and address-space fit; includes the historical
  extension-cache incident and corrected probe scope.
- [Native packaging](baseline/packaging.md): current native dependency policy
  and managed-install incompatibility. Scratch performance does not override it.
- [Containment options](baseline/containment-options.md): distinction between
  authored-SQL restrictions, process resource limits and a stronger OS sandbox.

`evidence-collected-with-limitations` means that required observations and their
controls were collected. `runtimeQualified` intentionally remains `false`.
The plan's selector requires a separate technical ruling that accounts for the
packaging rejection and all unresolved parser/resource requirements. A passing
aggregate must never be presented as a production security, portability,
retained-history completeness or performance guarantee.

Historical witnesses remain immutable when production defects are fixed.
Current-source changes require fresh relevant observations; this report is not
the later delivery acceptance harness. Do not commit operator state, raw events,
generated plugin output or temporary dependency trees with these instruments.
