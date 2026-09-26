import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../..");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "schema-contract.ts");

export async function runSuite({ negativeControls = [] } = {}) {
  const required = ["joined-success-as-read", "aggregate-token-apportionment", "current-catalog-as-history", "conflicting-replay", "truncated-catalog-as-complete", "unmatched-start-dropped", "provider-elision"];
  for (const control of negativeControls) assert.ok(required.includes(control), `unknown fork-free negative control ${control}`);
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", contract], { cwd: workspaceRoot, encoding: "utf8", timeout: 90_000 });
  assert.equal(result.error, undefined, `fork-free contract process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `fork-free contract failed: ${result.stderr || result.stdout}`);
  assert.deepEqual(JSON.parse(result.stdout), { status: "pass", checks: 16 });
  return {
    suite: "fork-free-contract", status: "pass",
    checks: [
      { id: "public-current-catalog-only", status: "pass", details: "Catalog identity is accepted only from current sdk.skills list/getContent/listFiles snapshots." },
      { id: "exact-prompt-mention", status: "pass", details: "Probe seq 1 proves only the explicit $bb-performant-react prompt mention." },
      { id: "joined-command-candidate", status: "pass", details: "Probe seq 32/33 correlates one shell-wrapped joined command with registered-path candidates and its enclosing outcome." },
      { id: "fail-closed-replay-and-coverage", status: "pass", details: "Conflicts reject, containment holds, missing catalog is unknown coverage, and historical revisions remain unknown." },
      { id: "post-transition-current-capture", status: "pass", details: "thread.created/thread.active and refresh captures carry complete-or-failed state and never stand in for launch-time staging." },
      { id: "truncation-and-pending-candidate", status: "pass", details: "Truncated file lists cannot become exact snapshots, and unmatched starts remain pending lexical candidates with no outcome." },
      { id: "nullable-catalog-provider", status: "pass", details: "The exact nullable sdk.skills provider value preserves Codex and provider-neutral entries without elision." },
    ],
    observations: [
      { id: "thr-tn5pxvdf7j-seq-1", kind: "prompt", status: "observed", details: "Exact prompt mention retained; it does not prove loading or activation." },
      { id: "thr-tn5pxvdf7j-seq-32-33", kind: "command", status: "observed", details: "Correlated command outcome retains lexical registered-path candidates, not individual file reads." },
      { id: "aggregate-token-limit", kind: "tokens", status: "unsupported", details: "Thread/context token rows remain aggregate-only and have no skill allocation." },
    ],
    limits: ["A successful joined shell command proves neither individual read, provider delivery, activation, instruction effect, nor token consumption.", "Current snapshots do not reconstruct the historical catalog or revision at an earlier event."],
  };
}
