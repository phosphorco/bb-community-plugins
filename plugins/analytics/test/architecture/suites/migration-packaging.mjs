import { isDeepStrictEqual as same } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { check, isInstrumentSelfTest, loadOptionalTestBinding, suiteResult } from "./data/common.mjs";
import { createMigrationFixture } from "./data/migration-fixture.mjs";

const required = ["createPriorStore", "migrate", "reopen", "readArtifacts", "disposeStore", "createPackageFixture", "buildPackage", "packPackage", "installArchive", "readInstalledManifest", "runInstalledWorker", "disposePackage"];
const outcome = (id, condition, detail) => check(id, condition ? "pass" : "fail", detail);
const faultMessage = "analytics-test-migration-before-commit";
const selectedWasmVersion = "1.33.1-dev57.0";

async function inspectInstalledAssets(installed, assets) {
  if (!isAbsolute(installed?.root ?? "") || !Array.isArray(assets) || assets.length < 2 || assets.length > 8)
    return null;
  const root = await realpath(installed.root);
  const found = [];
  for (const asset of assets) {
    if (!["worker", "wasm"].includes(asset.kind) || !isAbsolute(asset.path ?? "")) return null;
    const path = await realpath(asset.path);
    if (!path.startsWith(root + sep)) return null;
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 64 * 1024 * 1024) return null;
    const hash = createHash("sha256");
    let readBytes = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      readBytes += chunk.length;
      if (readBytes > 64 * 1024 * 1024) throw new Error("Installed asset exceeds hash budget.");
      hash.update(chunk);
    }
    found.push({ kind: asset.kind, sha256: hash.digest("hex") });
  }
  return found.some((x) => x.kind === "worker") && found.some((x) => x.kind === "wasm") ? found : null;
}

/** Inputs, injected failure and comparisons belong to the test, not binding. */
export async function runMigrationPackagingScenario(operations, inspectAssets = inspectInstalledAssets) {
  const missing = required.filter((key) => typeof operations?.[key] !== "function");
  if (missing.length) return [check("production-operations", "fail", "Loaded binding lacks: " + missing.join(", "))];
  const fixture = createMigrationFixture();
  const checks = [];
  let store, packaged;
  try {
    store = await operations.createPriorStore({ fixture });
    const prior = await operations.readArtifacts({ store, factColumns: fixture.factColumns });
    checks.push(outcome("prior-schema-fixture", prior.appliedMigrations === fixture.priorMigrationCount && same(prior.facts, [fixture.fact]) && prior.bundleSourceJson === fixture.bundleSourceJson && prior.referenceCapsuleJson === fixture.referenceCapsuleJson, "Actual old-schema rows and raw JSON match the validated fixture before migration."));
    let faultCalls = 0, rejected = false;
    try {
      await operations.migrate({ store, beforeCommit: () => { faultCalls++; throw new Error(faultMessage); } });
    } catch (error) { if (error?.message !== faultMessage) throw error; rejected = true; }
    store = await operations.reopen({ store });
    const rolledBack = await operations.readArtifacts({ store, factColumns: fixture.factColumns });
    checks.push(outcome("interrupted-migration-rolls-back", rejected && faultCalls === 1 && same(rolledBack, prior), "Before-commit fault leaves schema checkpoint and original data intact after reopen."));
    await operations.migrate({ store });
    store = await operations.reopen({ store });
    const first = await operations.readArtifacts({ store, factColumns: fixture.factColumns });
    await operations.migrate({ store });
    store = await operations.reopen({ store });
    const second = await operations.readArtifacts({ store, factColumns: fixture.factColumns });
    checks.push(outcome("migrates-concrete-prior-store", first.appliedMigrations === fixture.targetMigrationCount && same(first.facts, [fixture.fact]), "Migration reaches actual current migration count and preserves original fact columns."));
    checks.push(outcome("preserves-authored-bundle-payload", first.bundleSourceJson === fixture.bundleSourceJson, "Original authored JSON bytes remain available without rewriting loader defaults."));
    checks.push(outcome("preserves-v1-reference-as-unverified-lineage", first.referenceCapsuleJson === fixture.referenceCapsuleJson && same(first.legacyResolution, fixture.legacyResolution), "V1 bytes remain intact and resolve only as historical unverified lineage."));
    checks.push(outcome("reconstructs-idempotently", same(first, second), "Repeated migration and store reconstruction preserve artifacts."));

    // Ordinary test-owned filesystem/command glue; real clean install required.
    packaged = await operations.createPackageFixture();
    await operations.buildPackage({ packaged });
    const archive = await operations.packPackage({ packaged });
    const installed = await operations.installArchive({ packaged, archive, ignoreScripts: true, omitOptional: true });
    const manifest = await operations.readInstalledManifest({ installed });
    const worker = await operations.runInstalledWorker({ installed, fixedSql: "SELECT 1 AS n" });
    const assets = await inspectAssets(installed, worker.resolvedAssets);
    checks.push(outcome("installed-package-runtime", manifest.name === "@phosphorco/bb-plugin-analytics" && manifest.dependencies?.["@duckdb/duckdb-wasm"] === selectedWasmVersion && worker.resolvedWasmVersion === selectedWasmVersion && worker.exitCode === 0 && worker.signal === null && worker.closeObserved === true && same(worker.rows, [{ n: 1 }]) && assets !== null, "Built archive uses the exact selected Wasm version and runs its packaged worker; suite computes asset hashes and realpath containment."));
    // File containment does not establish what a process actually loaded. Keep
    // this gap nonpassing until the test-owned child invocation captures it.
    checks.push(check("installed-worker-provenance", "blocked", "Pending test-owned installed-runtime invocation tying actual child bootstrap asset/version evidence to the fixed query; binding-returned paths alone are insufficient."));
    return checks;
  } finally {
    try { if (packaged !== undefined) await operations.disposePackage({ packaged }); }
    finally { if (store !== undefined) await operations.disposeStore({ store }); }
  }
}

// This operation double is never used in normal acceptance.
function controlledOperations(fault) {
  let fixture, state, migrationRuns = 0;
  const diagnostics = { storeDisposals: 0, packageDisposals: 0 };
  return { diagnostics,
    async createPriorStore({ fixture: value }) { fixture = value; state = { appliedMigrations: value.priorMigrationCount, facts: [value.fact], bundleSourceJson: value.bundleSourceJson, referenceCapsuleJson: value.referenceCapsuleJson }; return {}; },
    async migrate({ beforeCommit }) {
      if (beforeCommit) { if (fault === "non-atomic") state.appliedMigrations++; beforeCommit(); }
      migrationRuns++;
      state = { ...state, appliedMigrations: fixture.targetMigrationCount, legacyResolution: structuredClone(fixture.legacyResolution) };
      if (fault === "drop-fact") state.facts = [];
      if (fault === "rewrite-bundle") state.bundleSourceJson = "{}";
      if (fault === "retroverify") state.legacyResolution.retroverified = true;
      if (fault === "non-idempotent") state.appliedMigrations += migrationRuns;
    },
    async reopen({ store }) { return store; },
    async readArtifacts() { return structuredClone(state); },
    async disposeStore() { diagnostics.storeDisposals++; },
    async createPackageFixture() { return {}; },
    async buildPackage() { if (fault === "build-throws") throw new Error("controlled build failure"); },
    async packPackage() { return {}; },
    async installArchive() { return { root: "/synthetic-installed" }; },
    async readInstalledManifest() { return { name: "@phosphorco/bb-plugin-analytics", dependencies: { "@duckdb/duckdb-wasm": "1.33.1-dev57.0" } }; },
    async runInstalledWorker() { return { resolvedWasmVersion: fault === "wrong-version" ? "0.0.0" : selectedWasmVersion, exitCode: fault === "worker-fails" ? 23 : 0, signal: null, closeObserved: true, rows: [{ n: 1 }], resolvedAssets: ["worker", "wasm"].map((kind) => ({ kind, path: (fault === "source-fallback" ? "/synthetic-checkout/" : "/synthetic-installed/") + kind })) }; },
    async disposePackage() { diagnostics.packageDisposals++; },
  };
}

async function selfTest() {
  // Virtual filesystem only for operation-double controls. Normal mode always
  // calls the real filesystem inspector above and computes its own hashes.
  const inspectSynthetic = async (installed, assets) => assets.every((x) => x.path.startsWith(installed.root + "/")) ? assets : null;
  const operations = controlledOperations();
  const positive = await runMigrationPackagingScenario(operations, inspectSynthetic);
  const checks = [outcome("instrument-self-test-positive", positive.filter((item) => item.id !== "installed-worker-provenance").every((item) => item.status === "pass") && positive.find((item) => item.id === "installed-worker-provenance")?.status === "blocked", "Existing oracles pass; unimplemented process provenance remains explicitly blocked even with a positive double."), outcome("instrument-self-test-cleanup", operations.diagnostics.storeDisposals === 1 && operations.diagnostics.packageDisposals === 1, "Both resources disposed.")];
  const faults = { "non-atomic": "interrupted-migration-rolls-back", "drop-fact": "migrates-concrete-prior-store", "rewrite-bundle": "preserves-authored-bundle-payload", retroverify: "preserves-v1-reference-as-unverified-lineage", "non-idempotent": "reconstructs-idempotently", "worker-fails": "installed-package-runtime", "source-fallback": "installed-package-runtime", "wrong-version": "installed-package-runtime" };
  for (const [fault, oracle] of Object.entries(faults)) {
    const observed = await runMigrationPackagingScenario(controlledOperations(fault), inspectSynthetic);
    checks.push(outcome("instrument-self-test-" + fault, observed.find((item) => item.id === oracle)?.status === "fail", "Isolated corruption fails " + oracle));
  }
  const interrupted = controlledOperations("build-throws");
  let propagated = false;
  try { await runMigrationPackagingScenario(interrupted, inspectSynthetic); } catch (error) { if (error.message !== "controlled build failure") throw error; propagated = true; }
  checks.push(outcome("instrument-self-test-throw-cleanup", propagated && interrupted.diagnostics.storeDisposals === 1 && interrupted.diagnostics.packageDisposals === 1, "Operation rejection propagates and disposes both resources."));
  return suiteResult("migration-packaging", checks, ["Instrument controls only: no DB, migration, build/install or worker executed."]);
}

export async function runSuite(options = {}) {
  if (isInstrumentSelfTest(options)) return selfTest();
  createMigrationFixture();
  const binding = await loadOptionalTestBinding("migration-packaging");
  if (binding.kind !== "loaded") return suiteResult("migration-packaging", [check("production-migration-binding", binding.kind === "absent" ? "blocked" : "fail", binding.details)]);
  return suiteResult("migration-packaging", await runMigrationPackagingScenario(binding.operations));
}
