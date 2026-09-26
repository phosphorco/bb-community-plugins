import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../..");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "retention-surface.ts");

export async function runSuite() {
  const result = spawnSync(
    "pnpm",
    ["--dir", upstream, "exec", "tsx", contract],
    { cwd: workspaceRoot, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(
    result.error,
    undefined,
    `retention surface process error: ${result.error?.message ?? "none"}`,
  );
  assert.equal(
    result.status,
    0,
    `retention surface failed: ${result.stderr || result.stdout}`,
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.equal(report.checks, 7);
  return {
    suite: "retention-surface",
    status: "pass",
    checks: [
      {
        id: "bridge-to-durable-skill-observation",
        status: "pass",
        details:
          "A real extension-state bridge payload becomes one typed skill/observed event and is retained through a SQLite reopen.",
      },
      {
        id: "prospective-public-source-coverage",
        status: "pass",
        details:
          "The public reader labels the interval before its first retained observation unknown instead of treating it as zero usage.",
      },
      {
        id: "retention-negative-controls",
        status: "pass",
        details:
          "Mismatched thread identity and oversized raw evidence are rejected at the bridge boundary; old non-skill events remain readable after restart.",
      },
    ],
    observations: [
      {
        id: "unsupported-codex-signal",
        kind: "capability",
        status: "unsupported",
        details:
          "Unsupported evidence is retained explicitly with null measurements rather than converted to a zero-valued skill metric.",
      },
    ],
    limits: [
      "This surface allocates durable transport and public-source semantics only; provider-specific emission and Analytics projection remain separate nodes.",
    ],
  };
}
