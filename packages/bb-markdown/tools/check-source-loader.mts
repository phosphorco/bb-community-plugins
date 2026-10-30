/** Compiler-only regression. Run from community-plugins/packages/bb-markdown with:
 * BB_SOURCE_LOADER_ROOT=/home/ubuntu/bb/fork/build/bb bun tools/check-source-loader.mts
 * Requires installed workspace packages (including their built exports).
 * Never imports emitted plugin code or invokes a plugin factory.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = await realpath(resolve(import.meta.dirname, ".."));
const workspaceRoot = resolve(packageRoot, "../../..");
const pluginsRoot = await realpath(process.env.BB_SOURCE_LOADER_PLUGINS_ROOT ?? join(workspaceRoot, "plugins"));
const pilots = ["thread-brief", "btw"] as const;
const markdownExports = [
  ["@phosphorco/bb-markdown", "index.js"],
  ["@phosphorco/bb-markdown/bb", "bb.js"],
  ["@phosphorco/bb-markdown/server", "server.js"],
] as const;
const resolveImport = async (specifier: string, importer: string) =>
  realpath(fileURLToPath(import.meta.resolve(specifier, pathToFileURL(importer).href)));
interface PluginManifest {
  name: string;
  version: string;
  bb: { server: string };
  dependencies?: Record<string, string>;
}
const sourceRoot = await realpath(process.env.BB_SOURCE_LOADER_ROOT ?? "/home/ubuntu/bb/fork/build/bb");
const source = (path: string) => join(sourceRoot, path);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function provenance(path: string) {
  console.log(JSON.stringify({ path, sha256: sha(await readFile(path)) }));
}
const wrapperPath = source("apps/server/src/services/plugins/plugin-server-cache.ts");
const compilerPath = source("packages/plugin-build/src/build-plugin-server.ts");
const resolverPath = source("packages/plugin-build/src/toolchain.ts");
const callerPath = source("apps/server/src/services/plugins/plugin-runtime.ts");
for (const path of [wrapperPath, compilerPath, resolverPath, callerPath]) await provenance(path);

// Import only compiler modules, never plugin-runtime (which owns service behavior).
const { buildCachedPluginServer } = await import(pathToFileURL(wrapperPath).href);
const { resolvePluginBuildToolchain, PLUGIN_TOOLCHAIN_PINS } = await import(pathToFileURL(resolverPath).href);
const sdkManifest = JSON.parse(await readFile(source("packages/plugin-sdk/package.json"), "utf8"));
// Match the production bundled caller's module location, without executing it.
const runtimeCaller = source("apps/server/dist/start-server.js");
assert.ok(existsSync(runtimeCaller), `Missing production runtime caller: ${runtimeCaller}`);
const runtimeRequire = createRequire(runtimeCaller);
const sdkCandidate = join(dirname(runtimeCaller), "plugin-sdk-runtime.js");
const sdkEntry = existsSync(sdkCandidate) ? sdkCandidate : runtimeRequire.resolve("@get-bb/plugin-sdk");
const runtimeImports = {
  "@get-bb/plugin-sdk": { path: sdkEntry },
  "@bb/plugin-sdk": { path: sdkEntry },
  "better-sqlite3": { path: runtimeRequire.resolve("better-sqlite3"), external: true },
};
const fallbackResolve = (specifier: string): string | undefined => {
  try {
    const found = import.meta.resolve(specifier, pathToFileURL(runtimeCaller).href);
    return found.startsWith("file:") ? fileURLToPath(found) : found;
  } catch {}
  try { return runtimeRequire.resolve(specifier); } catch { return undefined; }
};
await provenance(sdkEntry);
console.log(JSON.stringify({ sourceRoot, pluginsRoot, packageRoot, pilots, runtimeCaller, runtimeImports,
  options: { format: "cjs", preserveSourceModuleLocation: true, externalizeSourceOutsideRoot: true },
  versions: { bun: process.versions.bun, node: process.versions.node, sdk: sdkManifest.version },
  pins: PLUGIN_TOOLCHAIN_PINS,
  bbVersion: "0.0.0-compiler-regression", // Artifact metadata only; no runtime version claim.
}));

// Resolve ESM public entries from the helper and each actual pilot independently.
// Normal registry installations may contain distinct physical copies of 0.4.1.
interface RecognitionEntry { owner: string; specifier: string; installed: string; packageRoot: string; version: string }
const recognitionEntries: RecognitionEntry[] = [];
const helperOwner = join(packageRoot, "dist/server.js");
for (const owner of [helperOwner, ...pilots.map(id => join(pluginsRoot, "plugins", id, "server.ts"))]) {
  let ownerPackageRoot: string | undefined;
  for (const entry of ["", "/bb"]) {
    const specifier = "@phosphorco/bb-context-recognition" + entry;
    const installed = await resolveImport(specifier, owner);
    const recognitionRoot = await realpath(resolve(dirname(installed), ".."));
    const manifestPath = join(recognitionRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, "@phosphorco/bb-context-recognition");
    assert.equal(manifest.version, "0.4.1", `${owner}: ${specifier} must resolve registry contract 0.4.1`);
    assert.equal(installed, await realpath(resolve(recognitionRoot, manifest.exports[entry ? "./bb" : "."].import)));
    if (ownerPackageRoot) assert.equal(recognitionRoot, ownerPackageRoot, `${owner}: root and /bb must belong to the same installed package`);
    ownerPackageRoot = recognitionRoot;
    const evidence = { owner, specifier, installed, packageRoot: recognitionRoot, version: manifest.version };
    recognitionEntries.push(evidence);
    console.log(JSON.stringify({ assertion: "installed recognition closure", ...evidence }));
    await provenance(manifestPath);
    await provenance(installed);
  }
}
const recognitionRoots = [...new Set(recognitionEntries.map(entry => entry.packageRoot))];
console.log(JSON.stringify({ assertion: "recognition physical copies", packageRoots: recognitionRoots,
  duplicated: recognitionRoots.length > 1,
  note: "Distinct normal registry copies at version 0.4.1 are allowed; compiled membership is reported per owner below" }));
const helperManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(helperManifest.name, "@phosphorco/bb-markdown");
assert.equal(helperManifest.version, "0.1.0");
assert.equal(helperManifest.dependencies?.["@phosphorco/bb-context-recognition"], "0.4.1");
await provenance(join(packageRoot, "package.json"));

const scratch = await mkdtemp(join(tmpdir(), "bb-source-loader-"));
try {
  // The running compiler's resolver validates all pins. Throw before any download.
  const toolchain = await resolvePluginBuildToolchain(join(scratch, "toolchain"), {
    onFetchStart() { throw new Error("Pinned compiler toolchain is not installed locally; downloads disabled"); },
  });
  const esbuild = await import(toolchain.esbuild);
  console.log(JSON.stringify({ toolchain, esbuildVersion: esbuild.version }));
  const compile = async (rootDir: string, id: string, manifest: PluginManifest) => {
    const serverEntry = resolve(rootDir, manifest.bb.server);
    await provenance(serverEntry);
    const built = await buildCachedPluginServer({
      rootDir, dataDir: join(scratch, "cache"), pluginId: id,
      sdkVersion: sdkManifest.version, bbVersion: "0.0.0-compiler-regression",
      validatedConfig: { serverEntry, packageName: manifest.name, pluginVersion: manifest.version },
      toolchain: async () => toolchain, runtimeImports, fallbackResolve,
    });
    assert.ok((await stat(built.path)).size > 0, `${id}: empty compiler output`);
    assert.equal(sha(await readFile(built.path)), built.digest);
    // Read emitted metadata as evidence; never evaluate the emitted module.
    const meta = JSON.parse(await readFile(join(dirname(built.path), "server.meta.json"), "utf8"));
    assert.equal(meta.pluginId, id);
    const map = JSON.parse(await readFile(`${built.path}.map`, "utf8")) as {
      sources: string[];
      sourcesContent?: (string | null)[];
    };
    // esbuild computes map paths before the compiler moves its staged output.
    // Identify the real base using the known entry instead of assuming a layout.
    const entry = await realpath(serverEntry);
    const mapBase = [dirname(built.path), join(dirname(built.path), ".stage-map-origin")]
      .find(base => map.sources.some(input => resolve(base, input) === entry));
    assert.ok(mapBase, `${id}: actual server entry absent from emitted source map`);
    const inputs = await Promise.all(map.sources.map(async input => {
      // Compiler namespaces are identifiers, not filesystem paths. The exact
      // compiler disables sourcesContent, so do not invent a virtual-file hash.
      const namespace = /^([a-zA-Z][\w-]*):/.exec(input)?.[1];
      if (namespace && namespace !== "file") {
        const evidence = { path: input, namespace };
        console.log(JSON.stringify({ assertion: "virtual source", id, ...evidence }));
        return evidence;
      }
      const path = await realpath(resolve(mapBase, input));
      return { path, sha256: sha(await readFile(path)) };
    }));
    assert.equal(manifest.dependencies?.["@phosphorco/bb-markdown"], "0.1.0");
    for (const [specifier, fileName] of markdownExports) {
      const installed = await resolveImport(specifier, serverEntry);
      const canonical = await realpath(join(packageRoot, "dist", fileName));
      assert.equal(installed, canonical, `${id}: installed ${specifier} must resolve to the canonical community workspace export`);
      assert.ok(inputs.some(input => input.path === installed), `${id}: installed ${specifier} export absent from compiled graph (${installed})`);
      console.log(JSON.stringify({ assertion: "canonical installed export compiled", id, specifier, path: installed, canonical }));
      await provenance(installed);
    }
    for (const evidence of recognitionEntries) {
      const compiled = inputs.some(input => input.path === evidence.installed);
      console.log(JSON.stringify({ assertion: "recognition compiled membership", id, ...evidence, compiled }));
      if (evidence.owner === helperOwner) {
        assert.ok(compiled, `${id}: helper recognition ${evidence.specifier} public entry absent from compiled graph`);
      }
    }
    console.log(JSON.stringify({ assertion: "source graph", id, inputCount: inputs.length,
      sourcesContent: map.sourcesContent !== undefined,
      provenanceLimit: "Exact compiler uses sourcesContent:false; real-file hashes and map membership do not independently prove source/dist freshness",
      sha256: sha(Buffer.from(JSON.stringify(inputs.sort((a, b) => a.path.localeCompare(b.path))))) }));
    console.log(JSON.stringify({ assertion: "compiled", id, digest: built.digest, meta }));
  };
  const controlRoot = join(scratch, "negative-control", "plugin");
  await mkdir(controlRoot, { recursive: true });
  await writeFile(join(dirname(controlRoot), "outside.ts"), "export const sentinel = 42;\n");
  await writeFile(join(controlRoot, "server.ts"), 'import { sentinel } from "../outside.ts"; export default sentinel;\n');
  await assert.rejects(
    compile(controlRoot, "negative-control", { name: "negative-control", version: "0.0.0", bb: { server: "./server.ts" } }),
    /server source import escapes the plugin directory: \.\.\/outside\.ts/,
    "Static relative source escape must be rejected by the actual compiler",
  );
  console.log("PASS: actual compiler rejected static relative escape");
  const failures: string[] = [];
  for (const id of pilots) {
    const rootDir = join(pluginsRoot, "plugins", id);
    try {
      const manifestPath = join(rootDir, "package.json");
      await provenance(manifestPath);
      await compile(rootDir, id, JSON.parse(await readFile(manifestPath, "utf8")));
      console.log(`PASS: ${id} actual source graph compiled`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(id);
      console.error(`FAIL: ${id} actual source graph\n${message}`);
    }
  }
  assert.equal(failures.length, 0, `Actual source graphs failed: ${failures.join(", ")}`);
  console.log("PASS: both actual source graphs compiled; compiler-only evidence, not a production reload or API test");
} finally {
  await rm(scratch, { recursive: true, force: true });
  console.log(`Removed compiler scratch: ${scratch}`);
}
