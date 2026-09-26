import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("ECharts is only referenced through demand-loaded chart surfaces", async () => {
  const source = await readFile(new URL("../app.tsx", import.meta.url), "utf8");

  assert.match(source, /lazy\(async \(\) => \{\s*const module = await import\("\.\/timeline-chart\.tsx"\)/s);
  assert.doesNotMatch(source, /import\s*\{[^}]*FleetUtilizationChart[^}]*\}\s*from\s*"\.\/timeline-chart\.tsx"/u);
  assert.match(source, /<ChartChunkBoundary label="full metric timeline">/u);
  assert.match(source, /role="status"/u);
});
