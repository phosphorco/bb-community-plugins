import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "../fixtures/providers/skill-observation-v1-contract.ts");

function runContract() {
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", contract, "catalog-delivery"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 25_000,
  });
  assert.equal(result.error, undefined, `catalog contract process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `catalog contract failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, ["busy-deferral-and-failed-config", "revision-and-path-name-collision", "wrong-revision-rejected"]);
}

export async function runSuite() {
  runContract();
  return {
    suite: "catalog-delivery",
    status: "pass",
    checks: [
      { id: "busy-catalog-deferral", status: "pass", details: "The real v1 contract accepts a recorded busy-runtime deferral as a failed active-staging observation, distinct from catalog resolution." },
      { id: "failed-configuration", status: "pass", details: "A rejected skills/configure acknowledgement remains a failed observation with bounded failure detail." },
      { id: "revision-and-collision-identity", status: "pass", details: "Changed SKILL.md/tree revisions, same-name skills, and different paths retain distinct exact identities and dedupe keys." },
      { id: "wrong-revision-negative-control", status: "pass", details: "The controlled fixture with a skill catalog revision different from its enclosing catalog is rejected by SkillObservation v1." },
    ],
    observations: [
      { id: "busy-runtime-deferral", kind: "catalog", status: "observed", details: "A busy runtime defers staging; this does not falsely claim successful provider configuration." },
      { id: "failed-configure", kind: "bridge", status: "failed", details: "The fixture retains a bounded skills/configure rejection rather than dropping it." },
      { id: "same-name-skill", kind: "catalog", status: "observed", details: "Name equality is insufficient identity: path, source, skill ID, and revisions remain distinct." },
    ],
    limits: ["This is a fail-closed contract instrument; it does not simulate a provider session or infer provider ingestion from a bridge acknowledgement."],
  };
}
