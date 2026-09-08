import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../../../..");
const communityRoot = resolve(pluginRoot, "../..");
const workspaceRoot = resolve(communityRoot, "..");
const child = join(here, "engine-child.cjs");
// The package intentionally does not export package.json; resolve its public
// entrypoint and walk back from dist/ instead of treating that export barrier
// as an engine result.
const wasmRoot = dirname(dirname(require.resolve("@duckdb/duckdb-wasm", { paths: [communityRoot] })));
const wasmModule = join(wasmRoot, "dist/duckdb-node-blocking.cjs");
const wasmMvp = join(wasmRoot, "dist/duckdb-mvp.wasm");
const wasmEh = join(wasmRoot, "dist/duckdb-eh.wasm");
const nativeRoot = process.env.ANALYTICS_NATIVE_DUCKDB_ROOT ?? null;
const nodeApiRoot = process.env.ANALYTICS_NODE_API_ROOT ?? null;

function status(status, evidence, limitations = []) {
  return { status, evidence, limitations };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function parseChildOutput(stdout) {
  const json = stdout.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  return json.at(-1) ?? null;
}

function measurementCompleted(result) {
  const output = result.output;
  return result.status === "observed"
    && output != null
    && output.status !== "failure"
    && output.preparedSql?.status === "observed"
    && output.executionGrammarControl?.status === "observed"
    && output.memoryLimit?.status === "observed"
    && ["observed", "unsupported"].includes(output.parserSerialization?.status);
}
function parserOnlyCompleted(result) {
  const items = result.output?.parserOnly;
  return result.status === "observed" && items?.length === 16 && items.every((item) => item.status === "observed")
    && items.find((item) => item.id === "nested-catalog")?.hasCatalogRelation === true
    && items.find((item) => item.id === "range-table-function")?.hasRangeFunction === true
    && items.find((item) => item.id === "comma-join")?.hasCommaJoinBoth === true
    && items.find((item) => item.id === "cte")?.hasCte === true
    && items.find((item) => item.id === "named-parameter")?.hasNamedParameter === true;
}

function appendBounded(current, chunk, limit = 4_096) {
  return `${current}${chunk}`.slice(0, limit);
}

function runChild({ engine, mode = "measure", deadlineMs = 1_500, startupDeadlineMs = 15_000, nativeModule = null, nodeApiModule = null, asBytes = null, cpuSeconds = null, nodeArgs = [], builtinSql = null, bootstrapRepository = null, trustedExternalAccessBeforeLoad = null }) {
  return new Promise((resolveProbe) => {
    const started = performance.now();
    const scratch = mkdtempSync(join(tmpdir(), "analytics-runtime-probe-"));
    const isolatedHome = join(scratch, "home");
    const xdgConfig = join(scratch, "xdg-config");
    const xdgCache = join(scratch, "xdg-cache");
    const xdgData = join(scratch, "xdg-data");
    const isolatedTemp = join(scratch, "tmp");
    const extensions = join(scratch, "extensions");
    for (const path of [isolatedHome, xdgConfig, xdgCache, xdgData, isolatedTemp, extensions]) mkdirSync(path);
    let selectedWasmModule = wasmModule;
    let loaderPatch = null;
    if (mode === "wasm-url-mapping") {
      const original = readFileSync(wasmModule, "utf8");
      const needle = "runtime.whereToLoad(UTF8ToString(e)):UTF8ToString(r)";
      const replacement = "runtime.whereToLoad(UTF8ToString(e),UTF8ToString(r)):UTF8ToString(r)";
      const occurrences = original.split(needle).length - 1;
      if (occurrences !== 2) {
        rmSync(scratch, { recursive: true, force: true });
        resolveProbe({
          status: "failure",
          durationMs: performance.now() - started,
          loaderPatch: { originalSha256: sha256(wasmModule), expectedCallbackOccurrences: 2, callbackOccurrences: occurrences, replacementApplied: false },
          error: "Pinned loader callback shape drifted; refusing an unguarded mapping run.",
        });
        return;
      }
      selectedWasmModule = join(scratch, "duckdb-node-blocking-url-capture.cjs");
      const patched = original.replaceAll(needle, replacement);
      writeFileSync(selectedWasmModule, patched, { flag: "wx", mode: 0o600 });
      loaderPatch = {
        originalSha256: sha256(wasmModule),
        cloneSha256: sha256(selectedWasmModule),
        expectedCallbackOccurrences: 2,
        callbackOccurrences: occurrences,
        replacementApplied: true,
        callbackChange: "whereToLoad($0) to whereToLoad($0, $1)",
      };
    }
    let settled = false;
    let queryDeadline = null;
    let startupDeadline = null;
    let settlementDeadline = null;
    let queryDispatched = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (startupDeadline != null) clearTimeout(startupDeadline);
      if (queryDeadline != null) clearTimeout(queryDeadline);
      if (settlementDeadline != null) clearTimeout(settlementDeadline);
      rmSync(scratch, { recursive: true, force: true });
      resolveProbe(loaderPatch == null ? result : {
        ...result,
        loaderPatch: { ...loaderPatch, originalIntact: sha256(wasmModule) === loaderPatch.originalSha256 },
      });
    };
    const command = asBytes == null ? process.execPath : "prlimit";
    const args = asBytes == null ? [...nodeArgs, child] : [`--as=${asBytes}:${asBytes}`, `--cpu=${cpuSeconds}:${cpuSeconds}`, "--", process.execPath, ...nodeArgs, child];
    const childProcess = spawn(command, args, {
      cwd: scratch,
      env: {
        PATH: process.env.PATH ?? "",
        LANG: "C",
        HOME: isolatedHome,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_CACHE_HOME: xdgCache,
        XDG_DATA_HOME: xdgData,
        TMPDIR: isolatedTemp,
        ...(mode === "wasm-url-mapping" ? { NODE_PATH: join(communityRoot, "node_modules") } : {}),
        ANALYTICS_RUNTIME_PROBE_EXTENSION_DIR: extensions,
        ...(builtinSql == null ? {} : { ANALYTICS_RUNTIME_PROBE_BUILTIN_SQL: JSON.stringify(builtinSql) }),
        ...(bootstrapRepository == null ? {} : { ANALYTICS_RUNTIME_PROBE_BOOTSTRAP_REPOSITORY: bootstrapRepository }),
        ...(trustedExternalAccessBeforeLoad == null ? {} : { ANALYTICS_RUNTIME_PROBE_TRUSTED_EXTERNAL_BEFORE_LOAD: String(trustedExternalAccessBeforeLoad) }),
        ANALYTICS_RUNTIME_PROBE_ENGINE: engine,
        ANALYTICS_RUNTIME_PROBE_MODE: mode,
        ANALYTICS_RUNTIME_PROBE_FACTS: "25000",
        ANALYTICS_RUNTIME_PROBE_WASM_MODULE: selectedWasmModule,
        ANALYTICS_RUNTIME_PROBE_WASM_MVP: wasmMvp,
        ANALYTICS_RUNTIME_PROBE_WASM_EH: wasmEh,
        ...(nativeModule == null ? {} : { ANALYTICS_RUNTIME_PROBE_NATIVE_MODULE: nativeModule }),
        ...(nodeApiModule == null ? {} : { ANALYTICS_RUNTIME_PROBE_NODE_API_MODULE: nodeApiModule }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const stdoutLimit = ["parser-only", "wasm-json-bootstrap", "wasm-trusted-json-bootstrap"].includes(mode) ? 65_536 : 4_096;
    let killReason = null;
    const killAndSettle = (reason) => {
      if (killReason != null) return;
      killReason = reason;
      childProcess.kill("SIGKILL");
      settlementDeadline = setTimeout(() => finish({ status: "failure", durationMs: performance.now() - started, killReason: "exit-not-confirmed", queryDispatched, output: parseChildOutput(stdout), stderr: stderr.replace(/\s+/g, " ").slice(0, 300) || null }), 2_000);
    };
    startupDeadline = setTimeout(() => {
      killAndSettle("startup-deadline");
    }, startupDeadlineMs);
    childProcess.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > stdoutLimit) killAndSettle("stdout-cap");
      stdout = appendBounded(stdout, chunk, stdoutLimit);
      if (mode === "hang" && !queryDispatched && stdout.split("\n").some((line) => {
        try { return JSON.parse(line).phase === "query-dispatched"; } catch { return false; }
      })) {
        queryDispatched = true;
        clearTimeout(startupDeadline);
        queryDeadline = setTimeout(() => {
          killAndSettle("query-deadline");
        }, deadlineMs);
      }
    });
    childProcess.stderr.on("data", (chunk) => { if (stderr.length + chunk.length > 4_096) killAndSettle("stderr-cap"); stderr = appendBounded(stderr, chunk); });
    childProcess.on("error", (error) => {
      finish({ status: "failure", durationMs: performance.now() - started, error: error.message, killReason });
    });
    childProcess.on("close", (exitCode, signal) => {
      const output = parseChildOutput(stdout);
      const validPayload = mode === "hang" ? queryDispatched : output != null && output.status !== "failure";
      finish({
        status: killReason === "query-deadline" && queryDispatched && signal === "SIGKILL" ? "deadline-killed" : exitCode === 0 && validPayload ? "observed" : "failure",
        durationMs: performance.now() - started,
        exitCode,
        signal,
        killReason,
        queryDispatched,
        output,
        payloadValid: validPayload,
        stderr: stderr.replace(/\s+/g, " ").slice(0, 300) || null,
      });
    });
  });
}

function sourceIdentity() {
  const tracked = [
    "package.json",
    "browser-engine.ts",
    "analytics-verifier.ts",
    "sql-policy.ts",
    "builtin-bundles.ts",
  ].map((relative) => {
    const path = join(pluginRoot, relative);
    return { path: `plugins/analytics/${relative}`, sha256: sha256(path) };
  });
  return {
    workspaceRevision: command("git", ["rev-parse", "HEAD"], workspaceRoot),
    communityPluginsRevision: command("git", ["rev-parse", "HEAD"], communityRoot),
    communityPluginStatus: command("git", ["status", "--short", "--", "plugins/analytics"], communityRoot),
    tracked,
  };
}

function nativeModuleFromRoot(root) {
  if (root == null) return null;
  const candidate = join(resolve(root), "node_modules", "duckdb");
  return existsSync(candidate) ? candidate : null;
}
function nodeApiModuleFromRoot(root) {
  if (root == null) return null;
  const candidate = join(resolve(root), "node_modules", "@duckdb", "node-api");
  return existsSync(candidate) ? candidate : null;
}

async function runNodeApiNarrow() {
  const module = nodeApiModuleFromRoot(nodeApiRoot);
  if (module == null) return { probe: "analytics-runtime-node-api-narrow", status: "unsupported", reason: "No node-api scratch root supplied." };
  const asBytes = process.env.ANALYTICS_RUNTIME_PROBE_AS_BYTES == null ? null : Number(process.env.ANALYTICS_RUNTIME_PROBE_AS_BYTES);
  const cpuSeconds = Number(process.env.ANALYTICS_RUNTIME_PROBE_CPU_SECONDS ?? "5");
  const nodeArgs = process.env.ANALYTICS_RUNTIME_PROBE_NODE_PROFILE === "jitless-small-heap"
    ? ["--jitless", "--max-old-space-size=64", "--max-semi-space-size=4"]
    : [];
  const measurement = await runChild({ engine: "node-api", nodeApiModule: module, asBytes, cpuSeconds, nodeArgs });
  return { probe: "analytics-runtime-node-api-narrow", status: measurementCompleted(measurement) ? "observed" : "failure", controls: { asBytes, cpuSeconds, nodeArgs, hardLimits: asBytes == null ? "not-applied" : "soft=hard" }, measurement, source: sourceIdentity() };
}

async function runNodeApiParserOnly() {
  const module = nodeApiModuleFromRoot(nodeApiRoot);
  if (module == null) return { probe: "analytics-runtime-node-api-parser-only", status: "unsupported" };
  const source = readFileSync(join(pluginRoot, "builtin-bundles.ts"), "utf8");
  const builtins = [...source.matchAll(/\bsql:\s*`([\s\S]*?)`/g)].map((match) => match[1]);
  if (builtins.length !== 11 || builtins.some((sql) => sql.length > 16_384 || sql.includes("${"))) return { probe: "analytics-runtime-node-api-parser-only", status: "failure", reason: "Expected 11 bounded, non-interpolated builtin SQL strings." };
  const measurement = await runChild({ engine: "node-api", mode: "parser-only", nodeApiModule: module, builtinSql: builtins });
  return { probe: "analytics-runtime-node-api-parser-only", status: parserOnlyCompleted(measurement) ? "observed" : "failure", measurement, source: sourceIdentity() };
}
export async function runAs1536Probe() { return runNodeApiAs1536(); }
export async function runParserCompatibilityProbe() { return runNodeApiParserOnly(); }
export async function runWasmMetadataProbe() {
  const measurement = await runChild({ engine: "wasm", mode: "wasm-metadata", startupDeadlineMs: 20_000 });
  const metadata = measurement.output?.metadata;
  const libraryVersion = metadata?.version?.library_version ?? metadata?.pragmaVersion?.library_version ?? null;
  const version = metadata?.pragmaVersion?.source_id ?? metadata?.pragmaVersion?.sourceId ?? null;
  const platform = metadata?.platform?.platform ?? null;
  return {
    probe: "analytics-runtime-wasm-extension-metadata",
    status: measurement.status === "observed" && typeof libraryVersion === "string" && /^[0-9a-f]{7,64}$/i.test(version ?? "") && /^[a-z0-9_]+$/i.test(platform ?? "") ? "observed" : "failure",
    controls: { queryScope: "built-in version/platform metadata only", startupDeadlineMs: 20_000, externalAccess: "disabled before metadata query" },
    measurement,
    resolved: { libraryVersion, sourceId: version, platform },
    source: sourceIdentity(),
  };
}

export async function runWasmExtensionMetadataProbe() {
  const measurement = await runChild({ engine: "wasm", mode: "wasm-extension-metadata", startupDeadlineMs: 20_000 });
  const extension = measurement.output?.extension ?? null;
  const observed = measurement.status === "observed"
    && measurement.output?.rowCount === 1
    && extension?.extensionName === "json"
    && (typeof extension.installPath === "string" || extension.installPath == null);
  return {
    probe: "analytics-runtime-wasm-json-extension-metadata",
    status: observed ? "observed" : "failure",
    controls: {
      query: "SELECT extension_name, install_path FROM duckdb_extensions() WHERE extension_name = 'json'",
      queryScope: "built-in engine metadata only; no authored SQL or extension execution",
      startupDeadlineMs: 20_000,
      autoinstall: "disabled before metadata query",
      autoload: "disabled before metadata query",
      externalAccess: "disabled before metadata query",
    },
    extension,
    measurement,
    source: sourceIdentity(),
  };
}

export async function runWasmUrlMappingProbe() {
  const measurement = await runChild({ engine: "wasm", mode: "wasm-url-mapping", startupDeadlineMs: 20_000 });
  const capture = measurement.output?.capture ?? null;
  const controlsObserved = capture?.status === "observed"
    && capture.hookCalls === 1
    && capture.sentinelObserved === true
    && capture.settings?.autoinstall === false
    && capture.settings?.autoload === false
    && capture.settings?.community === false
    && capture.settings?.external_access === true;
  const sourceIntact = measurement.loaderPatch?.originalIntact === true;
  return {
    probe: "analytics-runtime-wasm-json-url-mapping",
    status: measurement.status === "observed" && controlsObserved && sourceIntact ? "observed" : "failure",
    controls: {
      trigger: "fixed trusted LOAD json; scratch-cloned generated callback throws before cache/fetch/dlopen",
      workerCount: 1,
      processDeadlineMs: 20_000,
      autoinstall: "disabled before trigger",
      autoload: "disabled before trigger",
      communityExtensions: "disabled before trigger",
      unsignedExtensions: "disabled at database open",
      externalAccess: "left true only to reach the pre-I/O diagnostic hook",
      environment: "minimal explicit child environment; NODE_PATH is the exact existing community node_modules path only for the scratch clone",
      sourcePatch: "fail closed unless exactly two generated callback replacements add the fallback URL as a second whereToLoad argument",
      failureRule: "replacement drift, missing hook, missing sentinel, or changed original source is failure; no unguarded retry",
    },
    loaderPatch: measurement.loaderPatch ?? null,
    capture,
    mappingEstablished: capture?.urlShape === "full-wasm-extension-url"
      && typeof capture.resolvedDirectory === "string"
      && typeof capture.resolvedPlatform === "string",
    measurement,
    source: sourceIdentity(),
    limitations: [
      "This is a diagnostic over a scratch-cloned generated loader, not production design or proof that the unmodified package supports a two-argument hook.",
      "The hook was made to throw before its package-specific cache/fetch callback; this is not a generic network-sandbox claim.",
    ],
  };
}

export async function runWasmTrustedJsonBootstrapProbe() {
  const builtins = builtinSqlInputs();
  if (builtins == null) return { probe: "analytics-runtime-wasm-trusted-json-bootstrap", status: "failure", reason: "Expected 11 bounded non-interpolated built-in SQL strings.", source: sourceIdentity() };
  // The prior external=false rejection is preserved in evidence documentation.
  // This rerunnable compatibility mode uses only the already-observed,
  // explicitly approved trusted external=true bootstrap before locking down.
  const measurement = await runChild({ engine: "wasm", mode: "wasm-trusted-json-bootstrap", startupDeadlineMs: 20_000, builtinSql: builtins, trustedExternalAccessBeforeLoad: true });
  const bootstrap = measurement.output?.bootstrap ?? null;
  const parserInputs = bootstrap?.parserCompatibility?.inputs ?? [];
  const parserEvidence = parserInputs.length === 16
    && parserInputs.every((input) => input.status === "observed" && input.nodeType === "SELECT_NODE")
    && parserInputs.find((input) => input.id === "nested-catalog")?.hasCatalogRelation === true
    && parserInputs.find((input) => input.id === "range-table-function")?.hasRangeFunction === true
    && parserInputs.find((input) => input.id === "comma-join")?.hasCommaJoinBoth === true
    && parserInputs.find((input) => input.id === "cte")?.hasCte === true
    && parserInputs.find((input) => input.id === "named-parameter")?.hasNamedParameter === true;
  return {
    probe: "analytics-runtime-wasm-trusted-json-bootstrap",
    status: measurement.status === "observed" && bootstrap?.status === "observed" && parserEvidence ? "observed" : "failure",
    controls: {
      engine: "unmodified installed @duckdb/duckdb-wasm only",
      workerCount: 1,
      processDeadlineMs: 20_000,
      unsignedExtensions: "false before LOAD",
      autoinstall: "false before LOAD",
      autoload: "false before LOAD",
      communityExtensions: "false before LOAD",
      externalAccess: "previous external=false rejection is preserved; this mode uses the previously successful true-before-LOAD trusted bootstrap, then false and locked before all bound parser input",
      repository: "engine default official repository only; no custom repository, server, or fallback",
      parserInput: "bound VARCHAR data: fixed SELECT 1 plus all 11 actual built-ins and five fixed structural cases",
      output: "full JSON extension metadata plus structural parser result only; no rows or AST dump",
    },
    bootstrap,
    attempts: { priorExternalFalse: "rejected and preserved in runtime-feasibility.md; deliberately not repeated", externalTrue: measurement },
    parserEvidence,
    measurement,
    source: sourceIdentity(),
    limitations: [
      "This observes one approved core JSON bootstrap on the installed engine; it is not a public grammar validator or OS sandbox proof.",
      "A missing URL-loader callback does not establish absence of network or extension activity.",
    ],
  };
}

function builtinSqlInputs() {
  const source = readFileSync(join(pluginRoot, "builtin-bundles.ts"), "utf8");
  const builtins = [...source.matchAll(/\bsql:\s*`([\s\S]*?)`/g)].map((match) => match[1]);
  return builtins.length === 11 && builtins.every((sql) => sql.length <= 16_384 && !sql.includes("${")) ? builtins : null;
}

export async function runWasmJsonBootstrapProbe() {
  const metadata = await runWasmMetadataProbe();
  return {
    probe: "analytics-runtime-wasm-json-bootstrap",
    status: "unsupported",
    reason: "Disabled fail-closed: metadata source ID is not the authoritative DUCKDB_WASM_VERSION directory and no approved exact artifact URL has been supplied.",
    metadata,
    source: sourceIdentity(),
  };
}
async function runNodeApiAs1536() {
  const module = nodeApiModuleFromRoot(nodeApiRoot);
  if (module == null) return { probe: "analytics-runtime-node-api-as1536", status: "unsupported" };
  const nodeArgs = ["--jitless", "--max-old-space-size=64", "--max-semi-space-size=4"];
  const options = { engine: "node-api", nodeApiModule: module, asBytes: 1_610_612_736, cpuSeconds: 5, nodeArgs };
  const fit = await runChild(options);
  const recovery = await runChild(options);
  const limitsMatch = (result) => {
    const limits = result.output?.readyEnvelope?.limits;
    return limits?.["Max cpu time"]?.soft === "5" && limits["Max cpu time"]?.hard === "5"
      && limits?.["Max address space"]?.soft === "1610612736" && limits["Max address space"]?.hard === "1610612736";
  };
  return { probe: "analytics-runtime-node-api-as1536", status: measurementCompleted(fit) && measurementCompleted(recovery) && limitsMatch(fit) && limitsMatch(recovery) ? "observed" : "failure", controls: { asBytes: 1_610_612_736, cpuSeconds: 5, nodeArgs, hardLimits: "soft=hard", assertions: "child /proc/self/limits soft=hard" }, fit, recovery, source: sourceIdentity() };
}

/**
 * Runs isolated, aggregate-only feasibility controls. The JSON result is safe
 * to aggregate: it contains package/source identities and timings, never facts,
 * SQL result values, host paths, credentials, or raw stderr.
 */
export async function runProbe() {
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "node-api-as1536") return runNodeApiAs1536();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "node-api-parser-only") return runNodeApiParserOnly();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "node-api") return runNodeApiNarrow();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "wasm-metadata") return runWasmMetadataProbe();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "wasm-extension-metadata") return runWasmExtensionMetadataProbe();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "wasm-url-mapping") return runWasmUrlMappingProbe();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "wasm-trusted-json-bootstrap") return runWasmTrustedJsonBootstrapProbe();
  if (process.env.ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY === "wasm-json-bootstrap") return runWasmJsonBootstrapProbe();
  const nativeModule = nativeModuleFromRoot(nativeRoot);
  const nodeApiModule = nodeApiModuleFromRoot(nodeApiRoot);
  const wasmCold = await runChild({ engine: "wasm" });
  const wasmWarm = await runChild({ engine: "wasm" });
  const wasmDeadline = await runChild({ engine: "wasm", mode: "hang", deadlineMs: 1_500 });
  const wasmRecovery = await runChild({ engine: "wasm" });
  const wasm = {
    packaging: status("observed", {
      package: "@duckdb/duckdb-wasm",
      version: require(join(wasmRoot, "package.json")).version,
      installedFrom: basename(communityRoot),
      dependencyKind: "dependencies",
    }, ["This establishes the currently installed package only; a clean community installation is a later integration proof."]),
    cold: wasmCold,
    warm: wasmWarm,
    deadlineRecovery: {
      status: wasmDeadline.status === "deadline-killed" && wasmRecovery.status === "observed" ? "observed" : "failure",
      deadline: wasmDeadline,
      recovery: wasmRecovery,
      limitation: "This proves a query-dispatch handshake, SIGKILL of a dedicated child, and fresh-child recovery. It does not prove cooperative DuckDB cancellation, engine-query progress, or a sandbox.",
    },
  };
  const native = nativeModule == null
    ? status("unsupported", { package: "duckdb", reason: "Not installed in the shared community plugin dependency graph.", requestedSandboxRoot: nativeRoot }, ["Run npm install --prefix $(mktemp -d) --no-save duckdb@<version>, then set ANALYTICS_NATIVE_DUCKDB_ROOT to that sandbox before rerunning. Missing installation is not a native-runtime success."])
    : (() => ({
      packaging: status("observed", { package: "duckdb", sandboxRoot: nativeRoot, version: require(join(nativeModule, "package.json")).version }, ["The sandbox is probe-only and does not establish BB community-plugin installation viability."]),
      cold: null,
      warm: null,
      deadlineRecovery: null,
    }))();
  if (nativeModule != null) {
    native.cold = await runChild({ engine: "native", nativeModule });
    native.warm = await runChild({ engine: "native", nativeModule });
    const deadline = await runChild({ engine: "native", mode: "hang", deadlineMs: 1_500, nativeModule });
    const recovery = await runChild({ engine: "native", nativeModule });
    native.deadlineRecovery = {
      status: deadline.status === "deadline-killed" && recovery.status === "observed" ? "observed" : "failure",
      deadline,
      recovery,
      limitation: "This proves a query-dispatch handshake, SIGKILL of a dedicated child, and fresh-child recovery. It does not prove cooperative DuckDB cancellation, engine-query progress, or a sandbox.",
    };
  }
  const nodeApi = nodeApiModule == null ? status("unsupported", { package: "@duckdb/node-api", reason: "No scratch package root supplied." }) : (() => ({
    packaging: status("observed", { package: "@duckdb/node-api", version: require(join(nodeApiModule, "package.json")).version, sandboxRoot: nodeApiRoot, dependency: "@duckdb/node-bindings 1.5.5-r.4" }), cold: null, warm: null, deadlineRecovery: null,
  }))();
  if (nodeApiModule != null) {
    nodeApi.cold = await runChild({ engine: "node-api", nodeApiModule });
    nodeApi.warm = await runChild({ engine: "node-api", nodeApiModule });
    const deadline = await runChild({ engine: "node-api", mode: "hang", nodeApiModule });
    const recovery = await runChild({ engine: "node-api", nodeApiModule });
    nodeApi.deadlineRecovery = { status: deadline.status === "deadline-killed" && recovery.status === "observed" ? "observed" : "failure", deadline, recovery, limitation: "Process kill/recovery only; not sandboxing or cooperative cancellation." };
  }
  const wasmHealthy = measurementCompleted(wasm.cold)
    && measurementCompleted(wasm.warm)
    && wasm.deadlineRecovery.status === "observed"
    && measurementCompleted(wasm.deadlineRecovery.recovery);
  const nativeHealthy = nativeModule == null || (
    measurementCompleted(native.cold)
    && measurementCompleted(native.warm)
    && native.deadlineRecovery.status === "observed"
    && measurementCompleted(native.deadlineRecovery.recovery)
  );
  const nodeApiHealthy = nodeApiModule == null || (measurementCompleted(nodeApi.cold) && measurementCompleted(nodeApi.warm) && nodeApi.deadlineRecovery.status === "observed" && measurementCompleted(nodeApi.deadlineRecovery.recovery));
  const parserUnavailable = wasm.cold.output?.parserSerialization?.status !== "observed"
    || nativeModule == null
    || native.cold?.output?.parserSerialization?.status !== "observed" || nodeApiModule == null || nodeApi.cold?.output?.parserSerialization?.status !== "observed";
  return {
    probe: "analytics-runtime-feasibility",
    status: !wasmHealthy || !nativeHealthy || !nodeApiHealthy ? "failure" : parserUnavailable ? "unsupported" : "observed",
    controls: {
      facts: 25_000,
      rowsReturned: "aggregate-only",
      concurrency: "one measured engine child at a time",
      wallDeadlineMs: 1_500,
      memoryStress: "none; no >1GiB test was attempted",
    },
    source: sourceIdentity(),
    engines: { wasm, native, nodeApi },
    recommendation: {
      status: "unsupported",
      ruling: "Do not select either runtime from this probe alone.",
      reasons: [
        "Both bindings need a separate, complete parser/tree validator for the public grammar.",
        "A child-process kill/recovery control is not filesystem/network isolation and does not provide a plugin-owned hard memory ceiling.",
        "Native community packaging remains unsupported until a compatible clean install is demonstrated.",
      ],
    },
    limitations: [
      "No process alone is claimed to sandbox filesystem or network access.",
      "A returned-row cap is not claimed to bound scans, joins, sort memory, or aggregation state.",
      "The 16MB engine setting is only a driver/engine acceptance control; it is not a verified OS hard memory limit.",
      "Catalog visibility is observed as an engine capability and must be denied by a complete public grammar policy.",
    ],
  };
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProbe().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "failure") process.exitCode = 1;
  }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ probe: "analytics-runtime-feasibility", status: "failure", error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
