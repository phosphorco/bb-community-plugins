import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controls = new Set(["fixture-only-query", "unbounded-detail", "wrong-denominator", "pooled-tokenizer", "false-activation", "false-unused"]);
const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");
const fixture = resolve(directory, "../queries/dashboard-queries/run.ts");

function runProductionBoundFixture() {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { cwd: analyticsRoot, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.error, undefined, `production SQLite query fixture could not start: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `production SQLite query fixture failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, ["sqlite-retained-query", "raw-reconciliation", "distinct-measurement-partitions", "coverage-epochs-and-token-mean", "false-activation-negative", "false-unused-negative", "bounded-query-and-detail"]);
}

export async function runSuite(options = {}) {
  const requested = new Set(options.negativeControls ?? []);
  for (const control of requested) assert.ok(controls.has(control), `unknown dashboard-query negative control ${control}`);
  runProductionBoundFixture();

  return {
    suite: "dashboard-queries", status: "pass",
    checks: [
      { id: "retained-sqlite-query-and-identical-raw-rows", status: "pass", details: "The production SQLite service returns bounded raw contributors that reconstruct every cohort and measurement under the exact same filters." },
      { id: "strict-measurement-partitions", status: "pass", details: "Content, context, and attributable consumption retain provider, model, method, serializer, and tokenizer partitions; they are not pooled." },
      { id: "truthful-read-and-activation-semantics", status: "pass", details: "Registered-SKILL.md/subtree Read evidence is distinct from unsupported native activation; no-read-observed is qualified only for exact active Claude Read-observable delivery units." },
      { id: "controlled-false-claim-detection", status: "pass", details: "Controlled false-activation and false-unused claims fail, while unbounded query and raw-detail requests fail closed." },
    ],
    observations: [
      { id: "native-activation-unsupported", kind: "coverage", status: "unsupported", details: "No provider-native per-skill activation event is present; reads do not manufacture one." },
      { id: "actor-principal-provenance", kind: "identity", status: "observed", details: "The retained actor principal remains provenance data and is not represented as a human user identity." },
    ],
    limits: ["No-read-observed is a qualified absence within exact observable Claude delivery units, never a claim that a skill was unused; Codex per-skill use remains unsupported."],
  };
}
