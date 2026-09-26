#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { decodeChildResult, runSuiteProcess } from "./runner/suite-process.mjs";

const knownSuites = Object.freeze(["observability-probe", "runtime-contract", "analytics-contract", "retention-surface", "composition"]);
const instrumentSuites = Object.freeze({
  providers: ["catalog-delivery", "provider-codex", "provider-claude"],
  projection: ["retained-projection"],
  "query-ui": ["dashboard-queries", "dashboard-ui"],
});
const suiteName = /^[a-z][a-z0-9-]{0,63}$/;

function usage() {
  return "usage: node test/skills/acceptance.mjs [--suite <name>]... [--suite-instrument <name>]... [--self-check] [--negative-control <name,...>] [--timeout-ms <1..120000>] [--total-timeout-ms <1..300000>]";
}

function names(value, flag) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${flag} requires a value`);
  return value.split(",").filter(Boolean);
}

export function parseArguments(argv) {
  const selected = [];
  const controls = [];
  let mode = "acceptance";
  let timeoutMs = 30_000;
  let totalTimeoutMs = 120_000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--suite") selected.push(...names(argv[++index], argument));
    else if (argument === "--suite-instrument") {
      for (const group of names(argv[++index], argument)) {
        const suites = instrumentSuites[group];
        if (suites == null) throw new Error(`unknown suite instrument ${group}`);
        selected.push(...suites);
      }
    } else if (argument === "--self-check") {
      if (mode === "self-check") throw new Error("--self-check may be supplied once");
      mode = "self-check";
    } else if (argument === "--negative-control") controls.push(...names(argv[++index], argument));
    else if (argument === "--timeout-ms" || argument === "--total-timeout-ms") {
      const value = Number(argv[++index]);
      const maximum = argument === "--timeout-ms" ? 120_000 : 300_000;
      if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${argument} must be an integer from 1 through ${maximum}`);
      if (argument === "--timeout-ms") timeoutMs = value;
      else totalTimeoutMs = value;
    } else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`unknown argument ${argument}`);
  }
  for (const suite of selected) if (!suiteName.test(suite)) throw new Error(`unsafe suite name ${suite}`);
  for (const control of controls) if (!suiteName.test(control)) throw new Error(`unsafe negative control ${control}`);
  return {
    mode,
    suites: [...new Set(selected.length === 0 ? knownSuites : selected)],
    controls: [...new Set(controls)],
    timeoutMs,
    totalTimeoutMs,
  };
}

function suiteModule(suite) {
  if (!suiteName.test(suite)) throw new Error(`unsafe suite name ${suite}`);
  return new URL(`./suites/${suite}.mjs`, import.meta.url).href;
}

function failure(suite, id, details) {
  return { suite, status: "fail", checks: [{ id, status: "fail", details }], observations: [], limits: [] };
}

function boundedText(value, maximum = 320) {
  const text = typeof value === "string" ? value : String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

function deadlineResult(suite, id, details) {
  return failure(suite, id, details);
}

export async function runAcceptance(config) {
  const started = performance.now();
  const suites = [];
  for (const suite of config.suites) {
    const remaining = config.totalTimeoutMs - (performance.now() - started);
    if (remaining <= 0) {
      suites.push(deadlineResult(suite, "runner-total-deadline", "total runner deadline elapsed before this suite started"));
      continue;
    }
    const result = await runSuiteProcess({
      suite,
      module: suiteModule(suite),
      mode: config.mode,
      controls: config.controls,
      timeoutMs: Math.min(config.timeoutMs, Math.floor(remaining)),
    });
    suites.push(decodeChildResult(result, suite));
  }
  const status = suites.every((suite) => suite.status === "pass") ? "pass" : "fail";
  return { mode: config.mode, status, suites };
}

async function runNegativeControl(name) {
  if (name === "missing-suite") {
    const result = await runSuiteProcess({ suite: "missing-suite", module: new URL("./fixtures/bootstrap/no-such-suite.mjs", import.meta.url).href, mode: "acceptance", controls: [], timeoutMs: 250 });
    return { id: name, status: decodeChildResult(result, "missing-suite").status === "fail" ? "pass" : "fail", details: "A nonexistent suite module is reported as a failed acceptance result." };
  }
  const module = new URL(`./fixtures/bootstrap/${name}.mjs`, import.meta.url).href;
  const result = await runSuiteProcess({ suite: name, module, mode: "acceptance", controls: [], timeoutMs: 80, killGraceMs: 30, closeGraceMs: 30 });
  return { id: name, status: decodeChildResult(result, name).status === "fail" ? "pass" : "fail", details: "The controlled invalid suite is rejected by the same child process and protocol validator used for acceptance." };
}

function compactReport(report) {
  const full = JSON.stringify(report);
  if (full.length <= 24_000) return full;
  return JSON.stringify({ mode: report.mode, status: report.status, outputTruncated: true, suites: report.suites.map(({ suite, status }) => ({ suite, status })) });
}

async function runSelfCheck(config) {
  const normal = await runAcceptance(config);
  const required = ["missing-suite", "rejected-import", "malformed-observation", "timeout", "wrong-value"];
  const controls = [];
  for (const control of required) {
    // Every critical failure mode is asserted on every self-check. Named controls
    // additionally reject misspellings at argument parsing time.
    controls.push(await runNegativeControl(control));
  }
  const selfCheck = { suite: "runner-self-check", status: controls.every((check) => check.status === "pass") ? "pass" : "fail", checks: controls, observations: [], limits: ["Controlled invalid suites are intentionally rejected and establish only fail-closed runner behavior."] };
  const suites = [...normal.suites, selfCheck];
  return { mode: config.mode, status: suites.every((suite) => suite.status === "pass") ? "pass" : "fail", suites };
}

async function main() {
  try {
    const config = parseArguments(process.argv.slice(2));
    if (config.help) return void process.stdout.write(`${usage()}\n`);
    const report = config.mode === "self-check" ? await runSelfCheck(config) : await runAcceptance(config);
    process.stdout.write(`${compactReport(report)}\n`);
    if (report.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
