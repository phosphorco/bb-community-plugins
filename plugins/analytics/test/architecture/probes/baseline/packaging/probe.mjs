import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = join(probeDirectory, "..", "..", "..", "..", "..", "..", "..", "..");
const scratchDirectory = process.env.ANALYTICS_NODE_API_ROOT ?? "/tmp/analytics-node-api-4wcSSS";
const execFile = promisify(execFileCallback);

const sourcePaths = {
  buildPluginServer: join(workspaceDirectory, "fork/build/bb/packages/plugin-build/src/build-plugin-server.ts"),
  managedArtifacts: join(workspaceDirectory, "fork/build/bb/apps/server/src/services/plugins/managed-plugin-artifacts.ts"),
  pluginRuntime: join(workspaceDirectory, "fork/build/bb/apps/server/src/services/plugins/plugin-runtime.ts"),
  subprocessPattern: join(workspaceDirectory, "community-plugins/plugins/machine-monitor/monitor.ts"),
  subprocessManifest: join(workspaceDirectory, "community-plugins/plugins/machine-monitor/package.json"),
};

const scratchPaths = {
  nodeApiManifest: join(scratchDirectory, "node_modules/@duckdb/node-api/package.json"),
  bindingsManifest: join(scratchDirectory, "node_modules/@duckdb/node-bindings/package.json"),
  platformManifest: join(scratchDirectory, "node_modules/@duckdb/node-bindings-linux-x64/package.json"),
  platformBinding: join(scratchDirectory, "node_modules/@duckdb/node-bindings-linux-x64/duckdb.node"),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function identity(path) {
  try {
    const source = await readFile(path);
    return { path, sha256: sha256(source), bytes: source.byteLength };
  } catch (cause) {
    return { path, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function revision(directory) {
  try {
    const { stdout } = await execFile("git", ["-C", directory, "rev-parse", "HEAD"], {
      timeout: 1_000,
      maxBuffer: 4 * 1024,
    });
    const value = stdout.trim();
    if (!/^[0-9a-f]{40}$/u.test(value)) throw new Error("git did not return a full commit id");
    return { value };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read-only packaging feasibility inventory. It intentionally does not build,
 * install, spawn, or import the native addon: the supplied scratch directory
 * is a dependency tree, not a plugin root with a safe disposable manifest.
 */
export async function runProbe() {
  const [sources, scratch, communityPlugins, bbBuild] = await Promise.all([
    Promise.all(Object.entries(sourcePaths).map(async ([name, path]) => [name, await identity(path)])),
    Promise.all(Object.entries(scratchPaths).map(async ([name, path]) => [name, await identity(path)])),
    revision(join(workspaceDirectory, "community-plugins")),
    revision(join(workspaceDirectory, "fork/build/bb")),
  ]);
  const [nodeApi, bindings, platform, scratchHasManifest, sourceText] = await Promise.all([
    readJson(scratchPaths.nodeApiManifest),
    readJson(scratchPaths.bindingsManifest),
    readJson(scratchPaths.platformManifest),
    exists(join(scratchDirectory, "package.json")),
    Promise.all(Object.entries(sourcePaths).map(async ([name, path]) => [name, await readFile(path, "utf8").catch(() => null)])),
  ]);
  const platformBinding = await stat(scratchPaths.platformBinding).then((entry) => ({ bytes: entry.size })).catch((cause) => ({ error: cause instanceof Error ? cause.message : String(cause) }));
  const source = Object.fromEntries(sources);
  const scratchIdentity = Object.fromEntries(scratch);
  const sourceByName = Object.fromEntries(sourceText);
  const missingSources = Object.entries(source).filter(([, entry]) => entry.error !== undefined).map(([name]) => name);
  const missingScratchMetadata = [
    ["nodeApiManifest", nodeApi],
    ["bindingsManifest", bindings],
    ["platformManifest", platform],
  ].filter(([, entry]) => entry.error !== undefined).map(([name]) => name);
  const expectedInstallFlags = ["--ignore-scripts", "--omit=dev", "--omit=optional"];
  const observedInstallFlags = expectedInstallFlags.filter((flag) => sourceByName.managedArtifacts?.includes(flag));
  const nativeBuilderMarker = sourceByName.buildPluginServer?.includes("native deps are unsupported in plugins regardless") === true;
  const nativeRuntimeMarker = sourceByName.pluginRuntime?.includes("native dependencies are not supported in BB plugins") === true;
  const nativeBoundary = nativeRuntimeMarker
    ? "native dependencies are not supported in BB plugins"
    : "required native-dependency runtime marker is missing";
  const expectedEvidenceMissing = [
    ...(nativeBuilderMarker ? [] : ["buildPluginServer native-dependency marker"]),
    ...(nativeRuntimeMarker ? [] : ["pluginRuntime native-dependency marker"]),
    ...(observedInstallFlags.length === expectedInstallFlags.length ? [] : ["managed install flags"]),
  ];
  const optionalPlatformPackage = bindings.optionalDependencies?.["@duckdb/node-bindings-linux-x64"] === bindings.version;
  const failures = [
    ...(communityPlugins.error === undefined ? [] : ["community-plugins revision"]),
    ...(bbBuild.error === undefined ? [] : ["bb build revision"]),
    ...missingSources,
    ...missingScratchMetadata,
    ...(platformBinding.error === undefined ? [] : ["platform binding"]),
    ...expectedEvidenceMissing,
  ];
  const status = failures.length === 0 ? "unsupported" : "failure";
  return {
    probe: "analytics-baseline-plugin-native-worker-packaging",
    contractVersion: 1,
    status,
    sourceRevision: {
      communityPlugins,
      bbBuild,
      source,
    },
    scratch: {
      directory: scratchDirectory,
      pluginManifestPresent: scratchHasManifest,
      packages: { nodeApi, bindings, platform, platformBinding },
      identity: scratchIdentity,
    },
    assertions: {
      expectedInstallFlags,
      observedInstallFlags,
      nativeBuilderMarker,
      nativeRuntimeMarker,
      passed: failures.length === 0,
      failures,
    },
    findings: {
      builder: "buildPluginServer bundles server.js and leaves only the BB SDK and better-sqlite3 external; its source says native dependencies are unsupported regardless.",
      managedInstall: "Managed git installation runs npm install with --ignore-scripts, --omit=dev, and --omit=optional; it retains node_modules after build for runtime data/assets.",
      runtime: `The loader annotates .node load failures with: ${nativeBoundary}.`,
      nativePackageShape: optionalPlatformPackage
        ? "The inspected binding package locates the Linux x64 .node through an optional platform package, which managed installation omits."
        : "The inspected package did not match the expected optional platform-package shape.",
      workerAsset: "The builder emits only dist/server.js, its map, and metadata. It has no general worker-asset copy contract; a separately spawned worker must be independently shipped and resolved, but that does not remove the native-addon boundary.",
      subprocessApi: "Community plugin source demonstrates ordinary node:child_process execFile usage. The public SDK exposes bb.onDispose for reload/disable/shutdown cleanup; it does not supply a native-worker supervisor API.",
    },
    execution: {
      actualPluginBuild: "not-run",
      reason: "No build was needed after the source policy and managed-install assertions established unsupported native-addon packaging. The scratch directory lacked a plugin manifest, but a disposable scratch manifest was permitted; declining to create one was a bounded task-interpretation choice, not a product defect.",
    },
    conclusion: {
      viableNow: status === "unsupported" ? false : null,
      classification: status === "unsupported" ? "unsupported-platform-policy" : "probe-input-or-assertion-failure",
      gap: "A backend @duckdb/node-api worker is not currently a supported community-plugin packaging target. A future supported design needs an explicit native-dependency policy plus a managed-install strategy that retains/verifies the correct platform binding and an asset/lifecycle contract for a separate worker.",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runProbe();
  console.log(JSON.stringify(report));
  if (report.status === "failure") process.exitCode = 1;
}
