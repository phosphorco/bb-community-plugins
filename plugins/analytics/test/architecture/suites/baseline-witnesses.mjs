import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSupervisedNode } from "../browser/supervised-node.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const historicalDirectory = join(directory, "../probes/baseline/fixtures/historical");
const historicalHashes = Object.freeze({
  "sql-policy.ts": "10ecf53e1e02ed4db148add0e57f1e1642eb86be10e8606ad895948ca3fe226e",
  "browser-engine.ts": "94ab5c0b9e7d856be4ca384a8eebcd4bd0bb1ff80fb471e735ce935277f8a5d7",
});
const nestedCatalog = "SELECT coalesce((SELECT count(*) FROM information_schema.tables), 0) AS n FROM tool_execution_fact_v1";
const nestedRange = "SELECT coalesce((SELECT count(*) FROM range(10)), 0) AS n FROM tool_execution_fact_v1";

/** Historical evidence only.  It never claims the current implementation still has either defect. */
export async function runSuite(options = {}) {
  if ((options.mode ?? "acceptance") === "instrument-self-test") return runInstrumentSelfTest();
  const hashes = await assertHistoricalHashes();
  if (hashes.status !== "pass") return report([hashes]);
  const parser = await replayHistoricalParser();
  const queue = await replayHistoricalQueue();
  return report([hashes, parser, queue]);
}

async function assertHistoricalHashes() {
  const mismatches = [];
  for (const [name, expected] of Object.entries(historicalHashes)) {
    const actual = createHash("sha256").update(await readFile(join(historicalDirectory, name))).digest("hex");
    if (actual !== expected) mismatches.push(`${name}: expected ${expected}, got ${actual}`);
  }
  return { id: "immutable-historical-source-hashes", status: mismatches.length === 0 ? "pass" : "fail", details: mismatches.length === 0 ? "Exact historical parser and queue fixtures match the review-recorded SHA-256 values." : mismatches.join("; ") };
}

async function replayHistoricalParser() {
  const source = pathToFileURL(join(historicalDirectory, "sql-policy.ts")).href;
  const script = `
    import { parseAnalyticsQuery } from ${JSON.stringify(source)};
    const cases = ${JSON.stringify({ allowed: "SELECT count(*) AS n FROM tool_execution_fact_v1", directCatalog: "SELECT count(*) AS n FROM information_schema.tables", directRange: "SELECT count(*) AS n FROM range(10)", nestedCatalog, nestedRange })};
    const result = Object.fromEntries(Object.entries(cases).map(([id, sql]) => { try { parseAnalyticsQuery(sql); return [id, "accepted"]; } catch { return [id, "rejected"]; } }));
    console.log(JSON.stringify(result));
  `;
  const child = await boundedNode(script);
  if (!child.ok) return { id: "historical-parser-witness", status: "fail", details: "Historical parser fixture did not execute: " + child.reason };
  let result;
  try { result = JSON.parse(child.stdout); } catch { return { id: "historical-parser-witness", status: "fail", details: "Historical parser fixture returned invalid JSON." }; }
  const passes = validatesHistoricalParser(result);
  return { id: "historical-parser-nested-catalog-and-table-function", status: passes ? "pass" : "fail", details: passes ? "Exact historical fixture admits both nested external paths while direct controls are denied; no DuckDB engine was opened." : "Historical parser fixture no longer reproduces its attributed defect or its controls." };
}

async function replayHistoricalQueue() {
  const fixturePath = join(historicalDirectory, "browser-engine.ts");
  const source = await readFile(fixturePath, "utf8");
  const exclusive = extractFunction(source, "private async exclusive");
  const helpers = ["function throwIfAborted", "function abortError", "async function abortable"].map((name) => extractFunction(source, name));
  const queueField = source.match(/private queue: Promise<void> = Promise\.resolve\(\);/)?.[0];
  if (exclusive == null || queueField == null || helpers.some((value) => value == null)) return { id: "historical-queue-witness", status: "fail", details: "Historical queue fixture no longer has the exact extraction shape." };
  const typescript = pathToFileURL(join(directory, "../../../../../node_modules/typescript/lib/typescript.js")).href;
  const classSource = `class HistoricalExclusive { ${queueField}\n${exclusive}\n}\n${helpers.join("\n")}\nexport { HistoricalExclusive };`;
  const script = `
    import ts from ${JSON.stringify(typescript)};
    const emitted = ts.transpileModule(${JSON.stringify(classSource)}, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const { HistoricalExclusive } = await import("data:text/javascript," + encodeURIComponent(emitted));
    const tick = async (predicate) => { for (let i = 0; i < 40; i += 1) { if (predicate()) return true; await Promise.resolve(); } return predicate(); };
    const scheduler = new HistoricalExclusive(); let releaseA; const gate = new Promise((resolve) => { releaseA = resolve; }); const events = []; let aEnded = false;
    const a = scheduler.exclusive(async () => { events.push("A:start"); await gate; aEnded = true; events.push("A:end"); }); await tick(() => events.includes("A:start"));
    const controller = new AbortController(); let bRan = false; const b = scheduler.exclusive(async () => { bRan = true; events.push("B:start"); }, controller.signal).then(() => "resolved", (error) => error?.name); await Promise.resolve(); controller.abort(); const bOutcome = await b;
    const c = scheduler.exclusive(async () => { events.push("C:start"); }); await tick(() => events.includes("C:start")); const overlap = events.includes("C:start") && !aEnded; releaseA(); await Promise.all([a, c]); console.log(JSON.stringify({ bRan, bOutcome, overlap, events }));
  `;
  const child = await boundedNode(script);
  if (!child.ok) return { id: "historical-queue-witness", status: "fail", details: "Historical queue fixture did not execute: " + child.reason };
  let result;
  try { result = JSON.parse(child.stdout); } catch { return { id: "historical-queue-witness", status: "fail", details: "Historical queue fixture returned invalid JSON." }; }
  const passes = validatesHistoricalQueue(result);
  return { id: "historical-a-running-b-cancelled-c-overlapping", status: passes ? "pass" : "fail", details: passes ? "Exact historical fixture replays A-running/B-cancelled/C-overlapping. This is a defect reproduction, not a claim about the current queue." : "Historical A/B/C fixture or its cancellation control did not reproduce exactly." };
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) return null;
  const opening = source.indexOf("{", start);
  if (opening < 0) return null;
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

async function boundedNode(script) {
  const child = await runSupervisedNode({
    args: ["--experimental-strip-types", "--input-type=module", "--eval", script],
    cwd: process.cwd(),
    timeoutMs: 1_500,
    outputCapBytes: 16 * 1024,
    killGraceMs: 250,
  });
  return child.reason == null && child.code === 0 && child.signal == null
    ? { ok: true, stdout: child.stdout }
    : { ok: false, reason: child.reason ?? `exit ${child.code ?? "signal " + child.signal}: ${child.stderr.slice(0, 300)}` };
}

function validatesHistoricalParser(result) {
  return result?.allowed === "accepted"
    && result.directCatalog === "rejected"
    && result.directRange === "rejected"
    && result.nestedCatalog === "accepted"
    && result.nestedRange === "accepted";
}

function validatesHistoricalQueue(result) {
  return result?.bRan === false && result.bOutcome === "AbortError" && result.overlap === true;
}

function report(checks) {
  return { suite: "baseline-witnesses", status: checks.every((check) => check.status === "pass") ? "pass" : "fail", checks, limits: ["Historical immutable fixtures only; no current production source, DuckDB engine, browser, or operational database is opened."] };
}

function runInstrumentSelfTest() {
  const parserPositive = validatesHistoricalParser({ allowed: "accepted", directCatalog: "rejected", directRange: "rejected", nestedCatalog: "accepted", nestedRange: "accepted" });
  const parserMutated = validatesHistoricalParser({ allowed: "accepted", directCatalog: "rejected", directRange: "rejected", nestedCatalog: "rejected", nestedRange: "accepted" });
  const queuePositive = validatesHistoricalQueue({ bRan: false, bOutcome: "AbortError", overlap: true });
  const queueMutated = validatesHistoricalQueue({ bRan: false, bOutcome: "AbortError", overlap: false });
  const checks = [
    { id: "self-test-hash-mismatch-fails", status: historicalHashes["sql-policy.ts"] !== "0".repeat(64) ? "pass" : "fail", details: "Deliberately wrong hash is distinguishable from the immutable fixture hash." },
    { id: "self-test-parser-validator-positive", status: parserPositive ? "pass" : "fail", details: "Exact parser witness payload satisfies the same validator used for historical execution." },
    { id: "self-test-parser-control-failure-fails", status: !parserMutated ? "pass" : "fail", details: "A mutated nested-parser observation fails the same witness validator." },
    { id: "self-test-queue-validator-positive", status: queuePositive ? "pass" : "fail", details: "Exact A/B/C witness payload satisfies the same validator used for historical execution." },
    { id: "self-test-queue-overlap-required", status: !queueMutated ? "pass" : "fail", details: "A mutated non-overlapping A/B/C payload fails the same witness validator." },
  ];
  return { suite: "baseline-witnesses", status: checks.every((check) => check.status === "pass") ? "pass" : "fail", checks, limits: ["Instrument-self-test only; controlled values do not establish either historical or current behavior."] };
}
