import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(directory, "../../../../../../");
const provider = resolve(workspace, "fork/upstream/plugins/provider-claude-code");
const result = spawnSync(
  "pnpm",
  [
    "--dir",
    provider,
    "exec",
    "vitest",
    "run",
    "src/bridge/__tests__/skill-instrumentation.test.ts",
    "src/bridge/__tests__/context-usage.test.ts",
    "src/bridge/bridge.conformance.test.ts",
  ],
  { cwd: workspace, encoding: "utf8", timeout: 60_000 },
);

assert.equal(result.error, undefined, result.error?.message);
assert.equal(result.status, 0, result.stderr || result.stdout);
