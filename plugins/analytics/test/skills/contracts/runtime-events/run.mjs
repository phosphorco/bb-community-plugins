import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../..");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "schema-contract.ts");

export async function runSuite() {
  const result = spawnSync(
    "pnpm",
    ["--dir", upstream, "exec", "tsx", contract],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 90_000,
    },
  );
  assert.equal(
    result.error,
    undefined,
    `schema contract process error: ${result.error?.message ?? "none"}`,
  );
  assert.equal(
    result.status,
    0,
    `schema contract failed: ${result.stderr || result.stdout}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.checks, 9);
  return {
    suite: "runtime-contract",
    status: "pass",
    checks: [
      {
        id: "durable-skill-observation-schema",
        status: "pass",
        details:
          "The real domain and bridge schemas accept a qualified nullable-turn Claude context report.",
      },
      {
        id: "contract-negative-controls",
        status: "pass",
        details:
          "Real schema parsing rejects stale revisions, missing nullable turn identity, unsupported-to-zero coercion, aggregate apportionment, and mismatched enclosing event identity.",
      },
    ],
    observations: [
      {
        id: "codex-per-skill-attribution",
        kind: "capability",
        status: "unsupported",
        details:
          "The contract represents unavailable Codex per-skill measurements as null/unsupported; it does not manufacture allocation from aggregate usage.",
      },
      {
        id: "claude-qualified-read-and-frontmatter",
        kind: "capability",
        status: "observed",
        details:
          "Registered SKILL.md/subtree reads and named frontmatter context are distinct qualified evidence kinds and method partitions.",
      },
    ],
    limits: [
      "This contract defines durable payloads and bridge vocabulary; provider instrumentation and retention are separate planned nodes.",
    ],
  };
}
