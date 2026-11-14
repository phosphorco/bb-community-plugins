import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const tests = readdirSync(new URL("../test/", import.meta.url))
  .filter(name => /\.test\.tsx?$/.test(name)).sort();
if (!tests.length) throw new Error("No template tests found");
const browser = tests.filter(name => name.startsWith("browser"));
const unit = tests.filter(name => !name.startsWith("browser"));
for (const files of [unit, ...browser.map(name => [name])]) {
  if (!files.length) continue;
  const result = spawnSync("bun", ["test", ...files.map(name => "test/" + name)], {
    cwd: root, stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
