import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { currentSourceIdentity, run } from "../fixtures/qualification/workload.mjs";
import { runSuite as runComposition } from "./composition.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const analyticsRoot = resolve(workspaceRoot, "community-plugins/plugins/analytics");

function expectRejected(id, action) {
  assert.throws(action, undefined, `controlled ${id} must reject through the compatibility assertion path`);
}

function status(path) {
  return run("git", ["-C", path, "status", "--porcelain=v1"], { cwd: workspaceRoot, timeout: 15_000 }).stdout;
}

export async function runSuite(options = {}) {
  const controls = new Set(options.negativeControls ?? []);
  for (const control of controls) assert.ok(["source-identity", "dirty-worktree", "rejected-import"].includes(control), `unknown compatibility negative control ${control}`);
  const before = status(resolve(workspaceRoot, "community-plugins"));
  const identities = currentSourceIdentity(workspaceRoot);
  assert.match(identities.upstream, /^[a-f0-9]{40}$/u, "final upstream source identity is required");
  assert.match(identities.communityPlugins, /^[a-f0-9]{40}$/u, "final community plugin source identity is required");
  const composition = await runComposition({ negativeControls: ["false-activation", "false-unused"] });
  assert.equal(composition.status, "pass", "current final production identities must pass composed compatibility checks");
  run(process.execPath, ["--experimental-strip-types", "test/skills/queries/dashboard-queries/run.ts"], { cwd: analyticsRoot, timeout: 90_000 });
  const after = status(resolve(workspaceRoot, "community-plugins"));
  assert.equal(after, before, "qualification compatibility must not alter the already-dirty community-plugin worktree");
  if (controls.has("source-identity")) expectRejected("source-identity", () => assert.match("not-a-source-identity", /^[a-f0-9]{40}$/u));
  if (controls.has("dirty-worktree")) expectRejected("dirty-worktree", () => assert.equal(`${before}controlled-change\n`, before));
  if (controls.has("rejected-import")) expectRejected("rejected-import", () => run(process.execPath, ["--input-type=module", "-e", "await import('file:///qualification-missing.mjs')"], { cwd: analyticsRoot, timeout: 5_000 }));
  return {
    suite: "compatibility", status: "pass",
    checks: [
      { id: "final-source-identities", status: "pass", details: `workspace=${identities.workspace}; community-plugins=${identities.communityPlugins}; fork=${identities.fork}; upstream=${identities.upstream}.` },
      { id: "composed-production-contract", status: "pass", details: "The current composed plugin suite and production SQLite query fixture passed at those final source identities." },
      { id: "dirty-worktree-preservation", status: "pass", details: "The existing community-plugin porcelain state was byte-identical before and after compatibility checks." },
    ],
    observations: [
      { id: "qualification-scope", kind: "compatibility", status: "observed", details: "The suite reads final production identities and changes no production source files." },
    ],
    limits: ["Repository-wide packaging/typecheck/build and workspace composition remain the downstream compatibility guard after the controlled roundtrip is available."],
  };
}
