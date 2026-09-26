import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "../fixtures/providers/skill-observation-v1-contract.ts");

function runContract() {
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", contract, "provider-claude"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 25_000,
  });
  assert.equal(result.error, undefined, `Claude contract process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `Claude contract failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, ["conservative-read-containment", "nullable-estimated-frontmatter", "duplicate-and-late-snapshot-rejection"]);
}

export async function runSuite() {
  runContract();
  return {
    suite: "provider-claude",
    status: "pass",
    checks: [
      { id: "conservative-read-evidence", status: "pass", details: "Only a registered SKILL.md or contained subtree path is attributable; a same-name/outside-tree path is not evidence for this skill." },
      { id: "named-frontmatter-nullable-turn", status: "pass", details: "Named skills.skillFrontmatter context is estimated, method-tagged, exact-revision evidence with providerTurnId explicitly null." },
      { id: "duplicate-and-late-snapshots", status: "pass", details: "A duplicate shares its dedupe key and a late snapshot retains its old SKILL.md/tree revision, so neither can be counted as a new current-revision report." },
    ],
    observations: [
      { id: "claude-skill-md-read", kind: "provider", status: "observed", details: "A contained Read path proves that exact file read only; it is not activation or instruction effect." },
      { id: "claude-subtree-read", kind: "provider", status: "observed", details: "A contained descendant Read path is conservatively distinct from the registered SKILL.md read." },
      { id: "claude-frontmatter-context", kind: "measurement", status: "observed", details: "Named frontmatter tokens are provider-reported estimated context, not body/reference loading or attributable consumption." },
    ],
    limits: ["The instrument rejects stale/current conflation and duplicate counting; Read evidence remains non-causal and does not establish activation."],
  };
}
