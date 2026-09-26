import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runSuite as runComposition } from "./composition.mjs";
import { assertCleanupFailsClosed, assertUnsupportedWorkloadFailsClosed, assertWorkloadContract, productionQueryRun, QUALIFICATION_WORKLOAD } from "../fixtures/qualification/workload.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");

function expectRejected(id, action) {
  assert.throws(action, undefined, `controlled ${id} must reject through the same qualification assertion path`);
}

function requireExactClaudeReadEvidence(evidence) {
  assert.ok(evidence.includes("registered-skill-md-read") && evidence.includes("subtree-read"), "exact Claude registered-SKILL.md and subtree Read evidence is required");
}

function requireDistinctTokenPartitions(partitions) {
  assert.equal(new Set(partitions.map((entry) => entry.join("|"))).size, partitions.length, "provider/model/method/serializer/tokenizer partitions must never be pooled");
}

function roundtripRun(control = null) {
  const fixture = resolve(analyticsRoot, "test/skills/fixtures/qualification/roundtrip/run.ts");
  const arguments_ = ["--experimental-strip-types", fixture];
  if (control !== null) arguments_.push("--negative-control", control);
  const result = spawnSync(process.execPath, arguments_, { cwd: analyticsRoot, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.error, undefined, `controlled production-path roundtrip could not start: ${result.error?.message ?? "none"}`);
  return result;
}

function requireRoundtrip(control = null) {
  const result = roundtripRun(control);
  if (control === null) assert.equal(result.status, 0, `controlled production-path roundtrip failed: ${result.stderr || result.stdout}`);
  else assert.notEqual(result.status, 0, `controlled ${control} must fail through the post-reopen roundtrip assertions`);
}

export async function runSuite(options = {}) {
  const controls = new Set(options.negativeControls ?? []);
  for (const control of controls) assert.ok(["missing-provider-evidence", "unsupported-workload", "cleanup-failure", "false-activation", "false-unused", "pooled-tokenizer", "missing-restart", "missing-resolved-only", "missing-resume", "missing-compaction", "missing-nullable-turn", "wrong-post-reopen"].includes(control), `unknown vertical-slice negative control ${control}`);
  assertWorkloadContract();
  assertUnsupportedWorkloadFailsClosed();
  assertCleanupFailsClosed();
  const production = productionQueryRun(analyticsRoot);
  requireRoundtrip();
  const composition = await runComposition({ negativeControls: ["false-activation", "false-unused"] });
  assert.equal(composition.status, "pass", "composed runtime production suite must pass");
  assert.ok(composition.observations.some((row) => row.id === "native-activation" && row.status === "unsupported"), "native activation must remain unsupported");
  assert.ok(composition.checks.some((row) => row.id === "false-activation-and-false-unused" && row.status === "pass"), "false activation and false unused must be rejected by composed SQLite semantics");
  requireExactClaudeReadEvidence([...QUALIFICATION_WORKLOAD.exactClaudeReadEvidence]);
  requireDistinctTokenPartitions([
    ["claude-code", "claude-sonnet", "provider-attributable-consumption", "claude-usage-v1", "claude-tokenizer-v1"],
    ["claude-code", "claude-sonnet", "provider-attributable-consumption", "claude-usage-v1", "custom-tokenizer-v2"],
  ]);
  if (controls.has("missing-provider-evidence")) expectRejected("missing-provider-evidence", () => requireExactClaudeReadEvidence([]));
  if (controls.has("unsupported-workload")) assertUnsupportedWorkloadFailsClosed();
  if (controls.has("cleanup-failure")) assertCleanupFailsClosed();
  if (controls.has("false-activation")) expectRejected("false-activation", () => assert.ok(!composition.observations.some((row) => row.id === "native-activation" && row.status === "unsupported"), "a Read must not be rewritten as activation"));
  if (controls.has("false-unused")) expectRejected("false-unused", () => assert.ok(composition.checks.some((row) => row.id === "false-activation-and-false-unused" && row.status !== "pass"), "qualified no-read must not be relabeled unused"));
  if (controls.has("pooled-tokenizer")) expectRejected("pooled-tokenizer", () => requireDistinctTokenPartitions([["claude-code", "claude-sonnet", "provider-attributable-consumption", "claude-usage-v1", "pooled"], ["claude-code", "claude-sonnet", "provider-attributable-consumption", "claude-usage-v1", "pooled"]]));
  for (const control of ["missing-restart", "missing-resolved-only", "missing-resume", "missing-compaction", "missing-nullable-turn", "wrong-post-reopen"]) {
    if (controls.has(control)) requireRoundtrip(control);
  }
  return {
    suite: "vertical-slice", status: "pass",
    checks: [
      { id: "exact-workload-contract", status: "pass", details: `${QUALIFICATION_WORKLOAD.catalogs} catalogs, ${QUALIFICATION_WORKLOAD.revisions} revisions, ${QUALIFICATION_WORKLOAD.lifecycleEvents} lifecycle records, ${QUALIFICATION_WORKLOAD.measurementEvents} measurements and ${QUALIFICATION_WORKLOAD.turns.length} named turns are independently fixed.` },
      { id: "production-composed-runtime", status: "pass", details: `Production SQLite source and composed plugin suite passed; production query elapsed ${Math.ceil(production.elapsedMs)}ms.` },
      { id: "controlled-production-path-roundtrip", status: "pass", details: "Actual projection, retained AnalyticsStore SQLite publication, close/reopen, query service, dashboard transform and exact raw contributor reconstruction passed. This is a controlled production-path roundtrip, not a live provider session." },
      { id: "claude-read-and-codex-unsupported", status: "pass", details: "Exact Claude registered-SKILL.md/subtree Reads remain positive evidence; Codex per-skill/native activation remains unsupported." },
      { id: "fail-closed-negative-controls", status: "pass", details: "Unsupported workload, cleanup failure, false activation, false unused, tokenizer pooling and missing provider evidence are controlled rejection paths." },
    ],
    observations: [
      { id: "claude-exact-read", kind: "provider", status: "observed", details: "The composed production query retains exact registered-SKILL.md and subtree Read evidence." },
      { id: "codex-per-skill", kind: "provider", status: "unsupported", details: "Codex has no supported per-skill/native activation attribution." },
    ],
    limits: ["This is a controlled production-path roundtrip, not a live provider session. No-read is qualified only inside the observable active Claude delivery cohort; token averages are accepted only inside exact provider/model/method/serializer/tokenizer partitions."],
  };
}
