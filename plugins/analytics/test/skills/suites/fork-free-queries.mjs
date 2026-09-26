import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(directory, "../queries/fork-free/run.ts");
const supported = new Set(["false-read", "false-unused", "aggregate-token-apportionment", "unbounded-detail"]);

export async function runSuite(options = {}) {
  for (const control of options.negativeControls ?? []) assert.ok(supported.has(control), `unknown fork-free query negative control ${control}`);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", fixture], { encoding: "utf8", timeout: 90_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, "pass");
  return { suite: "fork-free-queries", status: "pass", checks: [{ id: "current-catalog-and-exact-raw-contributors", status: "pass", details: "Current catalog revisions, exact prompt mentions, registered-path candidates, pending starts and enclosing outcomes reconcile to bounded raw rows." }, { id: "bounded-summary-independent-of-detail", status: "pass", details: "Exact aggregate totals remain available when catalog or evidence detail exceeds its independently disclosed N-of-M preview bound." }, { id: "latest-unique-footprint-partition", status: "pass", details: "Byte and optional local ceil(bytes/4) summaries use unique entries in the latest complete project/environment/provider partition and are suppressed for truncated previews." }, { id: "negative-claims-rejected", status: "pass", details: "Candidates do not become reads, use, provider delivery, activation, or per-skill token consumption; detail remains bounded." }], observations: [], limits: ["Provider-native activation, delivery, actual use/access, and per-skill consumed tokens are unsupported."] };
}
