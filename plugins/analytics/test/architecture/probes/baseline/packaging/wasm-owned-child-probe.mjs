import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..", "..", "..", "..", "..", "..");
const pluginBuildRoot = join(workspace, "fork/build/bb");
const wasmRoot = process.env.ANALYTICS_WASM_ROOT
  ?? join(workspace, "community-plugins/node_modules/@duckdb/duckdb-wasm");
const timeoutMs = 20_000;
const stdoutLimit = 16 * 1024;
const stderrLimit = 4 * 1024;
const killGraceMs = 250;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function text(value) {
  return Buffer.from(value).toString("utf8");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function command(commandPath, args, options = {}) {
  return await new Promise((resolveResult) => {
    const child = spawn(commandPath, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputCapped = false;
    let closeObserved = false;
    let killRequested = false;
    let terminationRequested = false;
    let settled = false;
    const append = (current, chunk, limit) => {
      const remaining = Math.max(0, limit - current.length);
      if (chunk.length > remaining) outputCapped = true;
      return remaining === 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const settle = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolveResult({
        command: commandPath,
        args,
        code: child.exitCode,
        signal: child.signalCode,
        timedOut,
        outputCapped,
        closeObserved,
        stdout: text(stdout),
        stderr: text(stderr),
        ...extra,
      });
    };
    const terminateGroup = () => {
      if (killRequested) return;
      killRequested = true;
      if (process.platform !== "win32" && child.pid != null) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The leader may have exited between the observation and group kill.
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const requestTermination = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminateGroup();
      graceTimer = setTimeout(() => settle({ closeObserved: false, graceExpired: true }), killGraceMs);
    };
    let graceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk, stdoutLimit);
      if (outputCapped) requestTermination();
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk, stderrLimit);
      if (outputCapped) requestTermination();
    });
    child.on("error", (cause) => settle({ spawnError: cause.message }));
    child.on("close", () => {
      closeObserved = true;
      settle();
    });
  });
}

function workerSource() {
  return `
const { createRequire } = require("node:module");
const { realpathSync } = require("node:fs");
const requireHere = createRequire(__filename);
const allowedRoot = realpathSync(process.env.ANALYTICS_ALLOWED_WASM_ROOT);
const resolveExport = (name) => {
  const resolved = requireHere.resolve(name);
  const actual = realpathSync(resolved);
  if (!actual.startsWith(allowedRoot + "/")) throw new Error("unexpected Wasm resolution outside controlled root: " + actual);
  return actual;
};
(async () => {
  const packageEntry = resolveExport("@duckdb/duckdb-wasm/blocking");
  const wasmPath = resolveExport("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
  const workerPath = resolveExport("@duckdb/duckdb-wasm/dist/duckdb-node-mvp.worker.cjs");
  const duckdb = requireHere("@duckdb/duckdb-wasm/blocking");
  const database = await duckdb.createDuckDB({ mvp: { mainModule: wasmPath, mainWorker: workerPath } }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await database.instantiate();
  database.open({ maximumThreads: 1, allowUnsignedExtensions: false });
  const connection = database.connect();
  connection.query("SET enable_external_access=false");
  connection.query("SET autoinstall_known_extensions=false");
  connection.query("SET autoload_known_extensions=false");
  const result = connection.query("SELECT 1 AS value");
  const value = result.toArray()[0]?.value;
  if (Number(value) !== 1) throw new Error("SELECT 1 returned an unexpected value");
  console.log(JSON.stringify({ ok: true, value: Number(value), resolved: { packageEntry, wasmPath, workerPath }, controls: { allowUnsignedExtensions: false, enableExternalAccess: false, autoinstallKnownExtensions: false, autoloadKnownExtensions: false } }));
})().catch((cause) => { console.error(cause?.stack ?? String(cause)); process.exitCode = 1; });
`;
}

function serverSource() {
  return `
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
function workerPath() {
  const candidates = [join(root, "query-worker.cjs"), join(root, "..", "query-worker.cjs")];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("owned query worker is not present beside source or dist server");
  return found;
}
export async function runOwnedQueryChild() {
  const path = workerPath();
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [path], { cwd: process.env.ANALYTICS_FIXTURE_CWD, detached: process.platform !== "win32", env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ANALYTICS_ALLOWED_WASM_ROOT: process.env.ANALYTICS_ALLOWED_WASM_ROOT, NODE_PATH: "", PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false; let timedOut = false; let outputCapped = false; let terminationRequested = false; let graceTimer;
    const terminateGroup = () => { if (process.platform !== "win32" && child.pid != null) { try { process.kill(-child.pid, "SIGKILL"); return; } catch {} } child.kill("SIGKILL"); };
    const settle = (cause) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(graceTimer); cause == null ? resolveResult({ path, code: child.exitCode, stdout, stderr, timedOut, outputCapped, closeObserved: true }) : reject(cause); };
    const requestTermination = (cause) => { if (terminationRequested) return; terminationRequested = true; terminateGroup(); graceTimer = setTimeout(() => settle(cause), 250); };
    const append = (current, chunk, limit) => { const remaining = Math.max(0, limit - Buffer.byteLength(current)); if (chunk.length > remaining) outputCapped = true; return remaining === 0 ? current : current + chunk.subarray(0, remaining).toString("utf8"); };
    const timer = setTimeout(() => { timedOut = true; requestTermination(new Error("owned query child timeout; close was not observed")); }, 15000);
    child.stdout.on("data", chunk => { stdout = append(stdout, chunk, 8192); if (outputCapped) requestTermination(new Error("owned query child stdout cap")); });
    child.stderr.on("data", chunk => { stderr = append(stderr, chunk, 4096); if (outputCapped) requestTermination(new Error("owned query child stderr cap")); });
    child.on("error", cause => settle(cause));
    child.on("close", () => { if (timedOut) return settle(new Error("owned query child timed out")); if (outputCapped) return settle(new Error("owned query child output cap")); settle(); });
  });
}
export default function plugin() {}
`;
}

function buildRunnerSource() {
  const index = join(pluginBuildRoot, "packages/plugin-build/src/index.ts");
  return `
import { buildPluginServer, resolvePluginBuildToolchain } from ${JSON.stringify(pathToFileURL(index).href)};
const root = process.argv[2];
const toolchain = await resolvePluginBuildToolchain(root);
const result = await buildPluginServer(root, "0.0.0-packaging-probe", toolchain);
console.log(JSON.stringify(result));
`;
}

function invokeSource() {
  return `
import { pathToFileURL } from "node:url";
const entry = process.argv[2];
const mod = await import(pathToFileURL(entry).href);
const result = await mod.runOwnedQueryChild();
process.stdout.write(JSON.stringify(result));
if (result.code !== 0) process.exitCode = 1;
`;
}

function cleanEnvironment(root, allowedRoot) {
  return {
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"),
    npm_config_update_notifier: "false",
    PATH: process.env.PATH ?? "",
    ANALYTICS_FIXTURE_CWD: root,
    ANALYTICS_ALLOWED_WASM_ROOT: allowedRoot,
    NODE_PATH: "",
  };
}

function parseSingleJson(result) {
  if (result.timedOut || result.outputCapped || result.code !== 0 || result.spawnError) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/** Disposable build + source/dist owned-child evidence; no production plugin is loaded. */
export async function runProbe() {
  const fixture = await mkdtemp(join(tmpdir(), "analytics-wasm-owned-child-"));
  const sourceWasmRoot = await realpath(wasmRoot).catch(() => null);
  const environment = sourceWasmRoot == null ? null : cleanEnvironment(fixture, sourceWasmRoot);
  const evidence = { fixture: { cleaned: false, root: fixture }, steps: {} };
  try {
    if (sourceWasmRoot == null) throw new Error(`missing controlled Wasm root: ${wasmRoot}`);
    const packageJson = {
      name: "@analytics-probe/wasm-owned-child",
      version: "0.0.0",
      private: true,
      type: "module",
      bb: { name: "Wasm owned child probe", description: "Disposable packaging evidence.", branding: { icon: "Zap" }, server: "./server.mjs" },
      files: ["dist/", "query-worker.cjs"],
      dependencies: { "@duckdb/duckdb-wasm": "1.33.1-dev57.0" },
    };
    await Promise.all([
      writeFile(join(fixture, "package.json"), JSON.stringify(packageJson, null, 2) + "\n"),
      writeFile(join(fixture, "server.mjs"), serverSource()),
      writeFile(join(fixture, "query-worker.cjs"), workerSource()),
      writeFile(join(fixture, "build-runner.ts"), buildRunnerSource()),
      writeFile(join(fixture, "invoke.mjs"), invokeSource()),
    ]);
    await mkdir(join(fixture, "node_modules/@duckdb"), { recursive: true });
    await symlink(sourceWasmRoot, join(fixture, "node_modules/@duckdb/duckdb-wasm"), "dir");
    const linked = await lstat(join(fixture, "node_modules/@duckdb/duckdb-wasm"));
    if (!linked.isSymbolicLink()) throw new Error("controlled Wasm fixture dependency is not a symlink");
    const bun = process.env.BUN ?? "bun";
    const build = await command(bun, [join(fixture, "build-runner.ts"), fixture], { cwd: pluginBuildRoot, env: environment });
    evidence.steps.build = { ...build, parsed: parseSingleJson(build) };
    if (build.timedOut || build.outputCapped || build.code !== 0 || build.spawnError) throw new Error("real buildPluginServer failed");
    const distEntry = join(fixture, "dist/server.js");
    const distExists = await exists(distEntry);
    const sourceRun = await command(process.execPath, [join(fixture, "invoke.mjs"), join(fixture, "server.mjs")], { cwd: fixture, env: environment });
    const distRun = await command(process.execPath, [join(fixture, "invoke.mjs"), distEntry], { cwd: fixture, env: environment });
    evidence.steps.sourceRun = { ...sourceRun, parsed: parseSingleJson(sourceRun) };
    evidence.steps.distRun = { ...distRun, parsed: parseSingleJson(distRun), distExists };
    const pack = await command("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: fixture, env: environment });
    const packed = parseSingleJson(pack);
    const packedPaths = packed?.[0]?.files?.map((file) => file.path).sort() ?? [];
    evidence.steps.packDryRun = { ...pack, packedPaths, includedOwnedWorker: packedPaths.includes("query-worker.cjs"), includedBuiltServer: packedPaths.includes("dist/server.js") };
    const successfulRun = (step) => step.parsed?.code === 0 && step.parsed?.stdout != null;
    const sourcePayload = evidence.steps.sourceRun.parsed == null ? null : JSON.parse(evidence.steps.sourceRun.parsed.stdout);
    const distPayload = evidence.steps.distRun.parsed == null ? null : JSON.parse(evidence.steps.distRun.parsed.stdout);
    const controlled = (payload) => payload?.ok === true
      && payload.value === 1
      && payload.controls?.allowUnsignedExtensions === false
      && payload.controls?.enableExternalAccess === false
      && payload.controls?.autoinstallKnownExtensions === false
      && payload.controls?.autoloadKnownExtensions === false
      && Object.values(payload.resolved ?? {}).length === 3
      && Object.values(payload.resolved ?? {}).every((value) => typeof value === "string" && value.startsWith(sourceWasmRoot + "/"));
    const passed = distExists && successfulRun(evidence.steps.sourceRun) && successfulRun(evidence.steps.distRun) && controlled(sourcePayload) && controlled(distPayload) && evidence.steps.packDryRun.includedOwnedWorker && evidence.steps.packDryRun.includedBuiltServer;
    return {
      probe: "analytics-wasm-owned-child-packaging",
      contractVersion: 1,
      status: passed ? "observed" : "failure",
      evidence,
      source: {
        wasmRoot: sourceWasmRoot,
        wasmPackageJsonSha256: sha256(await readFile(join(sourceWasmRoot, "package.json"))),
        builderSourceSha256: sha256(await readFile(join(pluginBuildRoot, "packages/plugin-build/src/build-plugin-server.ts"))),
      },
      limitations: [
        "The Wasm package is a controlled symlink to an already installed dependency, not an npm clean-install proof.",
        "This uses only fixed local configuration statements and SELECT 1; it does not exercise SQL admission, extensions, URLs, files, real facts, cancellation, or a resource ceiling.",
        "The fixture is deleted after reporting; npm pack --dry-run uses a fixture-only cache.",
      ],
    };
  } catch (cause) {
    return { probe: "analytics-wasm-owned-child-packaging", contractVersion: 1, status: "failure", evidence, error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    await rm(fixture, { recursive: true, force: true });
    evidence.fixture.cleaned = true;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runProbe();
  console.log(JSON.stringify(report));
  if (report.status === "failure") process.exitCode = 1;
}
