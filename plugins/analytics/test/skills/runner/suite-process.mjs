import { runSupervisedNode } from "./supervised-node.mjs";

const prefix = "@@bb-skills-acceptance-result@@";
const observationStatuses = new Set(["observed", "unsupported", "unknown", "failed"]);

function boundedText(value, maximum = 320) {
  const text = typeof value === "string" ? value : String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…[truncated]`;
}

function failure(suite, id, details) {
  return { suite, status: "fail", checks: [{ id, status: "fail", details }], observations: [], limits: [] };
}

function validObservation(value) {
  return value != null
    && typeof value.id === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value.id)
    && typeof value.kind === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value.kind)
    && observationStatuses.has(value.status)
    && (value.details == null || typeof value.details === "string");
}

/** Validate every child assertion and observation; suite aggregate status is never trusted. */
export function validateResult(value, suite) {
  if (value == null || value.suite !== suite || !Array.isArray(value.checks) || value.checks.length === 0 || !Array.isArray(value.observations)) return failure(suite, "suite-protocol", "suite must return its exact name, at least one check, and an observations array");
  if (value.checks.length > 64 || value.observations.length > 128) return failure(suite, "suite-protocol", "suite exceeded the bounded check or observation count");
  const checks = value.checks.map((check, index) => {
    if (typeof check?.id !== "string" || !/^[a-z][a-z0-9-]{0,127}$/.test(check.id) || !["pass", "fail"].includes(check.status)) return { id: `invalid-check-${index}`, status: "fail", details: "invalid check protocol" };
    return { id: check.id, status: check.status, details: boundedText(check.details ?? "missing details") };
  });
  const observations = value.observations.map((observation) => validObservation(observation) ? { id: observation.id, kind: observation.kind, status: observation.status, details: boundedText(observation.details ?? "missing details") } : null);
  if (observations.some((observation) => observation == null)) return failure(suite, "suite-observation", "suite returned a malformed observation");
  const derived = checks.some((check) => check.status === "fail") ? "fail" : "pass";
  if (value.status !== derived) return failure(suite, "suite-protocol", `suite status ${String(value.status)} contradicts validated check status ${derived}`);
  return { suite, status: derived, checks, observations, limits: Array.isArray(value.limits) ? value.limits.slice(0, 8).map((limit) => boundedText(limit)) : [] };
}

export async function runSuiteProcess({ suite, module, mode, controls = [], timeoutMs, outputCapBytes, killGraceMs, closeGraceMs }) {
  return await runSupervisedNode({ args: [new URL("./suite-child.mjs", import.meta.url).pathname, "--module", module, "--mode", mode, "--negative-controls", JSON.stringify(controls)], cwd: new URL("../", import.meta.url).pathname, timeoutMs, outputCapBytes, killGraceMs, closeGraceMs });
}

export function decodeChildResult(processResult, suite) {
  if (processResult.closeObserved !== true) return failure(suite, "suite-process", "child exit was not confirmed by close");
  if (processResult.reason === "deadline") return failure(suite, "suite-deadline", "suite process exceeded its deadline and was terminated");
  if (processResult.reason?.endsWith("-cap")) return failure(suite, "suite-output-cap", `${processResult.reason} exceeded the bounded output cap`);
  if (processResult.reason?.startsWith("spawn:")) return failure(suite, "suite-spawn", processResult.reason);
  if (processResult.reason != null || processResult.code !== 0 || processResult.signal != null) return failure(suite, "suite-process", `suite exited abnormally (code ${processResult.code}, signal ${processResult.signal}, reason ${processResult.reason})`);
  const stdout = Buffer.isBuffer(processResult.stdout) ? processResult.stdout.toString("utf8") : String(processResult.stdout ?? "");
  const lines = stdout.split("\n").filter((entry) => entry.startsWith(prefix));
  if (lines.length !== 1) return failure(suite, "suite-process", lines.length === 0 ? "suite exited without a protocol result" : "suite emitted multiple protocol results");
  let envelope;
  try { envelope = JSON.parse(lines[0].slice(prefix.length)); } catch { return failure(suite, "suite-process", "suite emitted malformed protocol JSON"); }
  if (envelope.ok === true) return validateResult(envelope.result, suite);
  return failure(suite, "suite-import", boundedText(`${envelope.phase ?? "run"}: ${envelope.message ?? "unknown suite error"}`));
}
