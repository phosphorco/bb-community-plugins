import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the manifest uses the exact approved PE02-A PNG as its rich logo", () => {
  const manifest = JSON.parse(
    readFileSync(join(pluginRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.devDependencies["bb-app"], "0.42.0");
  assert.equal(manifest.bb.branding.icon, "Search");
  assert.equal(manifest.bb.branding.logo.light, "./assets/icon-32.png");

  const iconPath = join(pluginRoot, manifest.bb.branding.logo.light);
  assert.equal(existsSync(iconPath), true, "manifest icon must exist");
  const bytes = readFileSync(iconPath);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.deepEqual(
    Object.fromEntries(
      ["icon-source.png", "icon-16.png", "icon-24.png", "icon-32.png"].map((name) => [
        name,
        createHash("sha256").update(readFileSync(join(pluginRoot, "assets", name))).digest("hex"),
      ]),
    ),
    {
      "icon-source.png": "f3afe654da34242b63657dbf5971ccfd4fc1aa7f2f439e91036c60ae3af69249",
      "icon-16.png": "4772cb7ede60a244f858e9c1d3a91e5ebf8e25bb36ab5935f917635dc9e2f207",
      "icon-24.png": "c0de78601fdf140a1acf3b18463bd6d6f051016c27baa5eaa10549d7f4d5c9dc",
      "icon-32.png": "30810901dcda2e91cf90e945a11df8bf10a99ae5d0eb09c9c428aef33fdb381d",
    },
  );
});
