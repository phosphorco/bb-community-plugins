import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const pluginDirectory = join(probeDirectory, "../../../../");
const communityDirectory = join(pluginDirectory, "../..");
const workspaceDirectory = join(communityDirectory, "..");
const sourceFiles = [
  "sql-policy.ts",
  "browser-engine.ts",
  "fact-projection.ts",
  "fact-schema.ts",
  "store.ts",
  "analytics-model.ts",
  "command-signature.ts",
  "formatting.ts",
  "builtin-bundles.ts",
  "analytics-reference.ts",
  "app.tsx",
  "echarts-options.ts",
  "echarts-figure.tsx",
  "package.json",
];

const historicalSql = Object.freeze({
  catalog: "SELECT coalesce((SELECT count(*) FROM information_schema.tables), 0) AS n FROM tool_execution_fact_v1",
  range: "SELECT coalesce((SELECT count(*) FROM range(10)), 0) AS n FROM tool_execution_fact_v1",
});
const historicalFixtureDirectory = join(probeDirectory, "fixtures/historical");
const historicalFixtures = Object.freeze({
  "sql-policy.ts": "10ecf53e1e02ed4db148add0e57f1e1642eb86be10e8606ad895948ca3fe226e",
  "browser-engine.ts": "94ab5c0b9e7d856be4ca384a8eebcd4bd0bb1ff80fb471e735ce935277f8a5d7",
});
const CHILD_TIMEOUT_MS = 1_500;
const CHILD_KILL_GRACE_MS = 250;
const CHILD_STDOUT_CAP_BYTES = 16 * 1024;
const CHILD_STDERR_CAP_BYTES = 4 * 1024;
const BASELINE_FACT_LIMIT = 25_000;
const BASELINE_SAMPLES = 30;
const BASELINE_FIXED_NOW = 1_728_000_000_000;

/**
 * Produce bounded, redacted baseline evidence. This probe intentionally does
 * not open DuckDB, fetch facts, refresh a dashboard, or mount a browser UI.
 */
export async function runProbe() {
  const source = await sourceIdentity();
  const historical = await historicalFixtureIdentity();
  const runner = await runCommandControls();
  const historicalSql = await safelyRun("historical-sql-policy-witness", () => runSqlPolicyWitness({
    sourcePath: join(historicalFixtureDirectory, "sql-policy.ts"),
    probe: "historical-sql-policy-witness",
    requireWitness: true,
  }));
  const sqlPolicy = await safelyRun("current-sql-policy-behavior", runSqlPolicyWitness);
  const historicalQueue = await safelyRun("historical-exclusive-queue-witness", () => runQueueWitness({
    sourcePath: join(historicalFixtureDirectory, "browser-engine.ts"),
    probe: "historical-exclusive-queue-witness",
    requireWitness: true,
  }));
  const queue = await safelyRun("current-exclusive-queue-behavior", runQueueWitness);
  const fixtures = await safelyRun("baseline-fixture-inventory", runFixtureInventory);
  const timings = await safelyRun("synthetic-stage-timings", runSyntheticStageTimings);
  const probes = [runner, historicalSql, sqlPolicy, historicalQueue, queue, fixtures, timings];
  const summary = summarize(source, historical, probes);
  return {
    probe: "analytics-baseline",
    contractVersion: 1,
    status: summary.status,
    summary,
    source,
    historical,
    probes,
    limitations: [
      "No DuckDB engine was opened and no SQL was executed; parser admission is not execution containment evidence.",
      "No HTTP facts endpoint, persisted source data, refresh RPC, service reload, or browser UI was touched.",
      "Queue timings are synthetic microtask ordering only; they are not real UI TTFUR, SQL cancellation, or shared-host performance measurements.",
      "The UI observation compiles a synthetic canonical result without a DOM. It does not establish ECharts sizing, rendering, pointer behavior, exports, or lifecycle cleanup.",
      "Source hashes identify this dirty working-tree observation; rerun before relying on it after any source change.",
    ],
  };
}

async function historicalFixtureIdentity() {
  const files = {};
  try {
    for (const [name, expected] of Object.entries(historicalFixtures)) {
      const value = await readFile(join(historicalFixtureDirectory, name));
      const actual = sha256(value);
      files[`baseline/fixtures/historical/${name}`] = { expected, actual, matches: actual === expected };
    }
  } catch (cause) {
    return { status: "failure", files, error: errorText(cause) };
  }
  return {
    status: Object.values(files).every((entry) => entry.matches) ? "observed" : "failure",
    sourceRevision: "community-plugins:7a28e61f1816499cf6b9c6faca4a1f7ab4662e18",
    capturedAt: "2026-09-08",
    attribution: "Exact current source was copied only while its SHA-256 matched the review-recorded historical witness hash.",
    files,
  };
}

async function sourceIdentity() {
  const files = {};
  try {
    for (const name of sourceFiles) {
      const value = await readFile(join(pluginDirectory, name));
      files[`plugins/analytics/${name}`] = sha256(value);
    }
  } catch (cause) {
    return {
      repository: "community-plugins",
      revision: null,
      revisionStatus: "failure",
      files,
      error: errorText(cause),
    };
  }
  const revision = await command("git", ["-C", communityDirectory, "rev-parse", "HEAD"]);
  return {
    repository: "community-plugins",
    revision: revision.ok ? revision.stdout.trim() : null,
    revisionStatus: revision.ok ? "observed" : "failure",
    files,
    error: revision.ok ? null : childFailureSummary(revision),
  };
}

async function safelyRun(probe, operation) {
  try {
    return await operation();
  } catch (cause) {
    return {
      probe,
      status: "failure",
      controls: { passed: false },
      evidence: { reason: "Probe setup threw before a witness could run.", error: errorText(cause) },
      limitations: ["Thrown setup errors are infrastructure failures, never reproduced product defects."],
    };
  }
}

async function runCommandControls() {
  const timeout = await command(process.execPath, ["--eval", "setInterval(() => {}, 1_000)"], {
    timeoutMs: 100,
    stdoutCapBytes: 128,
    stderrCapBytes: 128,
  });
  const outputCap = await command(process.execPath, ["--eval", "process.stdout.write('x'.repeat(512))"], {
    timeoutMs: 500,
    stdoutCapBytes: 128,
    stderrCapBytes: 128,
  });
  const childFailure = await command(process.execPath, ["--eval", "process.exit(23)"], {
    timeoutMs: 500,
    stdoutCapBytes: 128,
    stderrCapBytes: 128,
  });
  const controlsPass = timeout.ok === false && timeout.termination === "timeout"
    && outputCap.ok === false && outputCap.termination === "stdout-cap"
    && childFailure.ok === false && childFailure.code === 23
    && exitCodeFor({ status: "failure" }) === 1 && exitCodeFor({ status: "observed" }) === 0;
  return {
    probe: "child-process-boundary-controls",
    status: controlsPass ? "observed" : "failure",
    controls: {
      timeoutKillsChild: timeout.ok === false && timeout.termination === "timeout",
      stdoutCapKillsChild: outputCap.ok === false && outputCap.termination === "stdout-cap",
      nonzeroExitFailsChild: childFailure.ok === false && childFailure.code === 23,
      cliFailureExitCode: exitCodeFor({ status: "failure" }) === 1,
      passed: controlsPass,
    },
    evidence: {
      timeout: childResultShape(timeout),
      outputCap: childResultShape(outputCap),
      childFailure: childResultShape(childFailure),
    },
    limitations: ["These are inert Node child controls only; they do not load Analytics or DuckDB."],
  };
}

async function runSqlPolicyWitness({
  sourcePath = join(pluginDirectory, "sql-policy.ts"),
  probe = "current-sql-policy-behavior",
  requireWitness = false,
} = {}) {
  const script = `
    import { parseAnalyticsQuery } from ${JSON.stringify(pathToFileURL(sourcePath).href)};
    const cases = ${JSON.stringify({
      ...historicalSql,
      allowed: "SELECT count(*) AS n FROM tool_execution_fact_v1",
      directCatalog: "SELECT count(*) AS n FROM information_schema.tables",
      directRange: "SELECT count(*) AS n FROM range(10)",
    })};
    const results = Object.fromEntries(Object.entries(cases).map(([name, sql]) => {
      try {
        const policy = parseAnalyticsQuery(sql);
        return [name, { outcome: "accepted", relations: policy.relations }];
      } catch (cause) {
        return [name, { outcome: "rejected", message: cause instanceof Error ? cause.message.slice(0, 240) : String(cause).slice(0, 240) }];
      }
    }));
    console.log(JSON.stringify(results));
  `;
  const result = await nodeTypescript(script);
  if (!result.ok) return infrastructureFailure(probe, result);
  const cases = parseChildJson(result);
  if (cases == null) return infrastructureFailure(probe, result, "Child returned invalid JSON.");
  const controlsPass = cases.allowed?.outcome === "accepted"
    && cases.directCatalog?.outcome === "rejected"
    && cases.directRange?.outcome === "rejected";
  const bypassPresent = cases.catalog?.outcome === "accepted" && cases.range?.outcome === "accepted";
  const classification = classifyWitness({ childOk: true, controlsPass, witnessPresent: bypassPresent });
  const archivedWitnessMissing = requireWitness && classification.status !== "observed";
  return {
    probe,
    status: archivedWitnessMissing ? "failure" : classification.status,
    controls: {
      positive: outcome(cases.allowed),
      negativeCatalog: outcome(cases.directCatalog),
      negativeRange: outcome(cases.directRange),
      passed: controlsPass,
    },
    evidence: {
      sourceSha256: sha256(await readFile(sourcePath)),
      currentBehavior: classification.behavior,
      exactHistoricalInputs: Object.keys(historicalSql),
      catalog: outcome(cases.catalog),
      range: outcome(cases.range),
      interpretation: archivedWitnessMissing
        ? "The immutable historical fixture did not reproduce its attributed defect; this is a fixture/control failure."
        : bypassPresent
        ? "Current parser admitted both nested external relation/table-function paths."
        : "Current parser did not admit both historical paths; this is a fixed-or-changed current behavior, not an infrastructure failure.",
    },
    limitations: ["Admission only; this probe does not execute either query against DuckDB."],
  };
}

async function runQueueWitness({
  sourcePath = join(pluginDirectory, "browser-engine.ts"),
  probe = "current-exclusive-queue-behavior",
  requireWitness = false,
} = {}) {
  const source = await readFile(sourcePath, "utf8");
  const exactExclusive = extractFunction(source, "private async exclusive");
  const helperNames = ["function throwIfAborted", "function abortError", "async function abortable"];
  const helpers = helperNames.map((name) => extractFunction(source, name));
  const queueField = source.match(/private queue: Promise<void> = Promise\.resolve\(\);/)?.[0] ?? null;
  if (exactExclusive == null || helpers.some((value) => value == null) || queueField == null) {
    return {
      probe,
      status: requireWitness ? "failure" : "unsupported",
      controls: { passed: false },
      evidence: {
        currentBehavior: "fixed-or-changed",
        reason: "Source no longer matches the attributed exclusive-method extraction shape.",
      },
      limitations: ["No synthetic reconstruction was substituted for an unextractable source method."],
    };
  }
  const typescriptPath = join(communityDirectory, "node_modules/typescript/lib/typescript.js");
  const script = `
    import { pathToFileURL } from "node:url";
    import ts from ${JSON.stringify(pathToFileURL(typescriptPath).href)};
    const source = ${JSON.stringify(`class CurrentProductionExclusive {\n  ${queueField}\n${exactExclusive}\n}\n${helpers.join("\n")}\nexport { CurrentProductionExclusive };`)};
    const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const { CurrentProductionExclusive } = await import("data:text/javascript," + encodeURIComponent(emitted));
    const tick = async (predicate) => {
      for (let count = 0; count < 40; count += 1) {
        if (predicate()) return true;
        await Promise.resolve();
      }
      return predicate();
    };
    const serial = new CurrentProductionExclusive();
    let releaseControl;
    const controlGate = new Promise((resolve) => { releaseControl = resolve; });
    const controlEvents = [];
    const controlA = serial.exclusive(async () => { controlEvents.push("A:start"); await controlGate; controlEvents.push("A:end"); });
    await tick(() => controlEvents.includes("A:start"));
    const controlB = serial.exclusive(async () => { controlEvents.push("B:start"); });
    await Promise.resolve();
    const controlHeld = !controlEvents.includes("B:start");
    releaseControl();
    await Promise.all([controlA, controlB]);
    const controlPassed = controlHeld && controlEvents.join(",") === "A:start,A:end,B:start";

    const scheduler = new CurrentProductionExclusive();
    let releaseA;
    const aGate = new Promise((resolve) => { releaseA = resolve; });
    const events = [];
    let aFinished = false;
    const a = scheduler.exclusive(async () => { events.push("A:start"); await aGate; aFinished = true; events.push("A:end"); });
    const aStarted = await tick(() => events.includes("A:start"));
    const controller = new AbortController();
    let bStarted = false;
    const b = scheduler.exclusive(async () => { bStarted = true; events.push("B:start"); }, controller.signal)
      .then(() => ({ name: "resolved" }), (error) => ({ name: error?.name ?? "unknown" }));
    await Promise.resolve();
    controller.abort();
    const bResult = await b;
    let cBeforeAFinished = false;
    const c = scheduler.exclusive(async () => { cBeforeAFinished = !aFinished; events.push("C:start"); });
    const cStarted = await tick(() => events.includes("C:start"));
    releaseA();
    await Promise.all([a, c]);
    console.log(JSON.stringify({ controlPassed, aStarted, bStarted, bResult, cStarted, cBeforeAFinished, events }));
  `;
  const result = await nodePlain(script);
  if (!result.ok) return infrastructureFailure(probe, result);
  const replay = parseChildJson(result);
  if (replay == null) return infrastructureFailure(probe, result, "Child returned invalid JSON.");
  const controlsPass = replay.controlPassed === true && replay.aStarted === true
    && replay.bStarted === false && replay.bResult?.name === "AbortError";
  const overlap = replay.cStarted === true && replay.cBeforeAFinished === true;
  const classification = classifyWitness({ childOk: true, controlsPass, witnessPresent: overlap });
  const archivedWitnessMissing = requireWitness && classification.status !== "observed";
  return {
    probe,
    status: archivedWitnessMissing ? "failure" : classification.status,
    controls: {
      positiveSerialQueue: replay.controlPassed === true,
      negativeCancelledBDoesNotRun: replay.bStarted === false && replay.bResult?.name === "AbortError",
      passed: controlsPass,
    },
    evidence: {
      sourceSha256: sha256(source),
      currentBehavior: classification.behavior,
      extraction: "Current browser-engine.ts exclusive() plus its current abort helpers were TypeScript-transpiled unchanged into an isolated synthetic harness.",
      exclusiveMethodSha256: sha256(exactExclusive),
      events: Array.isArray(replay.events) ? replay.events : [],
      cStartedBeforeAFinished: overlap,
      interpretation: archivedWitnessMissing
        ? "The immutable historical fixture did not reproduce its attributed queue overlap; this is a fixture/control failure."
        : overlap
        ? "A-running/B-cancelled/C-overlapping replayed from the current extracted production scheduling method."
        : "The controlled replay did not overlap C with A; this is a fixed-or-changed current behavior, not an infrastructure failure.",
    },
    limitations: [
      "Only the extracted scheduling method and helpers run; no BrowserAnalyticsEngine, Worker, fetch, DuckDB connection, or browser UI is initialized.",
      "This proves promise-queue ordering, not engine-level cancellation completion.",
    ],
  };
}

async function runFixtureInventory() {
  const script = `
    import { compileEChartsFigure } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "echarts-options.ts")).href)};
    import { BUILTIN_BUNDLES } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "builtin-bundles.ts")).href)};
    const result = {
      id: "baseline-query", generation: "baseline:synthetic", generationId: 1,
      columns: [{ name: "category", logicalType: "VARCHAR", nullable: false }, { name: "value", logicalType: "DOUBLE", nullable: false }],
      rows: [{ category: "alpha", value: 2 }, { category: "beta", value: 1 }],
      datumKeys: ["baseline:0", "baseline:1"], parameters: { rangeDays: 7, maxRows: 2 },
      extent: { kind: "exact", rows: 2 }, elapsedMs: 0, truncated: false, cached: false,
    };
    const theme = { foreground: "#111", muted: "#555", surface: "#fff", border: "#ddd", series: "#08c" };
    const figure = compileEChartsFigure({ id: "baseline-bar", queryId: "baseline-query", kind: "bar", title: "Baseline", x: "category", y: "value", format: "integer" }, result, theme, true);
    let negativeError = null;
    try { compileEChartsFigure({ id: "invalid", queryId: "baseline-query", kind: "bar", title: "Invalid", x: "missing", y: "value", format: "integer" }, result, theme, true); }
    catch (error) { negativeError = error instanceof Error ? error.message : String(error); }
    console.log(JSON.stringify({
      figure: { renderer: figure.renderer, plottedCount: figure.plottedCount, exportCount: figure.exportData.length, accessibleCount: figure.accessibleData.length, componentFamilies: Object.keys(figure.componentTopology).sort(), seriesType: figure.option.series?.[0]?.type ?? null },
      negativeError,
      builtins: BUILTIN_BUNDLES.map((bundle) => ({ id: bundle.id, queryCount: bundle.queries.length, visualizationCount: bundle.visualizations.length, layoutCount: bundle.layout.length, hasNativeCommandQuery: bundle.queries.some((query) => query.sql.includes("native:command_execution")) })),
    }));
  `;
  const compiled = await nodeTypescript(script);
  if (!compiled.ok) return infrastructureFailure("baseline-fixture-inventory", compiled);
  const evidence = parseChildJson(compiled, "baseline-fixture-inventory");
  if (evidence == null) return infrastructureFailure("baseline-fixture-inventory", compiled, "Child returned invalid JSON.");
  const sourceText = Object.fromEntries(await Promise.all([
    "fact-projection.ts", "fact-schema.ts", "browser-engine.ts", "analytics-reference.ts", "app.tsx", "echarts-options.ts",
  ].map(async (name) => [name, await readFile(join(pluginDirectory, name), "utf8")])));
  const fixturesPass = evidence.figure?.renderer === "svg" && evidence.figure?.plottedCount === 2
    && evidence.figure?.exportCount === 2 && evidence.figure?.accessibleCount === 2
    && typeof evidence.negativeError === "string" && evidence.negativeError.includes("missing dimension")
    && Array.isArray(evidence.builtins) && evidence.builtins.length === 3;
  return {
    probe: "baseline-fixture-inventory",
    status: fixturesPass ? "observed" : "failure",
    controls: {
      positiveSyntheticCompilation: evidence.figure?.plottedCount === 2,
      negativeMissingBinding: typeof evidence.negativeError === "string" && evidence.negativeError.includes("missing dimension"),
      passed: fixturesPass,
    },
    evidence: {
      syntheticFixture: evidence.figure,
      builtins: evidence.builtins,
      compatibility: {
        extraction: sourceText["fact-projection.ts"].includes("projectToolExecutionFact")
          && sourceText["fact-projection.ts"].includes("collectTurnTimings"),
        serialization: sourceText["browser-engine.ts"].includes("response.arrayBuffer()")
          && sourceText["browser-engine.ts"].includes("registerFileBuffer"),
        materialization: sourceText["fact-schema.ts"].includes("read_json_auto")
          && sourceText["browser-engine.ts"].includes("dropFile(FACT_FILE)"),
        sqlBoundary: sourceText["browser-engine.ts"].includes("parseAnalyticsQuery(query.sql)")
          && sourceText["browser-engine.ts"].includes("LIMIT ${maxRows + 1}"),
        referenceCapsule: sourceText["analytics-reference.ts"].includes("resultGeneration")
          && sourceText["analytics-reference.ts"].includes("coverage"),
        topbar: sourceText["app.tsx"].includes("analytics-toolbar")
          && sourceText["app.tsx"].includes("requestRefresh"),
        renderCompiler: sourceText["echarts-options.ts"].includes("MAX_BAR_MARKS")
          && sourceText["echarts-options.ts"].includes('renderer: "svg"'),
        nativeCommand: (evidence.builtins ?? []).some((bundle) => bundle.id === "tool-reliability" && bundle.hasNativeCommandQuery),
      },
    },
    limitations: [
      "All fixture rows are synthetic labels and numbers; no retained facts or user data are read.",
      "Compiler output is a semantic fixture shape, not a DOM/ECharts render or an interaction trace.",
      "Inventory confirms present source features only; it does not establish saved-bundle migration or reference authorization semantics.",
    ],
  };
}

async function runSyntheticStageTimings() {
  const script = `
    import Database from ${JSON.stringify(pathToFileURL(join(communityDirectory, "node_modules/better-sqlite3/lib/database.js")).href)};
    import { collectTurnTimings, projectToolExecutionFact } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "fact-projection.ts")).href)};
    import { AnalyticsStore, analyticsMigrations } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "store.ts")).href)};
    import { compileEChartsFigure } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "echarts-options.ts")).href)};
    import { createDatumKeys } from ${JSON.stringify(pathToFileURL(join(pluginDirectory, "analytics-model.ts")).href)};

    const FACT_COUNT = ${BASELINE_FACT_LIMIT};
    const SAMPLES = ${BASELINE_SAMPLES};
    const FIXED_NOW = ${BASELINE_FIXED_NOW};
    const dimensions = Object.freeze({ projectId: "synthetic-project", providerId: "synthetic-provider" });
    const theme = Object.freeze({ foreground: "#111", muted: "#555", surface: "#fff", border: "#ddd", series: "#08c" });
    let seed = 0x5eed1234;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const events = Array.from({ length: FACT_COUNT }, (_, index) => {
      const kind = next() % 3;
      const base = {
        id: "synthetic-event-" + index,
        threadId: "synthetic-thread-" + (index % 80),
        seq: index,
        createdAt: FIXED_NOW - (index % 14) * 86_400_000,
        scope: { kind: "turn", turnId: "synthetic-turn-" + (index % 400) },
        type: "item/completed",
      };
      if (kind === 0) return { ...base, data: { item: { type: "toolCall", tool: "tool_" + (index % 24), server: "synthetic", status: index % 17 === 0 ? "failed" : "completed", durationMs: index % 10_000, error: index % 17 === 0 ? "timeout 123" : undefined, arguments: { ignored: "not-retained" } } } };
      if (kind === 1) return { ...base, data: { item: { type: "commandExecution", command: index % 11 === 0 ? "rg --help" : "git status", status: "completed", exitCode: index % 19 === 0 ? 1 : 0, durationMs: index % 10_000 } } };
      return { ...base, data: { item: { type: "fileRead", status: "completed", path: "/synthetic/not-retained" } } };
    });
    const turnTimings = collectTurnTimings(Array.from({ length: 400 }, (_, index) => [
      { type: "turn/started", createdAt: FIXED_NOW - index * 1_000 - 100, scope: { kind: "turn", turnId: "synthetic-turn-" + index } },
      { type: "turn/completed", createdAt: FIXED_NOW - index * 1_000, scope: { kind: "turn", turnId: "synthetic-turn-" + index } },
    ]).flat());
    const timed = (operation) => {
      const started = performance.now();
      const value = operation();
      return { value, elapsedMs: performance.now() - started };
    };
    const stats = (samples) => {
      const ordered = [...samples].sort((left, right) => left - right);
      const rank = (fraction) => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
      return { samples: ordered.length, minMs: Number(ordered[0].toFixed(3)), p50Ms: Number(rank(0.5).toFixed(3)), p95Ms: Number(rank(0.95).toFixed(3)), maxMs: Number(ordered.at(-1).toFixed(3)) };
    };
    const projectAll = () => events.map((event) => projectToolExecutionFact(event, dimensions, turnTimings));
    const projectionSamples = [];
    let projectedFacts = null;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const measured = timed(projectAll);
      projectionSamples.push(measured.elapsedMs);
      if (sample === 0) projectedFacts = measured.value;
    }
    if (!Array.isArray(projectedFacts) || projectedFacts.length !== FACT_COUNT || projectedFacts.some((fact) => fact == null || "arguments" in fact || "error" in fact)) throw new Error("Synthetic projection control failed.");

    const publicationSamples = [];
    const serializationSamples = [];
    let ndjsonBytes = 0;
    let ndjsonRows = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const db = new Database(":memory:");
      try {
        for (const migration of analyticsMigrations) db.exec(migration);
        const store = new AnalyticsStore(db);
        publicationSamples.push(timed(() => store.replaceFacts(projectedFacts)).elapsedMs);
        const serialized = timed(() => store.factsAsNdjson(14, FIXED_NOW));
        serializationSamples.push(serialized.elapsedMs);
        if (sample === 0) {
          ndjsonBytes = Buffer.byteLength(serialized.value);
          ndjsonRows = serialized.value.split("\\n").length - 1;
        }
      } finally {
        db.close();
      }
    }
    if (ndjsonRows !== FACT_COUNT || ndjsonBytes <= 0) throw new Error("Disposable SQLite publication or NDJSON control failed.");

    const canonicalRows = Array.from({ length: 120 }, (_, index) => ({ category: "synthetic-category-" + index, value: (index * 17) % 101 }));
    const canonical = Object.freeze({
      id: "synthetic-shared-query", generation: "synthetic:fixed:1", generationId: 1,
      columns: [{ name: "category", logicalType: "VARCHAR", nullable: false }, { name: "value", logicalType: "DOUBLE", nullable: false }],
      rows: canonicalRows, datumKeys: createDatumKeys("synthetic:fixed:1", canonicalRows),
      parameters: { rangeDays: 14, maxRows: 120 }, extent: { kind: "exact", rows: 120 }, elapsedMs: 0, truncated: false, cached: false,
    });
    const compiler = {};
    for (const viewCount of [1, 10, 30]) {
      const samples = [];
      let control = null;
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const measured = timed(() => Array.from({ length: viewCount }, (_, index) => compileEChartsFigure({ id: "synthetic-view-" + index, queryId: canonical.id, kind: index % 2 === 0 ? "bar" : "line", title: "Synthetic view", x: "category", y: "value", format: "integer" }, canonical, theme, true)));
        samples.push(measured.elapsedMs);
        if (sample === 0) control = measured.value;
      }
      if (!Array.isArray(control) || control.length !== viewCount || control.some((figure) => figure.exportData !== canonical.rows || figure.plottedCount <= 0)) throw new Error("Shared canonical compiler control failed for " + viewCount + " views.");
      compiler[String(viewCount)] = stats(samples);
    }
    console.log(JSON.stringify({
      fixture: { seed: "0x5eed1234", fixedNow: FIXED_NOW, facts: FACT_COUNT, threads: 80, turns: 400, samples: SAMPLES, canonicalRows: canonical.rows.length, viewCounts: [1, 10, 30] },
      projection: stats(projectionSamples),
      sqlitePublication: stats(publicationSamples),
      ndjsonSerialization: { ...stats(serializationSamples), rows: ndjsonRows, bytes: ndjsonBytes },
      compiler,
      controls: { projectionFacts: projectedFacts.length === FACT_COUNT, ndjsonRows: ndjsonRows === FACT_COUNT, canonicalShared: true, factCapRespected: FACT_COUNT <= ${BASELINE_FACT_LIMIT} },
    }));
  `;
  const result = await nodeTypescript(script, { timeoutMs: 20_000 });
  if (!result.ok) return infrastructureFailure("synthetic-stage-timings", result);
  const evidence = parseChildJson(result);
  if (evidence == null) return infrastructureFailure("synthetic-stage-timings", result, "Child returned invalid JSON.");
  const controlsPass = evidence.fixture?.facts === BASELINE_FACT_LIMIT && evidence.fixture?.samples === BASELINE_SAMPLES
    && evidence.controls?.projectionFacts === true && evidence.controls?.ndjsonRows === true
    && evidence.controls?.canonicalShared === true && evidence.controls?.factCapRespected === true;
  return {
    probe: "synthetic-stage-timings",
    status: controlsPass ? "observed" : "failure",
    controls: { ...evidence.controls, passed: controlsPass },
    evidence,
    limitations: [
      "Projection uses only fixed synthetic completed-event objects; it does not query the BB SDK or persisted events.",
      "SQLite is an in-memory disposable database. Migration/setup, process startup, source fetch, DuckDB materialization/SQL, transfer, browser rendering, and host contention are intentionally omitted from these stage timings.",
      "Compiler timings build figures from one synthetic canonical result. They do not initialize ECharts, execute setOption, mount React, or measure first useful paint/TTFUR.",
    ],
  };
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

async function nodeTypescript(script, options) {
  return command(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], options);
}

async function nodePlain(script) {
  return command(process.execPath, ["--input-type=module", "--eval", script]);
}

function command(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? CHILD_TIMEOUT_MS;
  const stdoutCapBytes = options.stdoutCapBytes ?? CHILD_STDOUT_CAP_BYTES;
  const stderrCapBytes = options.stderrCapBytes ?? CHILD_STDERR_CAP_BYTES;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(executable, args, { cwd: workspaceDirectory, stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) {
      resolve({ ok: false, code: null, signal: null, termination: "spawn-error", stdout: "", stderr: errorText(cause), stdoutBytes: 0, stderrBytes: 0 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let termination = null;
    let deadline = null;
    let killGrace = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (deadline != null) clearTimeout(deadline);
      if (killGrace != null) clearTimeout(killGrace);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      resolve({
        ok: result.ok,
        code: result.code ?? null,
        signal: result.signal ?? null,
        termination,
        stdout,
        stderr,
        stdoutBytes,
        stderrBytes,
      });
    };
    const terminate = (reason) => {
      if (settled || termination != null) return;
      termination = reason;
      child.kill("SIGKILL");
      killGrace = setTimeout(() => finish({ ok: false }), CHILD_KILL_GRACE_MS);
    };
    const append = (channel, value, cap) => {
      const bytesValue = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      const bytes = bytesValue.byteLength;
      const used = channel === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, cap - used);
      const capturedBytes = Math.min(bytes, remaining);
      const captured = bytesValue.subarray(0, capturedBytes).toString("utf8");
      if (channel === "stdout") {
        stdout += captured;
        stdoutBytes += capturedBytes;
      } else {
        stderr += captured;
        stderrBytes += capturedBytes;
      }
      if (bytes > remaining) terminate(`${channel}-cap`);
    };
    const onStdout = (value) => append("stdout", value, stdoutCapBytes);
    const onStderr = (value) => append("stderr", value, stderrCapBytes);
    const onError = (error) => {
      termination ??= "spawn-error";
      stderr = `${stderr}${errorText(error)}`.slice(0, stderrCapBytes);
      stderrBytes = Buffer.byteLength(stderr);
      finish({ ok: false });
    };
    const onClose = (code, signal) => finish({ ok: termination == null && code === 0, code, signal });
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    deadline = setTimeout(() => terminate("timeout"), timeoutMs);
  });
}

function parseChildJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function infrastructureFailure(probe, result, reason = "Probe child exited unsuccessfully.") {
  return {
    probe,
    status: "failure",
    controls: { passed: false },
    evidence: { reason, ...childFailureSummary(result) },
    limitations: ["Infrastructure failures are deliberately not recorded as reproduced product defects."],
  };
}

function outcome(value) {
  return value?.outcome === "accepted" ? "accepted" : value?.outcome === "rejected" ? "rejected" : "unavailable";
}

function summarize(source, historical, probes) {
  const observed = probes.filter((probe) => probe.status === "observed").map((probe) => probe.probe);
  const unsupported = probes.filter((probe) => probe.status === "unsupported").map((probe) => probe.probe);
  const failures = [
    ...(source.revisionStatus === "failure" ? ["source-identity"] : []),
    ...(historical.status === "failure" ? ["historical-fixture-identity"] : []),
    ...probes.filter((probe) => probe.status === "failure").map((probe) => probe.probe),
  ];
  return {
    status: failures.length > 0 ? "failure" : unsupported.length > 0 ? "unsupported" : "observed",
    observed,
    unsupported,
    failures,
    hasPartialUnsupportedEvidence: unsupported.length > 0,
  };
}

/** Pure classification keeps current fixes distinct from child/import failures. */
export function classifyWitness({ childOk, controlsPass, witnessPresent }) {
  if (!childOk) return { status: "failure", behavior: "infrastructure-failure" };
  if (!controlsPass) return { status: "failure", behavior: "assertion-control-failure" };
  return witnessPresent
    ? { status: "observed", behavior: "historical-defect-present" }
    : { status: "unsupported", behavior: "fixed-or-changed" };
}

function childResultShape(result) {
  return {
    ok: result.ok,
    code: result.code,
    signal: result.signal,
    termination: result.termination,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
  };
}

function childFailureSummary(result) {
  return {
    exitCode: result.code ?? null,
    signal: result.signal ?? null,
    termination: result.termination ?? null,
    stdoutBytes: result.stdoutBytes ?? 0,
    stderrBytes: result.stderrBytes ?? 0,
    stderr: result.stderr ?? "",
  };
}

function errorText(cause) {
  return (cause instanceof Error ? cause.message : String(cause)).slice(0, 1_000);
}

export function exitCodeFor(report) {
  return report.status === "failure" ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await runProbe();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = exitCodeFor(report);
}
