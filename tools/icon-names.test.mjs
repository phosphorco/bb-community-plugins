import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = join(root, "plugins");
const builtin = new Set(JSON.parse(readFileSync(join(root, "tools/bb-builtin-icons.json"), "utf8")));
const skippedDirs = new Set(["dist", "node_modules", "test", "tests", "vendor"]);

function plugins() {
  return readdirSync(pluginsDir)
    .filter((id) => existsSync(join(pluginsDir, id, "package.json")))
    .map((id) => {
      const manifest = JSON.parse(readFileSync(join(pluginsDir, id, "package.json"), "utf8"));
      return { id, dir: join(pluginsDir, id), branding: manifest.bb?.branding ?? {} };
    });
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return skippedDirs.has(entry) ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

test("branding icons resolve instead of falling back to Zap", () => {
  const problems = [];
  for (const { id, dir, branding } of plugins()) {
    const icon = branding.icon;
    if (icon === undefined) continue;
    if (icon.startsWith("./")) {
      if (!icon.endsWith(".svg") || !existsSync(join(dir, icon))) problems.push(`${id}: branding.icon ${icon} is not an existing .svg`);
    } else if (!builtin.has(icon)) {
      problems.push(`${id}: branding.icon "${icon}" is not a BB built-in icon; draw ./icons/<name>.svg instead`);
    }
    for (const [name, path] of Object.entries(branding.experimental_icons ?? {})) {
      if (!existsSync(join(dir, path))) problems.push(`${id}: experimental_icons.${name} ${path} is missing`);
    }
  }
  assert.deepEqual(problems, []);
});

test("slot icon names resolve to a built-in, declared asset, or registered component", () => {
  const problems = [];
  for (const { id, dir, branding } of plugins()) {
    const files = sourceFiles(dir);
    const sources = files.map((file) => readFileSync(file, "utf8"));
    const registered = new Set(sources.flatMap((source) =>
      [...source.matchAll(/experimental_icons\.register\(\{\s*name:\s*"([^"]+)"/g)].map((match) => match[1])));
    const declared = new Set(Object.keys(branding.experimental_icons ?? {}).map((name) => `${id}/${name}`));
    files.forEach((file, index) => {
      for (const match of sources[index].matchAll(/\bicon:\s*"([^"]+)"/g)) {
        const name = match[1];
        const namespaced = /^[a-z0-9-]+\/[a-z0-9-]+$/.test(name);
        const builtinShaped = /^[A-Z][A-Za-z0-9]*$/.test(name);
        if (namespaced ? registered.has(name) || declared.has(name) : !builtinShaped || builtin.has(name)) continue;
        problems.push(`${file.slice(root.length + 1)}: icon "${name}" does not resolve`);
      }
    });
  }
  assert.deepEqual(problems, []);
});
