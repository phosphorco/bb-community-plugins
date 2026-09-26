import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const controls = new Set(["core-event-dependency", "false-read", "false-unused", "cross-partition-concurrency", "repeated-active-rescan", "selected-snapshot-coverage", "detached-lifecycle-capture", "blocking-stale-query"]);
const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");

export async function runSuite(options = {}) {
  for (const control of options.negativeControls ?? []) assert.ok(controls.has(control), `unknown fork-free composition negative control ${control}`);
  // The isolation ADR supersedes the old requirement to keep lifecycle
  // handlers alive through a queued full-project capture. Exercise production
  // registration and retained RPCs, not a regex claiming that queue is safe.
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", "test/capture-budget.test.ts", "test/capture-publication.test.ts", "test/skills-host-containment.test.ts"], { cwd: analyticsRoot, encoding: "utf8", timeout: 120_000 });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const server = readFileSync(resolve(analyticsRoot, "server.ts"), "utf8");
  const app = readFileSync(resolve(analyticsRoot, "app.tsx"), "utf8");
  assert.doesNotMatch(server, /skill\/observed/u, "fork-free production composition has no core skill event dependency");
  assert.doesNotMatch(server, /bb\.events\.on\(/u, "Analytics must not collect from thread lifecycle handlers");
  assert.doesNotMatch(server, /bb\.sdk\b|AnalyticsRefreshCoordinator/u, "server cannot reconnect feature-owned source capture");
  assert.doesNotMatch(server, /bootstrapSkills\(/u, "query and tool refresh cannot discover/capture Skills partitions");
  assert.doesNotMatch(server, /refreshStaleSkillsInBackground/u, "a populated Skills RPC never detaches DB-backed projector work beyond its invocation");
  assert.doesNotMatch(server, /selectedPartitions\.map\(\(partition\) => enqueueSkillCapture/u, "a populated Skills query returns retained rows without starting a stale projector capture");
  assert.match(app, /page === "dashboards" \? <ToolAnalyticsPanel \/> : <SkillsPanel \/>/u, "inactive dashboard path does not mount Skills");
  return {
    suite: "fork-free-composition", status: "pass",
    checks: [
      { id: "no-lifecycle-capture", status: "pass", details: "Real production registration creates no source lifecycle handlers." },
      { id: "retained-only-cold-query", status: "pass", details: "Repeated cold queries return synchronously without any immediate or detached source SDK calls." },
      { id: "aggregate-admission", status: "pass", details: "A thousand concurrent attempts cannot queue captures; cancellation retains the slot until the underlying call settles, followed by cooldown." },
      { id: "cumulative-source-budgets", status: "pass", details: "Whole-capture request and response-byte bounds prevent further SDK reads." },
      { id: "bounded-generation-cache", status: "pass", details: "Retained query reuse separates parameters and generations, protects shared values, and evicts at entry and byte limits." },
    ],
    observations: [],
    limits: ["Capture budget tests are historical offline probes; all production refresh entrypoints fail closed. Provider-native activation, access, and use remain unsupported. OS/process isolation and frontend boot acceptance remain separate."],
  };
}
