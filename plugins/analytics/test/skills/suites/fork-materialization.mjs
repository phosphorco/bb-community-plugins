import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(directory, "../../../../../../");
const forkRoot = resolve(workspaceRoot, "fork");
const patchName = "0022-feat-skills-observe-runtime-and-provider-lifecycle.patch";
const expectedTree = "bfacd151959096718616ca80061c6b8de1fb715b";

async function text(path) {
  return readFile(resolve(forkRoot, path), "utf8");
}

export async function runSuite() {
  const [series, checksums, tree, downstream, evidence, patch] = await Promise.all([
    text("patches/series"),
    text("patches/sha256"),
    text("result-tree.lock"),
    text("DOWNSTREAM.md"),
    readFile(resolve(workspaceRoot, "plans/skills-analytics/evidence/fork-materialization.md"), "utf8"),
    readFile(resolve(forkRoot, "patches", patchName)),
  ]);
  const digest = createHash("sha256").update(patch).digest("hex");
  const seriesEntries = series.trim().split("\n");
  const checksumLine = checksums.split("\n").find((line) => line.endsWith(`  ${patchName}`));

  assert.equal(seriesEntries.at(-1), patchName, "skills patch must be the final ordered queue entry");
  assert.equal(checksumLine, `${digest}  ${patchName}`, "queue checksum must match exact patch bytes");
  assert.equal(tree.trim(), expectedTree, "result tree must match the reviewed replay receipt");
  assert.match(downstream, /twenty-two logical patches/);
  assert.match(downstream, /Skills runtime and provider lifecycle observations/);
  assert.match(evidence, new RegExp(expectedTree));
  assert.match(evidence, new RegExp(digest));

  return {
    suite: "fork-materialization",
    status: "pass",
    checks: [
      { id: "ordered-queue-entry", status: "pass", details: patchName },
      { id: "patch-checksum", status: "pass", details: digest },
      { id: "result-tree-receipt", status: "pass", details: expectedTree },
      { id: "documented-source-receipt", status: "pass", details: "DOWNSTREAM and evidence bind the same queue and result tree." },
    ],
    observations: [],
    limits: ["The repository-level oracle runs fork/scripts/verify separately to replay the complete queue in a disposable worktree."],
  };
}
