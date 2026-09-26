import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("optional analytics execution and chart kernels have explicit demand boundaries", async () => {
  const app = await readFile(new URL("../../app.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../../frontend/analytics-panel.tsx", import.meta.url), "utf8");
  const contract = await readFile(new URL("../../docs/isolation/frontend/lazy-artifact-contract.md", import.meta.url), "utf8");

  assert.match(app, /lazy\(\(\) => import\("\.\/frontend\/analytics-panel\.tsx"\)\)/u);
  assert.doesNotMatch(app, /browser-engine|echarts|duckdb|SkillsDashboard/u);
  assert.match(panel, /await import\("\.\.\/browser-engine\.ts"\)/u);
  assert.match(panel, /await import\("\.\.\/echarts-figure\.tsx"\)/u);
  assert.doesNotMatch(panel, /import\s*\{\s*getBrowserAnalyticsEngine\s*\}\s*from/u);
  assert.match(panel, /Exact values remain available below/u);
  assert.match(contract, /metadata-only catalog read does not fetch an entry or\s+chunk/u);
});
