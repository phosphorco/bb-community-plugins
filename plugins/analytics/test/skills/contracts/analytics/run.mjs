import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../..");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "schema-contract.ts");

export async function runSuite() {
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", contract], { cwd: workspaceRoot, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.error, undefined, `schema contract process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `schema contract failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.checks, 12);
  return {
    suite: "analytics-contract",
    status: "pass",
    checks: [
      { id: "real-runtime-v1-boundary", status: "pass", details: "A real SkillObservation v1 is parsed before its Analytics fact is accepted." },
      { id: "lifecycle-and-coverage-schema", status: "pass", details: "Exact revision, source, session/thread/nullable-turn, evidence and coverage dimensions are required." },
      { id: "measurement-partitions", status: "pass", details: "Content, context and consumption remain method-partitioned and cannot be pooled." },
      { id: "negative-semantics", status: "pass", details: "The schemas reject unknown-to-zero, aggregate allocation, stale revision and bad coverage cases." },
    ],
    observations: [{ id: "prospective-coverage", kind: "policy", status: "observed", details: "Pre-instrumentation and unsupported epochs remain explicit, never zero-use cohorts." }],
    limits: ["Provider aggregate usage and unsupported per-skill activation are not converted into per-skill facts."],
  };
}
