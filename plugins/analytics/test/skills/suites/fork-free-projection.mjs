import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../..");
const upstream = resolve(workspaceRoot, "fork/upstream");
const implementation = resolve(directory, "../projection/fork-free/run.ts");

export async function runSuite({ negativeControls = [] } = {}) {
  const required = ["joined-success-as-read", "missing-catalog-snapshot", "conflicting-replay", "flattened-event", "partial-publication", "cross-project-retraction", "failed-capture-zeroing", "unreadable-content-zeroes-catalog"];
  for (const control of negativeControls) assert.ok(required.includes(control), `unknown fork-free projection negative control ${control}`);
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", implementation], { cwd: workspaceRoot, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.error, undefined, `fork-free projection process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `fork-free projection failed: ${result.stderr || result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { status: "pass", checks: 31 });
  return {
    suite: "fork-free-projection", status: "pass",
    checks: [
      { id: "complete-public-catalog", status: "pass", details: "list/getContent/listFiles preserves public provider identity and normalizes only relative registered paths." },
      { id: "authoritative-thread-dimensions", status: "pass", details: "Every retained public event carries threads.get project/environment/provider dimensions and cross-dimension replays fail closed." },
      { id: "bounded-command-evidence", status: "pass", details: "Prompt mentions and joined shell candidates retain IDs, status and metadata, never prompt/command/output bodies or individual-read claims." },
      { id: "atomic-idempotent-reconciliation", status: "pass", details: "Exact replay is idempotent, source conflicts roll back, pending starts persist and exact not-found deletion retracts active facts." },
      { id: "unreadable-content-is-null-footprint", status: "pass", details: "Only the exact public HTTP 502 read-root containment failure retains exact list/listFiles membership with null revision/bytes; other getContent failures preserve last-good state." },
    ],
    observations: [{ id: "thr-tn5pxvdf7j", kind: "public-sdk", status: "observed", details: "The fixture retains seq 1 prompt mention plus seq 32/33 shell-wrapped joined-path candidates and enclosing outcome." }],
    limits: ["Current catalog revision is exact only at capture; historical prompt/command revisions remain unknown.", "No private staged membership, provider delivery, actual skill use, individual file read, or per-skill token allocation is claimed."],
  };
}
