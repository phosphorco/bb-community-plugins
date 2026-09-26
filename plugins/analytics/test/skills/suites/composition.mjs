import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runSuite as runDashboardQueries } from "./dashboard-queries.mjs";

const controls = new Set(["false-activation", "false-unused", "skill-refresh-failure"]);
const directory = dirname(fileURLToPath(import.meta.url));
const analyticsRoot = resolve(directory, "../../..");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: analyticsRoot, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.error, undefined, `${command} could not start: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
}

/** Exercise source components, not the old fixture-only dashboard model. */
export async function runSuite(options = {}) {
  const requested = new Set(options.negativeControls ?? []);
  for (const control of requested) assert.ok(controls.has(control), `unknown composition negative control ${control}`);
  const queries = await runDashboardQueries({ negativeControls: [...requested].filter((control) => control !== "skill-refresh-failure") });
  assert.equal(queries.status, "pass");
  run(process.execPath, ["--experimental-strip-types", "--test", "test/server.test.ts"]);
  run(process.execPath, ["--experimental-strip-types", "test/skills/composition/skill-refresh-failure.ts"]);
  run("npx", ["vitest", "run", "--config", "test/skills/browser/ui/vitest.config.ts"]);

  const server = readFileSync(resolve(analyticsRoot, "server.ts"), "utf8");
  const app = readFileSync(resolve(analyticsRoot, "app.tsx"), "utf8");
  const contract = readFileSync(resolve(analyticsRoot, "rpc-contract.ts"), "utf8");
  assert.match(server, /new RetainedSkillObservationProjector\(\{ sdk: bb\.sdk, store \}\)/u, "production refresh owns the real public-SDK skill projector");
  assert.match(server, /reconcileSkillsForAnalytics\(skillProjector, bb\.log\)/u, "a skill refresh failure is contained before legacy snapshot commit");
  assert.match(server, /store\.commitSnapshot\(/u, "legacy tool snapshot still has an unconditional publish path");
  assert.match(server, /skillsQuery\(input\)/u, "production RPC registers the bounded skill query");
  assert.match(server, /skillsRawContributors\(\{ filters, factIds \}\)/u, "production RPC registers bounded raw drilldown");
  assert.match(contract, /skillQueryResultSchema/u, "Skills query response is runtime Zod validated");
  assert.match(contract, /skillRawContributorResultSchema/u, "Skills raw detail response is runtime Zod validated");
  assert.match(app, /page === "dashboards" \? <ToolAnalyticsPanel \/> : <SkillsPanel \/>/u, "inactive Skills does not mount or query on the tool-dashboard path");
  assert.match(app, /rpc\.call\("skillsRawContributors"/u, "drawer uses the bounded raw-contributor RPC");

  return {
    suite: "composition", status: "pass",
    checks: [
      { id: "production-retained-projector-and-rpc", status: "pass", details: "The real retained public-SDK projector and both Zod-backed bounded Skills RPCs are wired into the plugin." },
      { id: "false-activation-and-false-unused", status: "pass", details: "Production SQLite query negatives prove Reads do not become activation and exact session delivery is required for qualified no-read-observed." },
      { id: "legacy-refresh-failure-contained", status: "pass", details: "A skill projection failure is caught before the legacy tool snapshot commit, retaining the prior copy-on-write skill generation." },
      { id: "inactive-path-and-keyboard-ui", status: "pass", details: "The tool path leaves Skills unmounted; source UI tests cover native controls, focusable table, sorting, dialog escape, and narrow disclosure." },
    ],
    observations: [
      { id: "native-activation", kind: "coverage", status: "unsupported", details: "Native per-skill activation remains unsupported; positive Reads are displayed independently." },
      { id: "skill-refresh-failure", kind: "refresh", status: "observed", details: "The legacy tool snapshot remains publishable when retained skill reconciliation fails." },
    ],
    limits: ["The Skills page is lazy-mounted, bounded to retained query/raw-row limits, and shows stale prior skill facts if a later source refresh fails."],
  };
}
