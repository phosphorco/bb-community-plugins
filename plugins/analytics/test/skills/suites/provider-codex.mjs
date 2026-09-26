import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const upstream = resolve(workspaceRoot, "fork/upstream");
const contract = resolve(directory, "../fixtures/providers/skill-observation-v1-contract.ts");

function runContract() {
  const result = spawnSync("pnpm", ["--dir", upstream, "exec", "tsx", contract, "provider-codex"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 25_000,
  });
  assert.equal(result.error, undefined, `Codex contract process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `Codex contract failed: ${result.stderr || result.stdout}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "pass");
  assert.deepEqual(report.checks, ["unsupported-native-attribution", "aggregate-unassigned", "aggregate-apportionment-rejected"]);
}

export async function runSuite() {
  runContract();
  return {
    suite: "provider-codex",
    status: "pass",
    checks: [
      { id: "codex-native-attribution-unsupported", status: "pass", details: "The controlled native skills notification is represented as unsupported, with no invented activation, read, body, or per-skill token evidence." },
      { id: "aggregate-token-unassigned", status: "pass", details: "Codex aggregate thread usage has no skill and uses aggregate-unassigned attribution." },
      { id: "aggregate-apportionment-negative-control", status: "pass", details: "The controlled fixture that attaches aggregate provider usage to a skill is rejected by SkillObservation v1." },
    ],
    observations: [
      { id: "codex-bridge-configure", kind: "bridge", status: "observed", details: "Bridge acknowledgement is retained separately from provider-native observation." },
      { id: "codex-native-skill-signal", kind: "provider", status: "unsupported", details: "No supported native per-skill attribution is claimed from the controlled Codex signal." },
      { id: "codex-aggregate-usage", kind: "measurement", status: "observed", details: "Aggregate usage is provider-scoped and explicitly unassigned to every skill." },
    ],
    limits: ["Codex aggregate usage can support session or turn totals only; this instrument deliberately cannot infer per-skill consumption."],
  };
}
