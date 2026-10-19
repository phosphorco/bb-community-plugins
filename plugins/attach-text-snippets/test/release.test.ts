import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginId = "attach-text-snippets";

test("community collection and publish workflow carry the plugin identity", async () => {
  const [collectionSource, workflowSource, packageSource] = await Promise.all([
    readFile(new URL("../../../.bb/plugins.json", import.meta.url), "utf8"),
    readFile(new URL("../../../.github/workflows/publish.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  const collection = JSON.parse(collectionSource) as {
    plugins: Array<{ name: string; source: string }>;
  };
  const manifest = JSON.parse(packageSource) as {
    name: string;
    engines: { bb: string };
  };

  assert.deepEqual(
    collection.plugins.find((plugin) => plugin.name === pluginId),
    { name: pluginId, source: `./plugins/${pluginId}` },
  );
  assert.equal(manifest.name, "@phosphorco/bb-plugin-attach-text-snippets");
  assert.equal(manifest.engines.bb, ">=0.42.0 <1.0.0");
  assert.match(workflowSource, /- attach-text-snippets/u);
  assert.match(workflowSource, /- "attach-text-snippets\/v\*"/u);
  assert.match(
    workflowSource,
    /attach-text-snippets\) workspace="@phosphorco\/bb-plugin-attach-text-snippets"/u,
  );
});
