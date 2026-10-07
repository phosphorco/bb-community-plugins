import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const evidence = JSON.parse(readFileSync(resolve(here, "sources.json"), "utf8"));

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.activeSources.pluginGuide.resolved, "builtin:plugin-api-docs");
assert.equal(evidence.activeSources.uiReference.resolved,
  "path:/home/ubuntu/bb/community-plugins/plugins/bb-ui-reference");
assert.ok(evidence.sources.length > 30, "complete source inventories must be present");
assert.ok(evidence.registryObservation.packages.every(p => p.version && p.gitHead));

for (const entry of evidence.sources) {
  const bytes = readFileSync(resolve(root, entry.path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  assert.equal(actual, entry.sha256, `changed discovery source: ${entry.path}`);
}

const donor = path => readFileSync(resolve(root,
  "fork/build/bb/plugins/plugin-api-docs", path), "utf8");
assert.match(donor("app.tsx"), /title: "Plugin Guide"/);
assert.match(donor("src/agent-reference.ts"), /PLUGIN_GUIDE_PLUGIN_ID = "plugin-api-docs"/);
assert.match(donor("src/product-map.tsx"), /slides\.map\(/);
assert.match(donor("src/product-map.tsx"), /transition-transform duration-300/);
assert.match(donor("src/product-map.tsx"), /setAnimate\(false\), 350/);
const reference = readFileSync(resolve(root,
  "community-plugins/plugins/bb-ui-reference/app.tsx"), "utf8");
assert.match(reference, /app\.slots\.sidebarFooterAction/);
assert.match(reference, /app\.contentScripts\.register/);
assert.match(reference, /frame\.hidden = true/);
console.log(`Verified historical source discovery: ${evidence.sources.length} files; no implementation behavior is claimed.`);
