import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const upstream = resolve(workspaceRoot, "fork/upstream");
const fixture = resolve(
  directory,
  "../fixtures/providers/catalog-identity/provider-catalog-identity.ts",
);

function run(args, label) {
  const result = spawnSync("pnpm", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 45_000,
  });
  assert.equal(result.error, undefined, `${label} process error: ${result.error?.message ?? "none"}`);
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function runSuite() {
  const fixtureOutput = run(["--dir", upstream, "exec", "tsx", fixture], "canonical catalog fixture");
  const fixtureReport = JSON.parse(fixtureOutput);
  assert.equal(fixtureReport.status, "pass");
  assert.deepEqual(fixtureReport.checks, [
    "typed-canonical-root",
    "staged-read-canonical-attribution",
    "same-name-ambiguity",
  ]);
  run(
    [
      "--dir",
      upstream,
      "--filter",
      "bb-plugin-provider-codex",
      "test",
      "--",
      "src/bridge/bridge.skill-observation.test.ts",
      "--maxWorkers=1",
    ],
    "Codex configured catalog revision",
  );
  return {
    suite: "provider-catalog-identity",
    status: "pass",
    checks: [
      {
        id: "canonical-root-identity",
        status: "pass",
        details: "The staged runtime root transports the server catalog identity and revision without deriving a staged-copy identity.",
      },
      {
        id: "claude-staged-read-evidence",
        status: "pass",
        details: "Claude retains the staged Read path as evidence while emitting the common catalog's canonical identity and content revisions.",
      },
      {
        id: "same-name-ambiguity-and-codex-revision",
        status: "pass",
        details: "Same-name Claude reports require exact registered identity when ambiguous, and Codex unsupported observations retain the configured root catalog revision without a skill claim.",
      },
    ],
    observations: [
      {
        id: "canonical-provider-catalog",
        kind: "catalog",
        status: "observed",
        details: "The fixture exercises the host staging, typed protocol, and Claude production implementation together.",
      },
      {
        id: "codex-native-attribution",
        kind: "provider",
        status: "unsupported",
        details: "Codex native skill notifications remain unsupported and skill-null.",
      },
    ],
    limits: [
      "A Claude name-only frontmatter report is intentionally not attributed when multiple canonical skills share that name.",
    ],
  };
}
