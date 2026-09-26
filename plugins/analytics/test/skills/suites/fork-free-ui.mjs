import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(directory, "../browser/fork-free/dashboard-semantics.mjs");

export async function runSuite(options = {}) {
  assert.deepEqual(options.negativeControls ?? [], [], "fork-free-ui has no independent negative-control flags");
  const result = spawnSync(process.execPath, [fixture], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "pass");
  return { suite: "fork-free-ui", status: "pass", checks: [{ id: "first-principles-summary", status: "pass", details: "The first screen presents current BB-visible skills, prompt mentions, registered-path candidates, and unsupported provider-native use/access." }, { id: "truthful-footprint-and-empty-states", status: "pass", details: "Latest-snapshot unique-entry footprint estimates carry bytes, optional local estimate, method, tokenizer and N; coverage caveats explain empty evidence." }, { id: "bounded-outcomes-and-contributors", status: "pass", details: "Pending and completed command candidates retain enclosing outcome disclosure and bounded session/thread/event contributors." }], observations: [], limits: ["Candidates remain lexical path evidence only; provider delivery, actual use/access, native activation, and per-skill consumed tokens are unsupported."] };
}
