import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const allowed = new Set(["--bounded", "--assert-evidence"]);
const args = process.argv.slice(2);
if (!args.includes("--bounded") || args.some((arg) => !allowed.has(arg))) {
  throw new Error("Usage: node probes/run.mjs --bounded [--assert-evidence]");
}

const aggregateDeadline = performance.now() + 240_000;
function runStage(url, budgetMs, mode = "") {
  return new Promise((resolve) => {
    const grouped = process.platform !== "win32";
    const child = spawn(process.execPath, [fileURLToPath(url)], {
      detached: grouped, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ANALYTICS_RUNTIME_PROBE_ENGINE_ONLY: mode },
    });
    let stdout = "";
    let bytes = 0;
    let stderr = "";
    let settled = false;
    let termination = null;
    let grace;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(value);
    };
    const terminate = (reason) => {
      if (termination || settled) return;
      termination = reason;
      try {
        if (grouped && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* A missing process is accounted for by its exit result. */ }
      grace = setTimeout(() => finish({ status: "failure", error: `${reason}: exit unconfirmed` }), 2_000);
    };
    const timer = setTimeout(() => terminate("aggregate-stage-deadline"), Math.max(1, budgetMs));
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) terminate("aggregate-output-cap");
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.byteLength(stderr) + chunk.length > 64 * 1024) terminate("aggregate-stderr-cap");
      else stderr += chunk.toString();
    });
    child.on("error", () => finish({ status: "failure", error: "Probe process could not start" }));
    child.on("close", (code, signal) => {
      if (termination || code !== 0) {
        finish({ status: "failure", error: termination ?? "Probe process failed", code, signal,
          diagnostic: stderr.slice(0, 500) });
        return;
      }
      try { finish(JSON.parse(stdout)); }
      catch { finish({ status: "failure", error: "Probe returned invalid JSON" }); }
    });
  });
}

// Do not parallelize timing stages. Process groups bound the entire stage,
// including descendants, if its own instrument deadlines fail.
const entries = [
  ["source", "source", ""], ["baseline", "baseline", ""], ["runtime", "runtime", ""],
  ["runtimeAs", "runtime", "node-api-as1536"],
  ["runtimeParser", "runtime", "node-api-parser-only"],
  ["nativePackaging", "baseline/packaging", ""],
];
const reports = {};
const instruments = {};
const stageWallMs = {};
for (const [entry, directory, mode] of entries) {
  const url = new URL(`./${directory}/probe.mjs`, import.meta.url);
  instruments[entry] = createHash("sha256").update(await readFile(url)).digest("hex");
  const started = performance.now();
  try {
    const remaining = aggregateDeadline - performance.now();
    reports[entry] = remaining <= 0
      ? { status: "failure", error: "Aggregate deadline exhausted" }
      : await runStage(url, Math.min(remaining, entry === "runtime" ? 180_000 : 30_000), mode);
  } catch (error) {
    reports[entry] = {
      status: "failure",
      error: error instanceof Error ? error.message.slice(0, 500) : "Probe failed",
    };
  }
  stageWallMs[entry] = performance.now() - started;
}
instruments.runtimeChild = createHash("sha256")
  .update(await readFile(new URL("./runtime/engine-child.cjs", import.meta.url))).digest("hex");
async function fingerprintTree(relative = "") {
  const directory = new URL(`./${relative}`, import.meta.url);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${relative}${entry.name}`;
    if (entry.isDirectory()) await fingerprintTree(`${path}/`);
    else if (entry.isFile() && /\.(?:mjs|cjs|ts|json)$/.test(entry.name)) {
      instruments[path] = createHash("sha256").update(await readFile(new URL(path, new URL("./", import.meta.url)))).digest("hex");
    }
  }
}
await fingerprintTree();

const failures = [];
function requireEvidence(name, check) {
  try { check(); } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message : String(error) });
  }
}
requireEvidence("source", () => {
  const report = reports.source;
  assert.notEqual(report.status, "failure");
  assert.ok(report.checks?.length >= 10);
  assert.ok(report.checks.every((check) => check.status === "observed"));
  assert.equal(report.syntheticControls?.passed, true);
  assert.ok(report.unsupported?.length > 0, "Preserve unsupported source guarantees");
});
requireEvidence("baseline", () => {
  const report = reports.baseline;
  assert.ok(["observed", "unsupported"].includes(report.status));
  assert.deepEqual(report.summary?.failures, []);
  assert.equal(report.historical?.status, "observed");
  for (const name of ["child-process-boundary-controls", "historical-sql-policy-witness",
    "historical-exclusive-queue-witness", "baseline-fixture-inventory", "synthetic-stage-timings"]) {
    const stage = report.probes?.find((probe) => probe.probe === name);
    assert.equal(stage?.status, "observed", name);
    assert.equal(stage?.controls?.passed, true, name);
  }
});
requireEvidence("runtime", () => {
  const report = reports.runtime;
  assert.ok(["observed", "unsupported"].includes(report.status));
  // Missing candidate setup must not masquerade as an engine comparison.
  const candidate = report.engines?.nodeApi;
  assert.equal(candidate?.packaging?.status, "observed",
    "Prepare the documented scratch node-api install and set ANALYTICS_NODE_API_ROOT");
  assert.equal(candidate.packaging.evidence?.version ?? candidate.packaging.version, "1.5.5-r.4");
  assert.match(report.source?.communityPluginsRevision ?? "", /^[0-9a-f]{40}$/);
  assert.ok(report.source?.tracked?.some((file) => file.path.endsWith("builtin-bundles.ts")));
  for (const stage of [candidate.cold, candidate.warm, candidate.deadlineRecovery?.recovery]) {
    assert.equal(stage?.status, "observed");
    assert.equal(stage.payloadValid, true);
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.output?.facts, 25_000);
    assert.equal(stage.output?.preparedSql?.status, "observed");
    assert.equal(stage.output?.preparedSql?.rows, 8);
    assert.equal(stage.output?.executionGrammarControl?.status, "observed");
    assert.equal(stage.output?.parserSerialization?.status, "observed");
    assert.equal(stage.output?.memoryLimit?.status, "observed");
  }
  assert.equal(candidate.deadlineRecovery?.status, "observed");
  assert.equal(candidate.deadlineRecovery.deadline?.status, "deadline-killed");
  assert.equal(candidate.deadlineRecovery.deadline?.queryDispatched, true);
  assert.equal(candidate.deadlineRecovery.deadline?.signal, "SIGKILL");
  assert.equal(candidate.deadlineRecovery.deadline?.killReason, "query-deadline");
  assert.ok(report.limitations?.length > 0, "Containment limits must remain visible");
});
requireEvidence("address-space-fit", () => {
  const report = reports.runtimeAs;
  assert.equal(report.status, "observed");
  assert.equal(report.controls?.asBytes, 1_610_612_736);
  assert.equal(report.controls?.cpuSeconds, 5);
  assert.deepEqual(report.controls?.nodeArgs, ["--jitless", "--max-old-space-size=64", "--max-semi-space-size=4"]);
  for (const stage of [report.fit, report.recovery]) {
    assert.equal(stage?.status, "observed");
    assert.equal(stage.exitCode, 0);
    assert.equal(stage.payloadValid, true);
    assert.equal(stage.output?.facts, 25_000);
    assert.equal(stage.output?.preparedSql?.status, "observed");
    assert.equal(stage.output?.preparedSql?.rows, 8);
    assert.equal(stage.output?.parserSerialization?.status, "observed");
    for (const envelope of [stage.output?.readyEnvelope, stage.output?.setupEnvelope]) {
      for (const [name, expected] of [["Max address space", "1610612736"], ["Max cpu time", "5"]]) {
        assert.equal(envelope?.limits?.[name]?.soft, expected);
        assert.equal(envelope?.limits?.[name]?.hard, expected);
      }
    }
  }
});
requireEvidence("parser-compatibility", () => {
  const report = reports.runtimeParser;
  assert.equal(report.status, "observed");
  assert.equal(report.measurement?.status, "observed");
  assert.equal(report.measurement?.payloadValid, true);
  const inputs = report.measurement?.output?.parserOnly;
  assert.equal(inputs?.length, 16);
  assert.equal(inputs.filter((input) => input.id.startsWith("builtin-")).length, 11);
  for (const input of inputs) {
    assert.equal(input.status, "observed");
    assert.equal(input.statementCount, 1);
    assert.equal(input.nodeType, "SELECT_NODE");
    assert.match(input.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(inputs.find((input) => input.id === "nested-catalog")?.relationNodes
    ?.some((node) => node.type === "BASE_TABLE" && node.schema_name === "information_schema" && node.table_name === "tables"));
  assert.ok(inputs.find((input) => input.id === "range-table-function")?.relationNodes
    ?.some((node) => node.type === "TABLE_FUNCTION" && node.function_name === "range"));
  const commaRelations = inputs.find((input) => input.id === "comma-join")?.relationNodes;
  assert.ok(commaRelations?.some((node) => node.type === "BASE_TABLE" && node.table_name === "tool_execution_fact_v1"));
  assert.ok(commaRelations?.some((node) => node.type === "TABLE_FUNCTION" && node.function_name === "range"));
  assert.ok(inputs.find((input) => input.id === "named-parameter")?.parameterNodes
    ?.some((node) => node.type === "VALUE_PARAMETER" && node.identifier === "range_days"));
});
requireEvidence("native-packaging-policy", () => {
  const report = reports.nativePackaging;
  assert.equal(report.status, "unsupported");
  assert.equal(report.assertions?.passed, true);
  assert.deepEqual(report.assertions?.failures, []);
  assert.equal(report.conclusion?.viableNow, false);
  assert.equal(report.conclusion?.classification, "unsupported-platform-policy");
  // This observation disqualifies the candidate for current community delivery;
  // collecting it is not permission to bypass the installer/native policy.
});

const report = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  status: failures.length ? "failure" : "evidence-collected-with-limitations",
  runtimeQualified: false,
  meaning: "Probe observations only. The plan's runtime ruling requires separate review of containment, packaging and unresolved findings.",
  host: { platform: platform(), release: release(), node: process.version,
    cpuModel: cpus()[0]?.model ?? "unknown", logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  instruments, stageWallMs, failures, reports,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (args.includes("--assert-evidence") && failures.length) process.exitCode = 1;
