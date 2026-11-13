import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
const cli = process.env.BB_TOOLCHAIN_CLI ?? fileURLToPath(new URL("../../../../fork/build/bb/apps/cli/dist/index.js", import.meta.url));
const build = spawnSync(process.execPath, [cli, "plugin", "build", "."], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
const dist = resolve("dist");
const app = JSON.parse(readFileSync(resolve(dist, "app.meta.json"), "utf8"));
const server = JSON.parse(readFileSync(resolve(dist, "server.meta.json"), "utf8"));
if (app.sdkVersion !== server.sdkVersion || JSON.stringify(app.builtWith) !== JSON.stringify(server.builtWith)) throw Error("App/server toolchain stamps differ.");
if (app.artifactFormatVersion !== 2 || !/^[a-f0-9]{32}$/.test(app.appArtifact?.generation)) throw Error("Expected public generation-based app artifact.");
const generation = resolve(dist, ".bb-artifacts", app.appArtifact.generation);
for (const file of app.appArtifact.files) {
  if (isAbsolute(file.path) || relative(dist, resolve(dist, file.path)).startsWith("..")) throw Error("Invalid artifact path.");
  const source = resolve(generation, file.path), bytes = readFileSync(source);
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw Error("Artifact integrity mismatch: " + file.path);
  // Mutable-path runtimes inspect dist/app.js freshness even with format-2 metadata.
  // Keep exact generated compatibility copies; metadata and immutable generations remain authoritative.
  const target = resolve(dist, file.path);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
console.log("Verified app generation, chunks, hashes and matching toolchain; refreshed exact mutable-path compatibility assets.");
