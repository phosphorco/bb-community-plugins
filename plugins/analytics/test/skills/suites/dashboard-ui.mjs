import assert from "node:assert/strict";
import { rawContributors, reconcileLifecycleCohortAggregate, reconcileMeasurementAggregate } from "../fixtures/query-ui/skill-query-fixture.mjs";
import { dashboardFixture } from "../browser/fixtures/skills-dashboard-fixture.mjs";

export async function runSuite(options = {}) {
  const requested = new Set(options.negativeControls ?? []);
  const controls = new Set(["wrong-denominator", "pooled-tokenizer", "false-activation", "false-unused"]);
  for (const control of requested) assert.ok(controls.has(control), `unknown query/UI negative control ${control}`);
  const dashboard = dashboardFixture({ provider: "claude-code", project: "alpha", principal: "alice" });
  assert.equal(dashboard.cards.resolved.reduce((sum, row) => sum + row.count, 0), 2);
  assert.equal(dashboard.cards.active.reduce((sum, row) => sum + row.count, 0), 2);
  for (const aggregate of [...dashboard.cards.resolved, ...dashboard.cards.active]) reconcileLifecycleCohortAggregate(aggregate);
  assert.equal(dashboard.cards.coverage.unknown, 1, "the UI model carries prospective unknown coverage beside the aggregate");
  assert.equal(dashboard.cards.coverage.unsupported, 0, "provider filter prevents an unrelated unsupported cohort from contaminating this result");
  assert.equal(dashboard.revisions.filter((row) => row.name === "release-notes").length, 2, "the UI table keys same-name skills by exact revision identity");
  assert.equal(new Set(dashboard.revisions.map((row) => row.key)).size, dashboard.revisions.length);

  for (const aggregate of dashboard.measurements) {
    reconcileMeasurementAggregate(aggregate);
    const drawer = dashboard.drawer(aggregate);
    assert.deepEqual(drawer.map((row) => row.factId).sort(), [...aggregate.contributingFactIds].sort(), "drawer exposes the aggregate's exact filtered contributing rows");
  }
  const context = dashboard.measurements.filter((row) => row.family === "context");
  assert.equal(context.every((row) => row.evidence === "provider-context-report"), true, "context estimate evidence is not labelled as content or consumption");
  assert.equal(dashboard.drawer(context[0]).some((row) => row.turn === null), true, "drawer keeps nullable turns visible");

  if (requested.has("false-activation")) {
    assert.equal(dashboard.cards.activation.nativeActivation.status, "unsupported", "the UI fixture must not convert a registered-SKILL.md/subtree Read into native activation");
    const readsExist = rawContributors({ provider: "claude-code", project: "alpha", principal: "alice" }, (row) => row.evidence === "registered-skill-md-read" || row.evidence === "subtree-read").length > 0;
    assert.equal(readsExist, true, "the false-activation control needs real positive Read evidence");
    assert.throws(() => assert.equal(dashboard.cards.activation.nativeActivation.status, "supported"), /Expected values to be strictly equal/u, "a controlled read-as-activation claim must fail");
  }
  if (requested.has("false-unused")) {
    assert.deepEqual(dashboard.cards.activation.noReadObserved.contributingFactIds, ["life-active-b"], "only the exact active Claude delivery without Read evidence may be called no-read-observed");
    const falseTurnScopedNoRead = rawContributors({ provider: "claude-code", project: "alpha", principal: "alice" }, (row) => row.evidence === "active-staged" && row.coverage.lifecycle === "observed")
      .filter((active) => !rawContributors({ provider: "claude-code", project: "alpha", principal: "alice" }, (read) => (read.evidence === "registered-skill-md-read" || read.evidence === "subtree-read")
        && read.skill.revision === active.skill.revision && read.session === active.session && read.thread === active.thread && read.turn === active.turn).length)
      .map((row) => row.factId).sort();
    assert.deepEqual(falseTurnScopedNoRead, ["life-active-a", "life-active-b"], "the controlled false-unused implementation must mistake the later-turn Read delivery for unused");
    assert.throws(() => assert.deepEqual(dashboard.cards.activation.noReadObserved.contributingFactIds, falseTurnScopedNoRead), /Expected values to be strictly deep-equal/u, "the false-unused result must fail against exact session delivery provenance");
  }

  const codex = dashboardFixture({ provider: "codex", project: "alpha" });
  assert.deepEqual(codex.cards.coverage, { observed: 0, unsupported: 1, unknown: 0 }, "unsupported telemetry is rendered as coverage, not zero activation");
  assert.equal(codex.measurements.length, 0, "unsupported null consumption creates no numeric measurement aggregate");
  return {
    suite: "dashboard-ui", status: "pass",
    checks: [
      { id: "exact-revision-table-and-filtered-cards", status: "pass", details: "Cards and rows retain exact provider/project/principal filters and same-name revision identity." },
      { id: "drawer-reconciles-to-raw-contributors", status: "pass", details: "Every displayed measure opens only the raw rows that reconstruct its filtered value and sample count." },
      { id: "unknown-unsupported-and-nullable-turn-ui", status: "pass", details: "Prospective unknowns, unsupported telemetry, and nullable turns remain explicit UI-model states." },
      { id: "false-activation-and-false-unused-controls", status: "pass", details: "Positive Read evidence remains distinct from unsupported native activation, and later-turn Reads reconcile to their session delivery before qualified no-read-observed is shown." },
    ],
    observations: [
      { id: "provider-context-estimate", kind: "measurement", status: "observed", details: "Context is shown as method-qualified provider evidence rather than inferred body loading or token consumption." },
      { id: "codex-unsupported-ui", kind: "coverage", status: "unsupported", details: "The Codex cohort reports unsupported activation/consumption telemetry without fabricating zeros." },
    ],
    limits: ["This browser fixture models exact UI data contracts and drawer provenance; component rendering is owned by the later isolated UI node."],
  };
}
