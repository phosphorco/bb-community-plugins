import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const controls = new Set(["missing-project", "wrong-environment", "unwired-commit"]);
const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");
const fixture = resolve(directory, "../fixtures/projection/retained-source-integration/run.ts");

export async function runSuite(options = {}) {
  for (const control of options.negativeControls ?? []) assert.ok(controls.has(control), `unknown retained-source-integration negative control ${control}`);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { cwd: analyticsRoot, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.error, undefined, `retained source integration fixture could not start: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `retained source integration fixture failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, ["public-sdk-pagination", "authoritative-thread-dimensions", "pre-instrumentation-and-observed-coverage", "history-rewrite-and-exact-deletion", "missing-project-negative", "flattened-observation-negative", "wrong-environment-negative", "unwired-commit-negative"]);
  const production = readFileSync(resolve(analyticsRoot, "extraction/skill-observation-projector.ts"), "utf8");
  assert.match(production, /createRetainedSourceAdapter\(this\.sdk/u, "production path starts at the public threads SDK adapter");
  assert.match(production, /this\.store\.commitSkillProjection\(/u, "production path has a live concrete SQLite commit caller");
  assert.doesNotMatch(production, /retained-projector\.mjs/u, "internal-only retained server helper is not an Analytics source");
  return {
    suite: "retained-source-integration", status: "pass",
    checks: report.checks.map((id) => ({ id, status: "pass", details: "Production-bound retained source integration exercised this requirement." })),
    observations: [
      { id: "public-source", kind: "source", status: "observed", details: "Threads are paged through the public SDK; list rows never supply authoritative dimensions." },
      { id: "coverage", kind: "coverage", status: "observed", details: "Pre-instrumentation and observed intervals remain distinct in the published facts." },
    ],
    limits: ["A thread list omission is intentionally not a deletion witness; only an exact public threads.get not-found response retracts retained skill rows."],
  };
}
