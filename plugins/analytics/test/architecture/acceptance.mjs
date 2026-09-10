#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runSupervisedNode } from "./browser/supervised-node.mjs";

const suiteModules = Object.freeze({
  "baseline-witnesses": "./suites/baseline-witnesses.mjs", extraction: "./suites/extraction.mjs", "query-runtime": "./suites/query-runtime.mjs", references: "./suites/references.mjs", ui: "./suites/ui.mjs", composition: "./suites/composition.mjs", "end-to-end": "./suites/end-to-end.mjs", performance: "./suites/performance.mjs", "migration-packaging": "./suites/migration-packaging.mjs", "host-execution": "./suites/host-execution.mjs", "vertical-slice": "./suites/vertical-slice.mjs",
});
const resultPrefix = "@@bb-analytics-acceptance-result@@";
const here = new URL("./", import.meta.url).pathname;

function usage() { return "usage: node test/architecture/acceptance.mjs [--suite <name>]... [--instrument-self-test] [--timeout-ms <1..120000>] [--total-timeout-ms <1..300000>]"; }

export function parseArguments(argv) {
  const selected = []; let mode = "acceptance"; let timeoutMs = 30_000; let totalTimeoutMs = 120_000;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--suite") { const value = argv[++i]; if (!value) throw new Error("--suite requires a suite name"); selected.push(...value.split(",").filter(Boolean)); }
    else if (arg === "--instrument-self-test") mode = "instrument-self-test";
    else if (arg === "--timeout-ms" || arg === "--total-timeout-ms") {
      const value = Number(argv[++i]); const maximum = arg === "--timeout-ms" ? 120_000 : 300_000;
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${arg} must be an integer from 1 through ${maximum}`);
      if (arg === "--timeout-ms") timeoutMs = value; else totalTimeoutMs = value;
    } else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`unknown argument ${arg}`);
  }
  const suites = selected.length ? [...new Set(selected)] : Object.keys(suiteModules);
  for (const suite of suites) if (!(suite in suiteModules)) throw new Error(`unknown suite ${suite}`);
  return { mode, suites, timeoutMs, totalTimeoutMs };
}

function boundedText(value, maximum = 320) { const text = typeof value === "string" ? value : String(value); return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`; }
function boundedJson(value, maximum = 320) { try { return boundedText(JSON.stringify(value), maximum); } catch { return "[unserializable limit]"; } }
function failure(suite, id, details) { return { suite, status: "fail", checks: [{ id, status: "fail", details }], limits: [] }; }

/** Validate all checks and derive aggregate status—never trust suite.status alone. */
export function validateResult(value, suite) {
  if (value == null || value.suite !== suite || !Array.isArray(value.checks) || value.checks.length === 0) return failure(suite, "suite-protocol", "suite must return its exact name and at least one check");
  if (value.checks.length > 64) return failure(suite, "suite-protocol", "suite returned more than 64 checks");
  const checks = value.checks.map((check, index) => {
    if (typeof check?.id !== "string" || !check.id || !["pass", "fail", "blocked"].includes(check.status)) return { id: `invalid-check-${index}`, status: "fail", details: "invalid check protocol" };
    return { id: check.id, status: check.status, details: boundedText(check.details ?? "missing details") };
  });
  const derived = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "blocked") ? "blocked" : "pass";
  if (!["pass", "fail", "blocked"].includes(value.status) || value.status !== derived) return failure(suite, "suite-protocol", `suite status ${String(value.status)} contradicts validated check status ${derived}`);
  return { suite, status: derived, checks, limits: Array.isArray(value.limits) ? value.limits.slice(0, 8).map((limit) => boundedJson(limit)) : [] };
}

export async function runSuiteProcess({ suite, module, mode, timeoutMs, outputCapBytes = 16_384, killGraceMs = 1_000, closeGraceMs = 1_000 }) {
  return await runSupervisedNode({ args: [new URL("./browser/suite-child.mjs", import.meta.url).pathname, "--module", new URL(module, import.meta.url).href, "--mode", mode], cwd: here, timeoutMs, outputCapBytes, killGraceMs, closeGraceMs });
}

export function decodeChildResult(processResult, suite) {
  if (processResult.closeObserved !== true) return failure(suite, "suite-process", "child exit was not confirmed by close");
  if (processResult.reason === "deadline") return { suite, status: "blocked", checks: [{ id: "suite-deadline", status: "blocked", details: "suite process group exceeded its deadline and was terminated" }], limits: [] };
  if (processResult.reason?.endsWith("-cap")) return failure(suite, "suite-output-cap", `${processResult.reason} exceeded the bounded output cap`);
  if (processResult.reason?.startsWith("spawn:")) return failure(suite, "suite-spawn", processResult.reason);
  if (processResult.reason != null || processResult.code !== 0 || processResult.signal != null) return failure(suite, "suite-process", `suite exited abnormally (code ${processResult.code}, signal ${processResult.signal}, reason ${processResult.reason})`);
  const stdout = Buffer.isBuffer(processResult.stdout) ? processResult.stdout.toString("utf8") : String(processResult.stdout ?? "");
  const stderr = Buffer.isBuffer(processResult.stderr) ? processResult.stderr.toString("utf8") : String(processResult.stderr ?? "");
  const line = stdout.split("\n").find((entry) => entry.startsWith(resultPrefix));
  if (line == null) return failure(suite, "suite-process", `suite exited ${processResult.code ?? processResult.signal ?? "unknown"} without a protocol result; stderr: ${stderr}`);
  let envelope; try { envelope = JSON.parse(line.slice(resultPrefix.length)); } catch { return failure(suite, "suite-process", "suite emitted malformed protocol JSON"); }
  if (envelope.ok === true) return validateResult(envelope.result, suite);
  if (envelope.phase === "import" && envelope.code === "ERR_MODULE_NOT_FOUND" && envelope.missingModule === envelope.module) return { suite, status: "blocked", checks: [{ id: "suite-module", status: "blocked", details: `planned suite module is absent: ${envelope.module ?? "unknown"}` }], limits: [] };
  return failure(suite, "suite-process", boundedText(`${envelope.phase ?? "run"}: ${envelope.message ?? "unknown suite error"}`));
}

function compactReport(report) {
  const full = JSON.stringify(report); if (full.length <= 24_000) return full;
  const compact = { mode: report.mode, status: report.status, outputTruncated: true, suites: report.suites.map((suite) => ({ suite: suite.suite, status: suite.status, checks: suite.checks.slice(0, 5).map((check) => ({ ...check, details: boundedText(check.details, 100) })), limits: suite.limits.slice(0, 2).map((limit) => boundedText(limit, 100)) })) };
  const text = JSON.stringify(compact); return text.length <= 24_000 ? text : JSON.stringify({ mode: report.mode, status: report.status, outputTruncated: true, suites: report.suites.map(({ suite, status }) => ({ suite, status })) });
}

export async function runAcceptance(config) {
  const started = performance.now(); const suites = [];
  for (const suite of config.suites) {
    const remaining = config.totalTimeoutMs - (performance.now() - started);
    if (remaining <= 0) { suites.push({ suite, status: "blocked", checks: [{ id: "runner-total-deadline", status: "blocked", details: "total runner deadline elapsed before this suite started" }], limits: [] }); continue; }
    suites.push(decodeChildResult(await runSuiteProcess({ suite, module: suiteModules[suite], mode: config.mode, timeoutMs: Math.min(config.timeoutMs, remaining) }), suite));
  }
  const status = suites.some((suite) => suite.status === "fail") ? "fail" : suites.some((suite) => suite.status === "blocked") ? "blocked" : "pass";
  return { mode: config.mode, status, suites };
}

async function main() {
  try { const config = parseArguments(process.argv.slice(2)); if (config.help) return void process.stdout.write(`${usage()}\n`); const report = await runAcceptance(config); process.stdout.write(`${compactReport(report)}\n`); if (report.status !== "pass") process.exitCode = 1; }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : error}\n${usage()}\n`); process.exitCode = 1; }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
