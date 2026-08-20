import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(pluginRoot, "../..");

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("Agentation to Mentions has one distinct package, collection, runtime, and release identity", () => {
  const manifest = readJson(join(pluginRoot, "package.json"));
  const collection = readJson(join(repositoryRoot, ".bb/plugins.json"));
  const workflow = readFileSync(join(repositoryRoot, ".github/workflows/publish.yml"), "utf8");
  const server = readFileSync(join(pluginRoot, "server.ts"), "utf8");

  assert.equal(manifest.name, "@phosphorco/bb-plugin-agentation-mentions");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.bb.name, "Agentation → Mentions");
  assert.equal(manifest.repository.directory, "plugins/agentation-mentions");
  assert.equal(
    collection.plugins.some(
      (entry: { name: string; source: string }) =>
        entry.name === "agentation-mentions" &&
        entry.source === "./plugins/agentation-mentions",
    ),
    true,
  );
  assert.match(workflow, /agentation-mentions\/v\*/);
  assert.match(
    workflow,
    /agentation-mentions\) workspace="@phosphorco\/bb-plugin-agentation-mentions"/,
  );
  assert.match(server, /name: "agentation-mentions"/);
  assert.match(server, /name: "agentation_mentions_get_all_pending"/);
});

test("the bundled Agentation dependency preserves React 19 component paths in production", () => {
  const vendorBundle = join(pluginRoot, "vendor/agentation/dist/index.mjs");
  assert.equal(
    existsSync(vendorBundle),
    true,
    "expected the reviewed Agentation 3.0.2 vendored build",
  );

  const source = readFileSync(vendorBundle, "utf8");
  assert.match(source, /key\.startsWith\("__reactContainer\$"\)/);
  assert.match(
    source,
    /process\.env\.NODE_ENV === "development" \|\| isReactPage\(\)/,
  );
});

test("the manifest and package preserve the complete approved AM02-A receipt", () => {
  const manifest = readJson(join(pluginRoot, "package.json"));
  assert.equal(manifest.bb.branding.icon, "AtSign");
  assert.equal(manifest.bb.branding.logo.light, "./assets/icon-32.png");
  assert.deepEqual(
    Object.fromEntries(
      ["icon-source.png", "icon-16.png", "icon-24.png", "icon-32.png"].map((name) => [
        name,
        sha256(join(pluginRoot, "assets", name)),
      ]),
    ),
    {
      "icon-source.png": "3a263167ba31f16abeb6b494dbc4ebd6805901d1fc9dc7cd7c6e4b67628c6a3b",
      "icon-16.png": "3581d070371a8e6fb1455a49237d58ee53205c2a9687bb5096c3d3d8cd2e3ac0",
      "icon-24.png": "ce3b9b9ac2cdbc949b829590a60c079150719ba7185a0e157513254907f0e84a",
      "icon-32.png": "6a640b4cb701af1c0571e2659058dabccd054a41a98141924d75debb098ca4b1",
    },
  );
});
